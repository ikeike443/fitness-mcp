import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { verifyBearerToken } from "@/lib/auth";
import {
  listWorkouts,
  getWorkoutCount,
  listWorkoutEvents,
  getWorkoutDetail,
  createWorkout,
  updateWorkout,
  getUserInfo,
  getBodyMeasurements,
  searchExerciseTemplates,
  createRoutine,
  updateRoutine,
  createRoutineFolder,
  listRoutineFolders,
  listRoutines,
  getRoutineDetail,
  toCreateRoutineBody,
  toUpdateRoutineBody,
  toCreateRoutineFolderBody,
  toCreateWorkoutBody,
  toUpdateWorkoutBody,
} from "@/lib/hevy";

export const maxDuration = 30;

// Shared schema fragments for the Hevy workout/routine-write tools below.
const setTypeSchema = z.enum(["warmup", "normal", "failure", "dropset"]);

const notesSchema = z
  .string()
  .refine((s) => !s.includes("@"), {
    message: 'Notes must not contain "@" — Hevy rejects it.',
  })
  .nullable()
  .optional();

const routineSetSchema = z.object({
  type: setTypeSchema.describe(
    "Set type — must be exactly one of warmup, normal, failure, dropset"
  ),
  weightKg: z.number().nullable().optional().describe("Weight in kg, or null/omit"),
  reps: z.number().int().nullable().optional().describe("Target reps, or null/omit"),
  distanceMeters: z
    .number()
    .nullable()
    .optional()
    .describe("Target distance in meters (cardio), or null/omit"),
  durationSeconds: z
    .number()
    .nullable()
    .optional()
    .describe("Target duration in seconds (timed sets), or null/omit"),
});

const routineExerciseSchema = z.object({
  exerciseTemplateId: z
    .string()
    .min(1)
    .describe(
      "Hevy exercise_template_id — obtain this by calling search_exercise_templates first. Never guess or invent this value."
    ),
  supersetId: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Superset group number linking this to other exercises, or null/omit"),
  restSeconds: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Rest time in seconds between sets, or null/omit"),
  notes: notesSchema.describe('Free-text notes for this exercise. Must not contain "@".'),
  sets: z.array(routineSetSchema).min(1).describe("Ordered list of sets for this exercise"),
});

const routineBodySchema = {
  title: z.string().min(1).describe("Routine title as it will appear in Hevy"),
  notes: notesSchema.describe('Routine-level notes. Must not contain "@".'),
  exercises: z
    .array(routineExerciseSchema)
    .min(1)
    .describe("Ordered list of exercises making up this routine"),
};

// Hevy's create-routine endpoint accepts folder_id; its update-routine
// endpoint has no such field at all — a routine's folder can only be set at
// creation, and Hevy 400s if folder_id is sent on an update, even as null
// (see lib/hevy.ts UpdateRoutineInput for details). So folderId is only
// part of create_routine's schema, not update_routine's.
const folderIdSchema = z
  .number()
  .int()
  .nullable()
  .optional()
  .describe(
    "Routine folder ID to file this under, or null/omit for none — call list_routine_folders first to find an existing folder by title, or create_routine_folder to make a new one"
  );

// Workout sets are recorded/performed sets, not routine templates, so they
// carry two fields routine sets don't: rpe (perceived exertion of a set
// that already happened) and customMetric (steps/floors for machine-based
// cardio exercises).
const rpeSchema = z
  .union([
    z.literal(6),
    z.literal(7),
    z.literal(7.5),
    z.literal(8),
    z.literal(8.5),
    z.literal(9),
    z.literal(9.5),
    z.literal(10),
  ])
  .nullable()
  .optional()
  .describe(
    "Rating of Perceived Exertion for this set, or null/omit — must be exactly one of 6, 7, 7.5, 8, 8.5, 9, 9.5, 10"
  );

