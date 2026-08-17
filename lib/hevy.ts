const HEVY_API_BASE = "https://api.hevyapp.com";

function apiKey(): string {
  const key = process.env.HEVY_API_KEY;
  if (!key) throw new Error("HEVY_API_KEY is not set");
  return key;
}

interface HevyFetchOptions {
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
}

async function hevyFetch<T>(
  path: string,
  options: HevyFetchOptions = {}
): Promise<T> {
  const { method = "GET", body } = options;
  const res = await fetch(`${HEVY_API_BASE}${path}`, {
    method,
    headers: {
      "api-key": apiKey(),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    throw new Error(`Hevy API error ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

// --- Shared write-validation helpers -------------------------------------
//
// Both the workout and routine write endpoints below are real write
// operations with side effects in the user's account, and Hevy's API is
// reportedly strict about malformed fields. Validation here is
// intentionally defense-in-depth on top of the zod schemas in
// app/api/mcp/route.ts: it protects any direct caller of this module
// (including tests) even if the MCP-layer schema is bypassed.

const VALID_SET_TYPES = new Set(["warmup", "normal", "failure", "dropset"]);
const VALID_RPE_VALUES = new Set([6, 7, 7.5, 8, 8.5, 9, 9.5, 10]);

function assertValidNotes(notes: string | null | undefined): void {
  if (typeof notes === "string" && notes.includes("@")) {
    throw new Error(
      `Invalid notes: must not contain "@" (Hevy rejects this) — got: ${JSON.stringify(
        notes
      )}`
    );
  }
}

function assertValidSetType(type: string): void {
  if (!VALID_SET_TYPES.has(type)) {
    throw new Error(
      `Invalid set type "${type}": must be one of ${[...VALID_SET_TYPES].join(", ")}`
    );
  }
}

// RPE is only meaningful on workout sets (Hevy's routine-write schema has no
// rpe field at all — routines are templates with target reps/weight, not a
// recorded exertion), so only toCreateWorkoutBody/toUpdateWorkoutBody call
// this, unlike assertValidNotes/assertValidSetType above.
function assertValidRpe(rpe: number | null | undefined): void {
  if (rpe != null && !VALID_RPE_VALUES.has(rpe)) {
    throw new Error(
      `Invalid rpe ${rpe}: must be one of ${[...VALID_RPE_VALUES].join(", ")}, or null/omit`
    );
  }
}

interface HevySet {
  index: number;
  type: string;
  weight_kg: number | null;
  reps: number | null;
  distance_meters: number | null;
  duration_seconds: number | null;
  rpe: number | null;
  custom_metric: number | null;
}

interface HevyExercise {
  index: number;
  title: string;
  notes: string | null;
  exercise_template_id: string;
  // Hevy's read schema for a workout's exercises spells this "supersets_id"
  // (matching the routine read-side quirk documented on
  // HevyRoutineExercise below) — unlike the write schema
  // (PostWorkoutsRequestExercise), which uses "superset_id".
  supersets_id: number | null;
  sets: HevySet[];
}

interface HevyWorkout {
  id: string;
  title: string;
  // Present when this workout was logged from a routine; absent/undefined
  // otherwise. Not nullable in the spec (no example of an explicit null),
  // so this is typed as optional rather than `| null`.
  routine_id?: string;
  description: string | null;
  start_time: string;
  end_time: string;
  updated_at: string;
  created_at: string;
  exercises: HevyExercise[];
}

interface HevyWorkoutsResponse {
  page: number;
  page_count: number;
  workouts: HevyWorkout[];
}

interface HevyWorkoutCountResponse {
  workout_count: number;
}

// GET /v1/workouts/events returns a stream of update/delete events so a
// client can keep a local cache in sync without re-fetching every workout —
// see listWorkoutEvents below.
interface HevyUpdatedWorkoutEvent {
  type: "updated";
  workout: HevyWorkout;
}

interface HevyDeletedWorkoutEvent {
  type: "deleted";
  id: string;
  deleted_at: string;
}

type HevyWorkoutEvent = HevyUpdatedWorkoutEvent | HevyDeletedWorkoutEvent;

interface HevyWorkoutEventsResponse {
  page: number;
  page_count: number;
  events: HevyWorkoutEvent[];
}

interface HevyBodyMeasurement {
  date: string;
  weight_kg: number | null;
  fat_percent: number | null;
  [key: string]: unknown;
}

interface HevyBodyMeasurementsResponse {
  page: number;
  page_count: number;
  body_measurements: HevyBodyMeasurement[];
}

function summarizeWorkout(w: HevyWorkout) {
  return {
    id: w.id,
    title: w.title,
    routineId: w.routine_id ?? null,
    startTime: w.start_time,
    endTime: w.end_time,
    exerciseCount: w.exercises.length,
    exercises: w.exercises.map((e) => e.title),
  };
}

const WORKOUT_PAGE_SIZE_MAX = 10;

// Unlike listRoutines/listRoutineFolders/searchExerciseTemplates above (all
// of which walk every page internally, since a caller needs the complete
// set to filter/search across), workout history can be arbitrarily long, so
// pagination is exposed to the caller directly instead of walked — the
// point of list_workouts is browsing recent history a page at a time, not
// materializing the whole account.
export async function listWorkouts(opts: { page?: number; pageSize?: number } = {}) {
  const page = Math.max(opts.page ?? 1, 1);
  const pageSize = Math.min(Math.max(opts.pageSize ?? 5, 1), WORKOUT_PAGE_SIZE_MAX);
  const data = await hevyFetch<HevyWorkoutsResponse>(
    `/v1/workouts?page=${page}&pageSize=${pageSize}`
  );
  return {
    page: data.page,
    pageCount: data.page_count,
    workouts: data.workouts.map(summarizeWorkout),
  };
}

export async function getWorkoutCount() {
  const data = await hevyFetch<HevyWorkoutCountResponse>("/v1/workouts/count");
  return { count: data.workout_count };
}

function summarizeWorkoutEvent(e: HevyWorkoutEvent) {
  if (e.type === "deleted") {
    return { type: "deleted" as const, id: e.id, deletedAt: e.deleted_at };
  }
  return { type: "updated" as const, workout: summarizeWorkout(e.workout) };
}

export async function listWorkoutEvents(
  opts: { since?: string; page?: number; pageSize?: number } = {}
) {
  const page = Math.max(opts.page ?? 1, 1);
  const pageSize = Math.min(Math.max(opts.pageSize ?? 5, 1), WORKOUT_PAGE_SIZE_MAX);
  const since = opts.since ?? "1970-01-01T00:00:00Z";
  const data = await hevyFetch<HevyWorkoutEventsResponse>(
    `/v1/workouts/events?page=${page}&pageSize=${pageSize}&since=${encodeURIComponent(since)}`
  );
  return {
    page: data.page,
    pageCount: data.page_count,
    events: data.events.map(summarizeWorkoutEvent),
  };
}

function toWorkoutDetailOutput(w: HevyWorkout) {
  return {
    id: w.id,
    title: w.title,
    routineId: w.routine_id ?? null,
    description: w.description,
    startTime: w.start_time,
    endTime: w.end_time,
    exercises: w.exercises.map((e) => ({
      exerciseTemplateId: e.exercise_template_id,
      title: e.title,
      notes: e.notes,
      supersetId: e.supersets_id ?? null,
      sets: e.sets.map((s) => ({
        type: s.type,
        weightKg: s.weight_kg,
        reps: s.reps,
        distanceMeters: s.distance_meters,
        durationSeconds: s.duration_seconds,
        rpe: s.rpe,
        customMetric: s.custom_metric,
      })),
    })),
  };
}

export async function getWorkoutDetail(workoutId: string) {
  const w = await hevyFetch<HevyWorkout>(`/v1/workouts/${encodeURIComponent(workoutId)}`);
  return toWorkoutDetailOutput(w);
}

// --- Workout write support ------------------------------------------------
//
// Unlike routines (see "Routine write support" below), Hevy's own OpenAPI
// spec documents POST/PUT /v1/workouts as returning a bare Workout object,
// not wrapped under a "workout" key or array like routines are (see
// unwrapRoutineResponse's comment for the routine equivalent, discovered
// only through real-account testing since the spec didn't document it
// either). No such bug report exists yet for workouts, so this trusts the
// spec — but that trust is unverified against a real account, and routines
// are a concrete example of Hevy's spec not matching real behavior. If a
// real create_workout/update_workout call ever throws the "unexpected
// shape" error below, that's the first place to look.

export interface WorkoutSetInput {
  type: "warmup" | "normal" | "failure" | "dropset";
  weightKg?: number | null;
  reps?: number | null;
  distanceMeters?: number | null;
  durationSeconds?: number | null;
  // Only meaningful for workouts (recorded sets), not routines (templates)
  // — see assertValidRpe's comment.
  rpe?: number | null;
  customMetric?: number | null;
}

export interface WorkoutExerciseInput {
  exerciseTemplateId: string;
  supersetId?: number | null;
  notes?: string | null;
  sets: WorkoutSetInput[];
}

export interface CreateWorkoutInput {
  title: string;
  description?: string | null;
  startTime: string;
  endTime: string;
  // Hevy's spec gives no documented default for is_private, so fitness-mcp
  // picks one explicitly (false) rather than omitting the field and letting
  // Hevy decide — see the isPrivate schema description in
  // app/api/mcp/route.ts, which surfaces this as our own choice, not a
  // documented Hevy default.
  isPrivate?: boolean;
  exercises: WorkoutExerciseInput[];
}

// PUT /v1/workouts/{id} accepts the exact same body shape as POST
// /v1/workouts (both $ref the same PostWorkoutsRequestBody schema) — unlike
// routines, where update has no folder_id field. So workouts have no
// separate Update*Input type.
export type UpdateWorkoutInput = CreateWorkoutInput;

function buildWorkoutFields(input: CreateWorkoutInput) {
  assertValidNotes(input.description ?? null);
  return {
    title: input.title,
    description: input.description ?? null,
    start_time: input.startTime,
    end_time: input.endTime,
    is_private: input.isPrivate ?? false,
    exercises: input.exercises.map((e) => {
      assertValidNotes(e.notes ?? null);
      return {
        exercise_template_id: e.exerciseTemplateId,
        superset_id: e.supersetId ?? null,
        notes: e.notes ?? null,
        sets: e.sets.map((s) => {
          assertValidSetType(s.type);
          assertValidRpe(s.rpe ?? null);
          return {
            type: s.type,
            weight_kg: s.weightKg ?? null,
            reps: s.reps ?? null,
            distance_meters: s.distanceMeters ?? null,
            duration_seconds: s.durationSeconds ?? null,
            rpe: s.rpe ?? null,
            custom_metric: s.customMetric ?? null,
          };
        }),
      };
    }),
  };
}

// Exported for the same dry-run-preview reason as toCreateRoutineBody /
// toUpdateRoutineBody / toCreateRoutineFolderBody above.
export function toCreateWorkoutBody(input: CreateWorkoutInput) {
  return { workout: buildWorkoutFields(input) };
}

export function toUpdateWorkoutBody(input: UpdateWorkoutInput) {
  return { workout: buildWorkoutFields(input) };
}

function toWorkoutOutput(w: HevyWorkout) {
  return {
    id: w.id,
    title: w.title,
    routineId: w.routine_id ?? null,
    startTime: w.start_time,
    endTime: w.end_time,
    exerciseCount: w.exercises.length,
  };
}

function assertWorkoutShape(data: unknown): HevyWorkout {
  const w = data as Partial<HevyWorkout> | null;
  if (!w || typeof w !== "object" || typeof w.id !== "string" || !Array.isArray(w.exercises)) {
    throw new Error(
      `Unexpected Hevy workout response shape (expected a bare Workout object per the OpenAPI spec — see the comment at the top of this Workout write support section if Hevy actually wraps this the way it wraps routines): ${JSON.stringify(
        data
      )}`
    );
  }
  return w as HevyWorkout;
}

export async function createWorkout(input: CreateWorkoutInput) {
  const data = await hevyFetch<unknown>("/v1/workouts", {
    method: "POST",
    body: toCreateWorkoutBody(input),
  });
  return toWorkoutOutput(assertWorkoutShape(data));
}

export async function updateWorkout(workoutId: string, input: UpdateWorkoutInput) {
  const data = await hevyFetch<unknown>(
    `/v1/workouts/${encodeURIComponent(workoutId)}`,
    {
      method: "PUT",
      body: toUpdateWorkoutBody(input),
    }
  );
  return toWorkoutOutput(assertWorkoutShape(data));
}

export async function getBodyMeasurements(limit = 10) {
  const pageSize = Math.min(Math.max(limit, 1), 10);
  const data = await hevyFetch<HevyBodyMeasurementsResponse>(
    `/v1/body_measurements?page=1&pageSize=${pageSize}`
  );
  return data.body_measurements.map((m) => ({
    date: m.date,
    weightKg: m.weight_kg,
    fatPercent: m.fat_percent,
  }));
}

// --- User info ------------------------------------------------------------

interface HevyUserInfo {
  id: string;
  name: string;
  url: string;
}

interface HevyUserInfoResponse {
  data: HevyUserInfo;
}

export async function getUserInfo() {
  const data = await hevyFetch<HevyUserInfoResponse>("/v1/user/info");
  return { id: data.data.id, name: data.data.name, profileUrl: data.data.url };
}

// --- Routine write support ---------------------------------------------

interface HevyExerciseTemplate {
  id: string;
  title: string;
  type: string;
  primary_muscle_group: string;
  secondary_muscle_groups: string[];
  is_custom: boolean;
}

interface HevyExerciseTemplatesResponse {
  page: number;
  page_count: number;
  exercise_templates: HevyExerciseTemplate[];
}

interface HevyRoutineSet {
  type: string;
  weight_kg: number | null;
  reps: number | null;
  // Templates commonly target a range ("8-12 reps") rather than a fixed
  // rep count — reps alone is null in that case, so get_routine_detail
  // must surface this or it would silently look empty for most templates.
  rep_range?: { start: number | null; end: number | null } | null;
  distance_meters: number | null;
  duration_seconds: number | null;
}

interface HevyRoutineExercise {
  exercise_template_id: string;
  // Present on read responses (GET /v1/routines[/{id}]) so the exercise can
  // be displayed without a round-trip to search_exercise_templates; not
  // sent on writes (buildRoutineFields below never includes it).
  title?: string;
  // Hevy's write schema (POST/PUT, confirmed against a real account) uses
  // "superset_id" — see buildRoutineFields. Third-party reverse-engineered
  // read schemas report the same field back as "supersets_id" on GET
  // responses, which would otherwise silently read as undefined here.
  // Unverified against a real read response; accepting both spellings is
  // cheap insurance either way.
  superset_id?: number | null;
  supersets_id?: number | null;
  rest_seconds: number | null;
  notes: string | null;
  sets: HevyRoutineSet[];
}

interface HevyRoutine {
  id: string;
  title: string;
  folder_id: number | null;
  notes: string | null;
  exercises: HevyRoutineExercise[];
  created_at: string;
  updated_at: string;
}

interface HevyRoutineFolder {
  id: number;
  title: string;
  index: number;
  created_at: string;
  updated_at: string;
}

export interface RoutineSetInput {
  type: "warmup" | "normal" | "failure" | "dropset";
  weightKg?: number | null;
  reps?: number | null;
  distanceMeters?: number | null;
  durationSeconds?: number | null;
}

export interface RoutineExerciseInput {
  exerciseTemplateId: string;
  supersetId?: number | null;
  restSeconds?: number | null;
  notes?: string | null;
  sets: RoutineSetInput[];
}

export interface CreateRoutineInput {
  title: string;
  folderId?: number | null;
  notes?: string | null;
  exercises: RoutineExerciseInput[];
}

// Hevy's PUT /v1/routines/{id} schema has no folder_id field at all — unlike
// POST /v1/routines, which requires one. Sending "folder_id" (even explicit
// null) on an update is rejected outright with
// `Unrecognized key(s) in object: 'folder_id'`, confirmed against a real
// Hevy account (see bug report: create_routine succeeds with folder_id:
// null, update_routine 400s on the exact same key). A routine's folder can
// only be set at creation time; there is no supported way to move an
// existing routine between folders via this endpoint. So UpdateRoutineInput
// intentionally has no folderId field — it is not a partial-input quirk,
// it reflects a real capability gap in Hevy's API.
export interface UpdateRoutineInput {
  title: string;
  notes?: string | null;
  exercises: RoutineExerciseInput[];
}

// Builds the routine.exercises/title/notes fields shared by create and
// update, by picking exactly the writable fields by name — never spreading
// caller input — so read-only fields (id, created_at, etc.) can never leak
// into a request body even if a caller passes extra properties via a
// loosely-typed object.
function buildRoutineFields(input: UpdateRoutineInput) {
  assertValidNotes(input.notes ?? null);
  return {
    title: input.title,
    notes: input.notes ?? null,
    exercises: input.exercises.map((e) => {
      assertValidNotes(e.notes ?? null);
      return {
        exercise_template_id: e.exerciseTemplateId,
        superset_id: e.supersetId ?? null,
        rest_seconds: e.restSeconds ?? null,
        notes: e.notes ?? null,
        sets: e.sets.map((s) => {
          assertValidSetType(s.type);
          return {
            type: s.type,
            weight_kg: s.weightKg ?? null,
            reps: s.reps ?? null,
            distance_meters: s.distanceMeters ?? null,
            duration_seconds: s.durationSeconds ?? null,
          };
        }),
      };
    }),
  };
}

// Exported (not just used internally by createRoutine/updateRoutine below) so
// the MCP layer can build and return the exact outgoing Hevy payload as a
// dry-run preview when a write tool is called with confirm: false/omitted —
// see the confirm-dry-run handling in app/api/mcp/route.ts. Reusing the real
// body-builder means the preview also runs the same validation
// (assertValidNotes/assertValidSetType via buildRoutineFields) that a real
// write would, so a dry-run call surfaces payload problems before anything
// is actually sent to Hevy.
export function toCreateRoutineBody(input: CreateRoutineInput) {
  return {
    routine: {
      ...buildRoutineFields(input),
      folder_id: input.folderId ?? null,
    },
  };
}

export function toUpdateRoutineBody(input: UpdateRoutineInput) {
  return { routine: buildRoutineFields(input) };
}

function toRoutineOutput(r: HevyRoutine) {
  return {
    id: r.id,
    title: r.title,
    folderId: r.folder_id,
    exerciseCount: r.exercises.length,
    // Best-effort guess at Hevy's web URL pattern — Hevy does not document a
    // public deep-link scheme or return a URL field on routine responses.
    // Unverified: confirm this actually resolves before relying on it.
    webUrl: `https://hevy.com/routines/${r.id}`,
  };
}

// Unlike GET /v1/routines/{id} (which wraps a single routine object as
// { routine: {...} }), Hevy's POST /v1/routines and PUT /v1/routines/{id}
// wrap the written routine as a *single-element array*: { routine: [{...}] }.
// Previously this module assumed the response was an unwrapped HevyRoutine,
// which meant `r.exercises` was always undefined and every create/update
// call crashed with "Cannot read properties of undefined (reading 'length')"
// in toRoutineOutput — *after* the write had already succeeded against Hevy,
// so callers were told the write failed when it hadn't (see bug report:
// routines were created despite every call erroring). Confirmed against a
// third-party Hevy client's real request/response handling (swrm-io/go-hevy
// RoutinesService.Create/Update), which unwraps the same way.
function unwrapRoutineResponse(data: unknown): HevyRoutine {
  const routines = (data as { routine?: unknown } | null)?.routine;
  if (!Array.isArray(routines) || routines.length === 0) {
    throw new Error(
      `Unexpected Hevy routine response shape (expected { routine: [Routine] }): ${JSON.stringify(
        data
      )}`
    );
  }
  return routines[0] as HevyRoutine;
}

export async function createRoutine(input: CreateRoutineInput) {
  const data = await hevyFetch<unknown>("/v1/routines", {
    method: "POST",
    body: toCreateRoutineBody(input),
  });
  return toRoutineOutput(unwrapRoutineResponse(data));
}

export async function updateRoutine(
  routineId: string,
  input: UpdateRoutineInput
) {
  const data = await hevyFetch<unknown>(
    `/v1/routines/${encodeURIComponent(routineId)}`,
    {
      method: "PUT",
      body: toUpdateRoutineBody(input),
    }
  );
  return toRoutineOutput(unwrapRoutineResponse(data));
}

function toRoutineDetailOutput(r: HevyRoutine) {
  return {
    id: r.id,
    title: r.title,
    folderId: r.folder_id,
    notes: r.notes,
    exercises: (r.exercises ?? []).map((e) => ({
      exerciseTemplateId: e.exercise_template_id,
      title: e.title ?? null,
      notes: e.notes,
      restSeconds: e.rest_seconds,
      // An explicitly-present "superset_id" key always wins, even when its
      // value is null — only fall back to the "supersets_id" spelling when
      // "superset_id" is entirely absent from the parsed JSON. Using `??`
      // here would conflate "explicit null" with "key absent" and could
      // silently prefer the wrong spelling if a response ever included both.
      supersetId:
        "superset_id" in e ? e.superset_id ?? null : e.supersets_id ?? null,
      sets: e.sets.map((s) => ({
        type: s.type,
        reps: s.reps,
        repRange: s.rep_range ?? null,
        weightKg: s.weight_kg,
        distanceMeters: s.distance_meters,
        durationSeconds: s.duration_seconds,
      })),
    })),
  };
}

// GET /v1/routines/{id} wraps a single routine object as { routine: {...} }
// — unlike POST/PUT above, which wrap the same resource as a single-element
// array (see unwrapRoutineResponse). Read-only: this never touches
// create/update's request-building path, so it carries none of the
// notes/set-type validation those do.
export async function getRoutineDetail(routineId: string) {
  const data = await hevyFetch<{ routine?: HevyRoutine }>(
    `/v1/routines/${encodeURIComponent(routineId)}`
  );
  const routine = data.routine;
  if (!routine || Array.isArray(routine)) {
    throw new Error(
      `Unexpected Hevy routine response shape (expected { routine: Routine }): ${JSON.stringify(
        data
      )}`
    );
  }
  return toRoutineDetailOutput(routine);
}

interface HevyRoutineFoldersResponse {
  page: number;
  page_count: number;
  routine_folders: HevyRoutineFolder[];
}

// GET /v1/routine_folders is paginated (max pageSize 10, confirmed against
// swrm-io/go-hevy's RoutineFoldersService.List) and wraps its response as
// { page, page_count, routine_folders: [...] } — the same shape as
// /v1/workouts and /v1/body_measurements above, and unlike the single-folder
// GET /v1/routine_folders/{id} (unwrapped) or the POST response (wrapped
// under "routine_folder", singular — see createRoutineFolder). Folder counts
// are expected to be small, so this walks every page (capped, as a safety
// net) rather than exposing pagination to the caller — the point of this
// tool is letting Claude search *all* folders by title to resolve a
// `folderId`, so a partial first-page-only result would silently break that.
const ROUTINE_FOLDER_PAGE_SIZE = 10;
const ROUTINE_FOLDER_PAGE_CAP = 20; // safety cap (~200 folders)

export async function listRoutineFolders() {
  const all: HevyRoutineFolder[] = [];
  let page = 1;
  while (page <= ROUTINE_FOLDER_PAGE_CAP) {
    const data = await hevyFetch<HevyRoutineFoldersResponse>(
      `/v1/routine_folders?page=${page}&pageSize=${ROUTINE_FOLDER_PAGE_SIZE}`
    );
    all.push(...data.routine_folders);
    if (page >= data.page_count) break;
    page++;
  }
  return all.map((f) => ({ id: f.id, title: f.title, index: f.index }));
}

// Exported for the same dry-run-preview reason as toCreateRoutineBody /
// toUpdateRoutineBody above.
export function toCreateRoutineFolderBody(title: string) {
  return { routine_folder: { title } };
}

export async function createRoutineFolder(title: string) {
  // POST /v1/routine_folders wraps its response as { routine_folder: {...} }
  // (unlike GET /v1/routine_folders/{id}, which returns it unwrapped). This
  // was previously treated as unwrapped, so `folder.id`/`folder.title` were
  // always undefined and JSON.stringify silently dropped them, producing an
  // empty `{}` result (see bug report). Confirmed against swrm-io/go-hevy's
  // RoutineFoldersService.Create, which unwraps the same key.
  const data = await hevyFetch<{ routine_folder?: HevyRoutineFolder }>(
    "/v1/routine_folders",
    {
      method: "POST",
      body: toCreateRoutineFolderBody(title),
    }
  );
  const folder = data.routine_folder;
  if (!folder) {
    throw new Error(
      `Unexpected Hevy routine_folder response shape (expected { routine_folder: RoutineFolder }): ${JSON.stringify(
        data
      )}`
    );
  }
  return { id: folder.id, title: folder.title };
}

interface HevyRoutinesResponse {
  page: number;
  page_count: number;
  routines: HevyRoutine[];
}

// GET /v1/routines is paginated (max pageSize 10, same shape as
// /v1/routine_folders above) and has no server-side folder filter, so
// filtering by folderId means walking every page and filtering
// client-side — same tradeoff as searchExerciseTemplates below, just
// without the response cache (routine lists are cheap enough, and change
// often enough, that staleness isn't worth the tradeoff here).
const ROUTINE_PAGE_SIZE = 10;
const ROUTINE_PAGE_CAP = 50; // safety cap (~500 routines)

async function listAllRoutines(): Promise<HevyRoutine[]> {
  const all: HevyRoutine[] = [];
  let page = 1;
  while (page <= ROUTINE_PAGE_CAP) {
    const data = await hevyFetch<HevyRoutinesResponse>(
      `/v1/routines?page=${page}&pageSize=${ROUTINE_PAGE_SIZE}`
    );
    all.push(...data.routines);
    if (page >= data.page_count) break;
    page++;
  }
  return all;
}

// folderId omitted (undefined) -> every routine, any folder.
// folderId: null            -> only routines not filed in any folder.
// folderId: <number>        -> only routines filed in that folder.
export async function listRoutines(folderId?: number | null) {
  const all = await listAllRoutines();
  const filtered =
    folderId === undefined ? all : all.filter((r) => r.folder_id === folderId);
  return filtered.map((r) => ({
    id: r.id,
    title: r.title,
    folderId: r.folder_id,
    exerciseCount: (r.exercises ?? []).length,
    updatedAt: r.updated_at,
  }));
}

// --- Exercise template search -------------------------------------------
//
// Hevy's /v1/exercise_templates has no free-text search parameter, only
// page/pageSize pagination, so searching means walking all pages and
// filtering client-side. Results are cached per-page in-memory (keyed by
// page number, not by query) so repeated searches within one warm Vercel
// Lambda instance cost one network round-trip total, not one per query.
// The cache is a best-effort optimization only — cold starts or expired
// entries just refetch, correctness never depends on it.

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

const EXERCISE_TEMPLATE_PAGE_CACHE = new Map<
  number,
  CacheEntry<{ items: HevyExerciseTemplate[]; pageCount: number }>
>();
const EXERCISE_TEMPLATE_CACHE_TTL_MS = 10 * 60 * 1000;
const EXERCISE_TEMPLATE_PAGE_SIZE = 100;
const EXERCISE_TEMPLATE_PAGE_CAP = 20; // safety cap (~2000 exercises)

async function fetchExerciseTemplatePage(page: number) {
  const cached = EXERCISE_TEMPLATE_PAGE_CACHE.get(page);
  if (cached && Date.now() - cached.fetchedAt < EXERCISE_TEMPLATE_CACHE_TTL_MS) {
    return cached.data;
  }
  const data = await hevyFetch<HevyExerciseTemplatesResponse>(
    `/v1/exercise_templates?page=${page}&pageSize=${EXERCISE_TEMPLATE_PAGE_SIZE}`
  );
  const entry = { items: data.exercise_templates, pageCount: data.page_count };
  EXERCISE_TEMPLATE_PAGE_CACHE.set(page, { data: entry, fetchedAt: Date.now() });
  return entry;
}

async function listAllExerciseTemplates(): Promise<HevyExerciseTemplate[]> {
  const all: HevyExerciseTemplate[] = [];
  let page = 1;
  while (page <= EXERCISE_TEMPLATE_PAGE_CAP) {
    const { items, pageCount } = await fetchExerciseTemplatePage(page);
    all.push(...items);
    if (page >= pageCount) break;
    page++;
  }
  return all;
}

export async function searchExerciseTemplates(query: string, limit = 10) {
  const q = query.trim().toLowerCase();
  if (q === "") {
    throw new Error("query must not be empty or whitespace-only");
  }
  const resultLimit = Math.min(Math.max(limit, 1), 25);
  const all = await listAllExerciseTemplates();
  return all
    .filter((t) => t.title.toLowerCase().includes(q))
    .slice(0, resultLimit)
    .map((t) => ({
      id: t.id,
      title: t.title,
      muscleGroup: t.primary_muscle_group,
    }));
}

export async function getExerciseTemplateDetail(exerciseTemplateId: string) {
  const t = await hevyFetch<HevyExerciseTemplate>(
    `/v1/exercise_templates/${encodeURIComponent(exerciseTemplateId)}`
  );
  return {
    id: t.id,
    title: t.title,
    type: t.type,
    muscleGroup: t.primary_muscle_group,
    secondaryMuscleGroups: t.secondary_muscle_groups,
    isCustom: t.is_custom,
  };
}

// --- Custom exercise template creation ------------------------------------

export type CustomExerciseType =
  | "weight_reps"
  | "reps_only"
  | "bodyweight_reps"
  | "bodyweight_assisted_reps"
  | "duration"
  | "weight_duration"
  | "distance_duration"
  | "short_distance_weight";

export type EquipmentCategory =
  | "none"
  | "barbell"
  | "dumbbell"
  | "kettlebell"
  | "machine"
  | "plate"
  | "resistance_band"
  | "suspension"
  | "other";

export type MuscleGroup =
  | "abdominals"
  | "shoulders"
  | "biceps"
  | "triceps"
  | "forearms"
  | "quadriceps"
  | "hamstrings"
  | "calves"
  | "glutes"
  | "abductors"
  | "adductors"
  | "lats"
  | "upper_back"
  | "traps"
  | "lower_back"
  | "chest"
  | "cardio"
  | "neck"
  | "full_body"
  | "other";

export interface CreateCustomExerciseTemplateInput {
  title: string;
  exerciseType: CustomExerciseType;
  equipmentCategory: EquipmentCategory;
  muscleGroup: MuscleGroup;
  otherMuscles?: MuscleGroup[] | null;
}

// Exported for the same dry-run-preview reason as the routine/workout body
// builders above.
export function toCreateCustomExerciseTemplateBody(input: CreateCustomExerciseTemplateInput) {
  return {
    exercise: {
      title: input.title,
      exercise_type: input.exerciseType,
      equipment_category: input.equipmentCategory,
      muscle_group: input.muscleGroup,
      other_muscles: input.otherMuscles ?? [],
    },
  };
}

// Hevy's OpenAPI spec documents POST /v1/exercise_templates's 200 response as
// { id: integer } — unlike every other exercise_template_id in this API
// (and everywhere else in this codebase), which is a UUID-like string, e.g.
// "b459cba5-cd6d-463c-abd6-54f8eafcadcb" (see ExerciseTemplate.id in the
// spec, and every exerciseTemplateId field elsewhere in lib/hevy.ts). This
// is almost certainly a spec-documentation inconsistency, not an
// intentional format difference, but it's unverified against a real
// account — accepting either a string or a number here and coercing to a
// string is cheap insurance either way, so the returned id is always usable
// directly as exerciseTemplateId in create_routine/create_workout without
// the caller needing to know which shape Hevy actually returned.
function assertCustomExerciseTemplateResponseShape(data: unknown): { id: string } {
  const d = data as { id?: unknown } | null;
  if (!d || typeof d !== "object" || (typeof d.id !== "string" && typeof d.id !== "number")) {
    throw new Error(
      `Unexpected Hevy custom exercise template response shape (expected { id: string | number }): ${JSON.stringify(
        data
      )}`
    );
  }
  return { id: String(d.id) };
}

export async function createCustomExerciseTemplate(input: CreateCustomExerciseTemplateInput) {
  const data = await hevyFetch<unknown>("/v1/exercise_templates", {
    method: "POST",
    body: toCreateCustomExerciseTemplateBody(input),
  });
  const { id } = assertCustomExerciseTemplateResponseShape(data);
  return { id, title: input.title };
}
