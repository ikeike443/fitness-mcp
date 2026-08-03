const HEVY_API_BASE = "https://api.hevyapp.com";

function apiKey(): string {
  const key = process.env.HEVY_API_KEY;
  if (!key) throw new Error("HEVY_API_KEY is not set");
  return key;
}

async function hevyFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${HEVY_API_BASE}${path}`, {
    headers: { "api-key": apiKey() },
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