const workoutSetSchema = z.object({
  type: setTypeSchema.describe(
    "Set type — must be exactly one of warmup, normal, failure, dropset"
  ),
  weightKg: z.number().nullable().optional().describe("Weight lifted in kg, or null/omit"),
  reps: z.number().int().nullable().optional().describe("Reps performed, or null/omit"),
  distanceMeters: z
    .number()
    .nullable()
    .optional()
    .describe("Distance covered in meters (cardio), or null/omit"),
  durationSeconds: z
    .number()
    .nullable()
    .optional()
    .describe("Duration in seconds (timed sets), or null/omit"),
  customMetric: z
    .number()
    .nullable()
    .optional()
    .describe(
      "Custom metric value — currently only used by Hevy for steps/floors on stair-machine-style exercises, or null/omit"
    ),
  rpe: rpeSchema,
});

const workoutExerciseSchema = z.object({
  exerciseTemplateId: z
    .string()
    .min(1)
    .describe(
      "Hevy exercise_template_id — obtain this by calling search_exercise_templates first. Never guess or invent this value."
    ),
  supersetId: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Superset group number linking this to other exercises, or null/omit"),
  notes: notesSchema.describe('Free-text notes for this exercise. Must not contain "@".'),
  sets: z.array(workoutSetSchema).min(1).describe("Ordered list of sets actually performed for this exercise"),
});

const workoutBodySchema = {
  title: z.string().min(1).describe("Workout title as it will appear in Hevy"),
  description: notesSchema.describe('Workout-level description/notes. Must not contain "@".'),
  startTime: z
    .string()
    .min(1)
    .describe("ISO 8601 timestamp of when the workout started, e.g. 2026-08-17T09:00:00Z"),
  endTime: z.string().min(1).describe("ISO 8601 timestamp of when the workout ended"),
  isPrivate: z
    .boolean()
    .optional()
    .describe(
      "Whether this workout is private. Hevy documents no default for this field, so fitness-mcp defaults it to false (visible per Hevy's normal sharing rules) when omitted — set explicitly if privacy matters."
    ),
  exercises: z
    .array(workoutExerciseSchema)
    .min(1)
    .describe("Ordered list of exercises actually performed in this workout, in order"),
};

// Every write tool takes this same confirm flag, defaulting to false/dry-run
// so the tool is safe to call speculatively while drafting content with the
// user: confirm: false (or omitted) never touches Hevy — it only returns the
// exact payload that *would* be sent, for the caller to show the user and
// get explicit go-ahead on before calling again with confirm: true. This is
// a belt-and-suspenders complement to the tool descriptions instructing the
// calling LLM to confirm with the user first — since that instruction and
// this flag are both ultimately under the same LLM's control, dry-run-by-
// default is the part that actually prevents an accidental real write.
const confirmSchema = z
  .boolean()
  .optional()
  .describe(
    'Set to true only after showing the user the full planned content (exercises, sets, reps, weights) in chat and getting their explicit go-ahead. Defaults to false: when false or omitted, nothing is written to Hevy — the tool instead returns the exact payload it would have sent, under a "dryRun": true wrapper, so you can show it to the user before asking them to approve. Never set this to true speculatively or as an intermediate step.'
  );

