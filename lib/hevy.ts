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

interface HevySet {
  index: number;
  type: string;
  weight_kg: number | null;
  reps: number | null;
  distance_meters: number | null;
  duration_seconds: number | null;
  rpe: number | null;
}

interface HevyExercise {
  index: number;
  title: string;
  notes: string | null;
  exercise_template_id: string;
  sets: HevySet[];
}

interface HevyWorkout {
  id: string;
  title: string;
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

interface HevyBodyMeasurement {
  date: string;
  weight_kg: number | null;
  fat_percent: number | null;
  [key: string]: unknown;
}

interface HevyBodyMeasurementsResponse {
  page: number;
  page_count: number;
  measurements: HevyBodyMeasurement[];
}

function summarizeWorkout(w: HevyWorkout) {
  return {
    id: w.id,
    title: w.title,
    startTime: w.start_time,
    endTime: w.end_time,
    exerciseCount: w.exercises.length,
    exercises: w.exercises.map((e) => e.title),
  };
}

export async function listRecentWorkouts(limit = 5) {
  const pageSize = Math.min(Math.max(limit, 1), 10);
  const data = await hevyFetch<HevyWorkoutsResponse>(
    `/v1/workouts?page=1&pageSize=${pageSize}`
  );
  return data.workouts.map(summarizeWorkout);
}

export async function getWorkoutDetail(workoutId: string) {
  const w = await hevyFetch<HevyWorkout>(`/v1/workouts/${workoutId}`);
  return {
    id: w.id,
    title: w.title,
    description: w.description,
    startTime: w.start_time,
    endTime: w.end_time,
    exercises: w.exercises.map((e) => ({
      title: e.title,
      notes: e.notes,
      sets: e.sets.map((s) => ({
        type: s.type,
        weightKg: s.weight_kg,
        reps: s.reps,
        distanceMeters: s.distance_meters,
        durationSeconds: s.duration_seconds,
        rpe: s.rpe,
      })),
    })),
  };
}

export async function getBodyMeasurements(limit = 10) {
  const pageSize = Math.min(Math.max(limit, 1), 10);
  const data = await hevyFetch<HevyBodyMeasurementsResponse>(
    `/v1/body_measurements?page=1&pageSize=${pageSize}`
  );
  return data.measurements.map((m) => ({
    date: m.date,
    weightKg: m.weight_kg,
    fatPercent: m.fat_percent,
  }));
}

// --- Routine write support ---------------------------------------------
//
// Hevy's routine endpoints are write operations with real side effects in
// the user's account, and Hevy's API is reportedly strict about malformed
// fields. Validation here is intentionally defense-in-depth on top of the
// zod schema in app/api/mcp/route.ts: it protects any direct caller of
// this module (including tests) even if the MCP-layer schema is bypassed.

const VALID_SET_TYPES = new Set(["warmup", "normal", "failure", "dropset"]);

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
  distance_meters: number | null;
  duration_seconds: number | null;
}

interface HevyRoutineExercise {
  exercise_template_id: string;
  superset_id: number | null;
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

export type UpdateRoutineInput = CreateRoutineInput;

// Builds the request body by picking exactly the writable fields by name —
// never spreading caller input — so read-only fields (id, created_at, etc.)
// can never leak into a request body even if a caller passes extra
// properties via a loosely-typed object.
function toHevyRoutineBody(input: CreateRoutineInput) {
  assertValidNotes(input.notes ?? null);
  return {
    routine: {
      title: input.title,
      folder_id: input.folderId ?? null,
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
    },
  };
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
    body: toHevyRoutineBody(input),
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
      body: toHevyRoutineBody(input),
    }
  );
  return toRoutineOutput(unwrapRoutineResponse(data));
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
      body: { routine_folder: { title } },
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
