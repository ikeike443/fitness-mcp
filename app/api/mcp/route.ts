import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { verifyBearerToken } from "@/lib/auth";
import {
  listRecentWorkouts,
  getWorkoutDetail,
  getBodyMeasurements,
  searchExerciseTemplates,
  createRoutine,
  updateRoutine,
  createRoutineFolder,
} from "@/lib/hevy";
import {
  getDailyMacros,
  getWeightTrend,
  getNutritionTrends,
} from "@/lib/macrofactorStore";

export const maxDuration = 30;

// Shared schema fragments for the Hevy routine-write tools below.
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
  folderId: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe(
      "Routine folder ID to file this under, or null/omit for none — see create_routine_folder"
    ),
  notes: notesSchema.describe('Routine-level notes. Must not contain "@".'),
  exercises: z
    .array(routineExerciseSchema)
    .min(1)
    .describe("Ordered list of exercises making up this routine"),
};

const confirmSchema = z
  .literal(true)
  .describe(
    "Set to true only after showing the user the full planned content (exercises, sets, reps, weights) in chat and getting their explicit go-ahead. Do not call this tool speculatively or before that confirmation."
  );

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "get_recent_workouts",
      {
        title: "Get recent Hevy workouts",
        description:
          "List the user's most recent workouts from Hevy, newest first. Each entry includes title, start/end time, and exercise names.",
        inputSchema: z.object({
          limit: z
            .number()
            .int()
            .min(1)
            .max(10)
            .optional()
            .describe(
              "How many recent workouts to return (max 10, default 5)"
            ),
        }),
      },
      async ({ limit }) => {
        const workouts = await listRecentWorkouts(limit ?? 5);
        return {
          content: [
            { type: "text", text: JSON.stringify(workouts, null, 2) },
          ],
        };
      }
    );

    server.registerTool(
      "get_workout_detail",
      {
        title: "Get Hevy workout detail",
        description:
          "Get full exercise/set/rep/weight detail for a single Hevy workout by its ID (obtain the ID from get_recent_workouts).",
        inputSchema: z.object({
          workoutId: z.string().describe("The Hevy workout ID"),
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
      "get_daily_macros",
      {
        title: "Get daily MacroFactor calories and macros",
        description:
          "Get daily calories, protein, carbs, fat, and step count from MacroFactor for a date range or the last N days. Automatically pulls in any newly exported MacroFactor data from Google Drive first, so it reflects the most recent manual export.",
        inputSchema: z.object({
          days: z
            .number()
            .int()
            .min(1)
            .max(90)
            .optional()
            .describe(
              "Number of most recent days to return (default 14, max 90). Ignored if startDate is given."
            ),
          startDate: z
            .string()
            .optional()
            .describe("Start date YYYY-MM-DD (inclusive)"),
          endDate: z
            .string()
            .optional()
            .describe("End date YYYY-MM-DD (inclusive), default today"),
        }),
      },
      async ({ days, startDate, endDate }) => {
        const macros = await getDailyMacros({ days, startDate, endDate });
        return {
          content: [{ type: "text", text: JSON.stringify(macros, null, 2) }],
        };
      }
    );

    server.registerTool(
      "get_weight_trend",
      {
        title: "Get MacroFactor weight trend",
        description:
          "Get daily body weight, MacroFactor's smoothed weight trend, and body fat % over a date range or the last N days. Automatically pulls in any newly exported MacroFactor data first.",
        inputSchema: z.object({
          days: z
            .number()
            .int()
            .min(1)
            .max(180)
            .optional()
            .describe(
              "Number of most recent days to return (default 30, max 180). Ignored if startDate is given."
            ),
          startDate: z
            .string()
            .optional()
            .describe("Start date YYYY-MM-DD (inclusive)"),
          endDate: z
            .string()
            .optional()
            .describe("End date YYYY-MM-DD (inclusive), default today"),
        }),
      },
      async ({ days, startDate, endDate }) => {
        const trend = await getWeightTrend({ days, startDate, endDate });
        return {
          content: [{ type: "text", text: JSON.stringify(trend, null, 2) }],
        };
      }
    );

    server.registerTool(
      "get_nutrition_trends",
      {
        title: "Get precomputed MacroFactor monthly/yearly trends",
        description:
          "Get precomputed average calories/macros/steps and weight change for a whole month or year. Cheap: reads a precomputed summary instead of rescanning all daily data.",
        inputSchema: z.object({
          period: z
            .enum(["month", "year"])
            .describe("Aggregation period"),
          key: z
            .string()
            .optional()
            .describe(
              "'YYYY-MM' for month or 'YYYY' for year; defaults to the current month/year"
            ),
        }),
      },
      async ({ period, key }) => {
        const trends = await getNutritionTrends({ period, key });
        return {
          content: [{ type: "text", text: JSON.stringify(trends, null, 2) }],
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
      "create_routine",
      {
        title: "Create a Hevy routine",
        description:
          "Create a new workout routine (template) in the user's Hevy account. THIS IS A REAL WRITE to the user's Hevy data. Before calling this tool, show the user the full planned routine (title, exercises, sets, reps, weights) in chat and get their explicit go-ahead — do not call it speculatively or as an intermediate step. Every exerciseTemplateId must come from a prior search_exercise_templates call; never guess one. Calling this tool twice with the same routine creates two separate duplicate routines (no automatic dedup) — if you're revising a routine created earlier in this conversation, call update_routine with its id instead of creating a new one.",
        inputSchema: z.object({
          ...routineBodySchema,
          confirm: confirmSchema,
        }),
      },
      async ({ title, folderId, notes, exercises }) => {
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
          "Replace an existing Hevy routine's title/notes/exercises entirely (full overwrite, not a partial patch — omitted exercises are removed). THIS IS A REAL WRITE. Show the user the complete new routine content and get explicit confirmation before calling. Prefer this over create_routine whenever you're revising a routine that already exists, to avoid accumulating duplicates.",
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
      async ({ routineId, title, folderId, notes, exercises }) => {
        const routine = await updateRoutine(routineId, { title, folderId, notes, exercises });
        return {
          content: [{ type: "text", text: JSON.stringify(routine, null, 2) }],
        };
      }
    );

    server.registerTool(
      "create_routine_folder",
      {
        title: "Create a Hevy routine folder",
        description:
          "Create a new folder in the user's Hevy account to organize routines (e.g. by program or training day). THIS IS A REAL WRITE. Confirm the folder name with the user before calling. Returns the folder's id, which can be passed as folderId to create_routine/update_routine.",
        inputSchema: z.object({
          title: z.string().min(1).describe("Folder name as it will appear in Hevy"),
          confirm: confirmSchema,
        }),
      },
      async ({ title }) => {
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