// Shared shape for every write tool's dry-run response (confirm: false/
// omitted) — wraps the real outgoing Hevy payload (built by the same
// functions the live write path uses, so validation runs identically) with
// a flag and instructions the calling LLM can act on directly.
function dryRunPreview(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            dryRun: true,
            message:
              "Nothing was written to Hevy. This is the exact payload that would be sent — show it to the user and call this tool again with confirm: true only after they explicitly approve it.",
            payload,
          },
          null,
          2
        ),
      },
    ],
  };
}

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "list_workouts",
      {
        title: "List Hevy workouts",
        description:
          "List the user's logged workouts from Hevy, newest first, with real pagination. Each entry includes title, the routine it was logged from (if any), start/end time, and exercise names. Call get_workout_count first if you need to know how many pages of history exist.",
        inputSchema: z.object({
          page: z.number().int().min(1).optional().describe("Page number, 1-based (default 1)"),
          pageSize: z
            .number()
            .int()
            .min(1)
            .max(10)
            .optional()
            .describe("How many workouts per page (max 10, default 5)"),
        }),
      },
      async ({ page, pageSize }) => {
        const result = await listWorkouts({ page, pageSize });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    server.registerTool(
      "get_workout_count",
      {
        title: "Get total Hevy workout count",
        description:
          "Get the total number of workouts logged on the user's Hevy account. Useful for deciding how many pages list_workouts has to walk to reach older history.",
        inputSchema: z.object({}),
      },
      async () => {
        const result = await getWorkoutCount();
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    server.registerTool(
      "list_workout_events",
      {
        title: "List Hevy workout change events",
        description:
          "List workout update/delete events since a given timestamp, newest first — for tracking what changed without re-fetching and diffing every workout yourself. 'updated' events include a workout summary (call get_workout_detail with its id for full exercise/set detail); 'deleted' events include only the id and when it was deleted.",
        inputSchema: z.object({
          since: z
            .string()
            .optional()
            .describe(
              "ISO 8601 timestamp — only return events after this time (default: everything, i.e. 1970-01-01T00:00:00Z)"
            ),
          page: z.number().int().min(1).optional().describe("Page number, 1-based (default 1)"),
          pageSize: z
            .number()
            .int()
            .min(1)
            .max(10)
            .optional()
            .describe("How many events per page (max 10, default 5)"),
        }),
      },
      async ({ since, page, pageSize }) => {
        const result = await listWorkoutEvents({ since, page, pageSize });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    server.registerTool(
      "get_workout_detail",
      {
        title: "Get Hevy workout detail",
        description:
          "Get full exercise/set/rep/weight/RPE detail for a single Hevy workout by its ID (obtain the ID from list_workouts or list_workout_events).",
        inputSchema: z.object({
          workoutId: z.string().min(1).describe("The Hevy workout ID"),
        }),
      },
      async ({ workoutId }) => {
        const workout = await getWorkoutDetail(workoutId);
        return {
          content: [
            { type: "text", text: JSON.stringify(workout, null, 2) },
          ],
        };
      }
    );

    server.registerTool(
      "create_workout",
      {
        title: "Log a new Hevy workout",
        description:
          "Log a completed workout — a real training session with actual start/end times, sets, reps, and weights performed — to the user's Hevy account. This logs a record of what was done, not a reusable plan; use create_routine/update_routine instead if the goal is a template to follow later. Without confirm: true this is a no-op dry run that only returns the payload that would be sent — with confirm: true IT IS A REAL WRITE. Show the user the full planned content and get explicit confirmation before setting confirm: true. Every exerciseTemplateId must come from a prior search_exercise_templates call; never guess one.",
        inputSchema: z.object({
          ...workoutBodySchema,
          confirm: confirmSchema,
        }),
      },
      async ({ title, description, startTime, endTime, isPrivate, exercises, confirm }) => {
        const input = { title, description, startTime, endTime, isPrivate, exercises };
        if (!confirm) {
          return dryRunPreview(toCreateWorkoutBody(input));
        }
        const workout = await createWorkout(input);
        return {
          content: [{ type: "text", text: JSON.stringify(workout, null, 2) }],
        };
      }
    );

    server.registerTool(
      "update_workout",
      {
        title: "Update a Hevy workout",
        description:
          "Replace an existing logged Hevy workout's title/description/times/exercises entirely (full overwrite, not a partial patch — omitted exercises are removed). Without confirm: true this is a no-op dry run that only returns the payload that would be sent — with confirm: true IT IS A REAL WRITE. Show the user the complete new content and get explicit confirmation before setting confirm: true. Call get_workout_detail first if you don't already know the workout's exact current contents.",
        inputSchema: z.object({
          workoutId: z
            .string()
            .min(1)
            .describe(
              "The Hevy workout ID to overwrite (from list_workouts/list_workout_events, or supplied by the user)"
            ),
          ...workoutBodySchema,
          confirm: confirmSchema,
        }),
      },
      async ({ workoutId, title, description, startTime, endTime, isPrivate, exercises, confirm }) => {
        const input = { title, description, startTime, endTime, isPrivate, exercises };
        if (!confirm) {
          return dryRunPreview(toUpdateWorkoutBody(input));
        }
        const workout = await updateWorkout(workoutId, input);
        return {
          content: [{ type: "text", text: JSON.stringify(workout, null, 2) }],
        };
      }
    );

    server.registerTool(
      "get_user_info",
      {
        title: "Get the authenticated Hevy user's info",
        description:
          "Get basic info (id, display name, public profile URL) for the Hevy account this server's HEVY_API_KEY belongs to.",
        inputSchema: z.object({}),
      },
      async () => {
        const info = await getUserInfo();
        return {
          content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
        };
      }
    );

    server.registerTool(
      "get_body_measurements",
      {
        title: "Get Hevy body measurements",
        description:
          "List the user's most recent body measurements (weight, body fat %, etc.) logged in Hevy.",
        inputSchema: z.object({
          limit: z
            .number()
            .int()
            .min(1)
            .max(10)
            .optional()
            .describe(
              "How many recent measurements to return (max 10, default 10)"
            ),
        }),
      },
      async ({ limit }) => {
        const measurements = await getBodyMeasurements(limit ?? 10);
        return {
          content: [
            { type: "text", text: JSON.stringify(measurements, null, 2) },
          ],
        };
      }
    );

    server.registerTool(
      "search_exercise_templates",
      {
        title: "Search Hevy exercise templates",
        description:
          "Search Hevy's exercise library by name to find the exact exercise_template_id required by create_routine/update_routine. Returns candidate exercises (id, title, muscle group) — never auto-pick or invent an ID from this list; if there are multiple plausible matches, ask the user to confirm which one before using it.",
        inputSchema: z.object({
          query: z
            .string()
            .min(1)
            .describe(
              'Exercise name or partial name, matched against Hevy\'s English titles — translate non-English names first (e.g. "ベンチプレス" → "bench press").'
            ),
          limit: z
            .number()
            .int()
            .min(1)
            .max(25)
            .optional()
            .describe("Max candidates to return (default 10, max 25)"),
        }),
      },
      async ({ query, limit }) => {
        const results = await searchExerciseTemplates(query, limit ?? 10);
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
      }
    );

    server.registerTool(
      "list_routines",
      {
        title: "List Hevy routines",
        description:
          "List the user's existing Hevy routines (workout plan templates) — id, title, folder, exercise count, last updated. Use this to find a routineId for get_routine_detail/update_routine when the user doesn't already know it. Walks all pages, so the result is always complete.",
        inputSchema: z.object({
          folderId: z
            .number()
            .int()
            .nullable()
            .optional()
            .describe(
              "Filter to routines in this folder ID (from list_routine_folders). Pass null explicitly to list only routines not filed in any folder. Omit entirely to list every routine regardless of folder."
            ),
        }),
      },
      async ({ folderId }) => {
        const routines = await listRoutines(folderId);
        return {
          content: [{ type: "text", text: JSON.stringify(routines, null, 2) }],
        };
      }
    );

    server.registerTool(
      "get_routine_detail",
      {
        title: "Get Hevy routine detail",
        description:
          "Get full exercise/set/rep(-range)/weight/rest-time detail for a single Hevy routine (template) by its ID (obtain the ID from list_routines or list_routine_folders + list_routines). Read-only. Call this before update_routine whenever you don't already know the routine's exact current contents — e.g. after the user edited it manually in the Hevy app — since update_routine replaces the whole routine and would silently discard anything you're not already aware of.",
        inputSchema: z.object({
          routineId: z.string().min(1).describe("The Hevy routine ID"),
        }),
      },
      async ({ routineId }) => {
        const routine = await getRoutineDetail(routineId);
        return {
          content: [{ type: "text", text: JSON.stringify(routine, null, 2) }],
        };
      }
    );

    server.registerTool(
      "create_routine",
      {
        title: "Create a Hevy routine",
        description:
          "Create a new workout routine (template) in the user's Hevy account. Without confirm: true this is a no-op dry run that only returns the payload that would be sent (see confirm below) — with confirm: true it IS A REAL WRITE to the user's Hevy data. Before setting confirm: true, show the user the full planned routine (title, exercises, sets, reps, weights) in chat and get their explicit go-ahead. Every exerciseTemplateId must come from a prior search_exercise_templates call; never guess one. Calling this tool twice with the same routine creates two separate duplicate routines (no automatic dedup) — if you're revising a routine created earlier in this conversation, call update_routine with its id instead of creating a new one.",
        inputSchema: z.object({
          ...routineBodySchema,
          folderId: folderIdSchema,
          confirm: confirmSchema,
        }),
      },
      async ({ title, folderId, notes, exercises, confirm }) => {
        if (!confirm) {
          return dryRunPreview(toCreateRoutineBody({ title, folderId, notes, exercises }));
        }
        const routine = await createRoutine({ title, folderId, notes, exercises });
        return {
          content: [{ type: "text", text: JSON.stringify(routine, null, 2) }],
        };
      }
    );

    server.registerTool(
      "update_routine",
      {
        title: "Update a Hevy routine",
        description:
          "Replace an existing Hevy routine's title/notes/exercises entirely (full overwrite, not a partial patch — omitted exercises are removed). Without confirm: true this is a no-op dry run that only returns the payload that would be sent — with confirm: true IT IS A REAL WRITE. Show the user the complete new routine content and get explicit confirmation before setting confirm: true. Prefer this over create_routine whenever you're revising a routine that already exists, to avoid accumulating duplicates. Note: Hevy's update endpoint cannot change which folder a routine is filed under — folder assignment is set only at creation (create_routine's folderId); to move an existing routine to a different folder, recreate it there.",
        inputSchema: z.object({
          routineId: z
            .string()
            .min(1)
            .describe(
              "The Hevy routine ID to overwrite (from a prior create_routine result, or supplied by the user)"
            ),
          ...routineBodySchema,
          confirm: confirmSchema,
        }),
      },
      async ({ routineId, title, notes, exercises, confirm }) => {
        if (!confirm) {
          return dryRunPreview(toUpdateRoutineBody({ title, notes, exercises }));
        }
        const routine = await updateRoutine(routineId, { title, notes, exercises });
        return {
          content: [{ type: "text", text: JSON.stringify(routine, null, 2) }],
        };
      }
    );

    server.registerTool(
      "list_routine_folders",
      {
        title: "List Hevy routine folders",
        description:
          "List all existing routine folders in the user's Hevy account (id, title, display index). Call this before create_routine when the user names a folder by title (e.g. \"put it in my 'Push Pull Legs' folder\") so you can resolve the folderId yourself instead of asking the user for it. If no folder title matches, confirm with the user before falling back to create_routine_folder.",
        inputSchema: z.object({}),
      },
      async () => {
        const folders = await listRoutineFolders();
        return {
          content: [{ type: "text", text: JSON.stringify(folders, null, 2) }],
        };
      }
    );

    server.registerTool(
      "create_routine_folder",
      {
        title: "Create a Hevy routine folder",
        description:
          "Create a new folder in the user's Hevy account to organize routines (e.g. by program or training day). Without confirm: true this is a no-op dry run that only returns the payload that would be sent — with confirm: true IT IS A REAL WRITE. Confirm the folder name with the user before setting confirm: true. Returns the folder's id, which can be passed as folderId to create_routine (update_routine has no folderId — Hevy cannot change a routine's folder after creation). Call list_routine_folders first to check whether a suitable folder already exists.",
        inputSchema: z.object({
          title: z.string().min(1).describe("Folder name as it will appear in Hevy"),
          confirm: confirmSchema,
        }),
      },
      async ({ title, confirm }) => {
        if (!confirm) {
          return dryRunPreview(toCreateRoutineFolderBody(title));
        }
        const folder = await createRoutineFolder(title);
        return {
          content: [{ type: "text", text: JSON.stringify(folder, null, 2) }],
        };
      }
    );
  },
  {
    serverInfo: { name: "fitness-mcp", version: "0.1.0" },
  }
);

const authedHandler = withMcpAuth(handler, verifyBearerToken, {
  required: true,
});

export { authedHandler as GET, authedHandler as POST };
