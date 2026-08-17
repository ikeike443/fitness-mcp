import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

process.env.HEVY_API_KEY = "dummy-hevy-key";

import {
  createRoutine,
  updateRoutine,
  createRoutineFolder,
  listRoutineFolders,
  listRoutines,
  getRoutineDetail,
  listWorkouts,
  getWorkoutCount,
  listWorkoutEvents,
  getWorkoutDetail,
  createWorkout,
  updateWorkout,
  getUserInfo,
  getExerciseTemplateDetail,
  createCustomExerciseTemplate,
  getBodyMeasurementByDate,
  createBodyMeasurement,
  updateBodyMeasurement,
  getRoutineFolderDetail,
  getExerciseHistory,
} from "./hevy";
import type {
  CreateRoutineInput,
  CreateWorkoutInput,
  CreateCustomExerciseTemplateInput,
  CreateBodyMeasurementInput,
} from "./hevy";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

// Hevy's spec documents POST/PUT .../body_measurements(/{date}) as
// returning a 200 with no response body at all — this simulates that.
function emptyResponse(status = 200) {
  return new Response("", { status });
}

const baseInput: CreateRoutineInput = {
  title: "Tuesday: Back & Legs",
  folderId: null,
  notes: null,
  exercises: [
    {
      exerciseTemplateId: "tmpl-deadlift",
      notes: null,
      sets: [
        { type: "warmup", weightKg: 60, reps: 5 },
        { type: "normal", weightKg: 120, reps: 4 },
      ],
    },
  ],
};

// Hevy's real POST/PUT /v1/routines response wraps the written routine as a
// single-element array under "routine" — see the comment on
// unwrapRoutineResponse in lib/hevy.ts for why.
const routineApiResponse = {
  routine: [
    {
      id: "routine-1",
      title: "Tuesday: Back & Legs",
      folder_id: null,
      notes: null,
      exercises: [
        {
          exercise_template_id: "tmpl-deadlift",
          superset_id: null,
          rest_seconds: null,
          notes: null,
          sets: [
            { type: "warmup", weight_kg: 60, reps: 5, distance_meters: null, duration_seconds: null },
            { type: "normal", weight_kg: 120, reps: 4, distance_meters: null, duration_seconds: null },
          ],
        },
      ],
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
    },
  ],
};

const baseWorkoutInput: CreateWorkoutInput = {
  title: "Push day",
  description: null,
  startTime: "2026-08-01T10:00:00Z",
  endTime: "2026-08-01T11:00:00Z",
  exercises: [
    {
      exerciseTemplateId: "tmpl-bench",
      notes: null,
      sets: [{ type: "normal", weightKg: 80, reps: 8 }],
    },
  ],
};

// Unlike POST/PUT /v1/routines (wrapped under "routine" as a single-element
// array — see routineApiResponse above), Hevy's OpenAPI spec documents
// POST/PUT /v1/workouts as returning a bare Workout object — see the
// comment above assertWorkoutShape in lib/hevy.ts for the caveat that this
// is unverified against a real account.
const workoutApiResponse = {
  id: "workout-1",
  title: "Push day",
  routine_id: null,
  description: null,
  start_time: "2026-08-01T10:00:00Z",
  end_time: "2026-08-01T11:00:00Z",
  updated_at: "2026-08-01T11:00:00Z",
  created_at: "2026-08-01T11:00:00Z",
  exercises: [
    {
      index: 0,
      title: "Bench Press (Barbell)",
      notes: null,
      exercise_template_id: "tmpl-bench",
      supersets_id: null,
      sets: [
        {
          index: 0,
          type: "normal",
          weight_kg: 80,
          reps: 8,
          distance_meters: null,
          duration_seconds: null,
          rpe: null,
          custom_metric: null,
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createRoutine", () => {
  it("POSTs the correctly shaped request body", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.hevyapp.com/v1/routines");
      expect(init.method).toBe("POST");
      expect(init.headers).toMatchObject({
        "api-key": "dummy-hevy-key",
        "Content-Type": "application/json",
      });
      expect(JSON.parse(init.body as string)).toEqual({
        routine: {
          title: "Tuesday: Back & Legs",
          folder_id: null,
          notes: null,
          exercises: [
            {
              exercise_template_id: "tmpl-deadlift",
              superset_id: null,
              rest_seconds: null,
              notes: null,
              sets: [
                {
                  type: "warmup",
                  weight_kg: 60,
                  reps: 5,
                  distance_meters: null,
                  duration_seconds: null,
                },
                {
                  type: "normal",
                  weight_kg: 120,
                  reps: 4,
                  distance_meters: null,
                  duration_seconds: null,
                },
              ],
            },
          ],
        },
      });
      return jsonResponse(routineApiResponse, 201);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createRoutine(baseInput);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      id: "routine-1",
      title: "Tuesday: Back & Legs",
      folderId: null,
      exerciseCount: 1,
      webUrl: "https://hevy.com/routines/routine-1",
    });
  });

  it("defaults omitted optional fields to null without calling fetch first", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.routine.folder_id).toBeNull();
      expect(body.routine.notes).toBeNull();
      expect(body.routine.exercises[0].superset_id).toBeNull();
      expect(body.routine.exercises[0].rest_seconds).toBeNull();
      return jsonResponse(routineApiResponse, 201);
    });
    vi.stubGlobal("fetch", fetchMock);

    await createRoutine(baseInput);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects routine-level notes containing "@" without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createRoutine({ ...baseInput, notes: "ping me @coach" })
    ).rejects.toThrow(/must not contain "@"/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects exercise-level notes containing "@" without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createRoutine({
        ...baseInput,
        exercises: [{ ...baseInput.exercises[0], notes: "cc @coach" }],
      })
    ).rejects.toThrow(/must not contain "@"/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid set type without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createRoutine({
        ...baseInput,
        exercises: [
          {
            ...baseInput.exercises[0],
            sets: [{ type: "working" as CreateRoutineInput["exercises"][number]["sets"][number]["type"], reps: 5 }],
          },
        ],
      })
    ).rejects.toThrow(/Invalid set type "working"/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never leaks read-only fields into the outgoing request body", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const raw = init.body as string;
      expect(raw).not.toContain("created_at");
      expect(raw).not.toContain("\"id\"");
      return jsonResponse(routineApiResponse, 201);
    });
    vi.stubGlobal("fetch", fetchMock);

    const pollutedInput = {
      ...baseInput,
      id: "should-not-be-sent",
      created_at: "should-not-be-sent",
      exercises: [
        { ...baseInput.exercises[0], id: "exercise-should-not-be-sent" },
      ],
    } as unknown as CreateRoutineInput;

    await createRoutine(pollutedInput);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("propagates the raw Hevy error body on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: "validation_error", fields: { title: "required" } }, 422)
      )
    );

    await expect(createRoutine(baseInput)).rejects.toThrow(/validation_error/);
  });

  it("throws a clear diagnostic (not a TypeError) if Hevy ever returns an unwrapped routine", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { id: "routine-1", title: "x", folder_id: null, exercises: [] },
          201
        )
      )
    );

    await expect(createRoutine(baseInput)).rejects.toThrow(
      /Unexpected Hevy routine response shape/
    );
  });

  it("throws a clear diagnostic if Hevy returns an empty routine array", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ routine: [] }, 201)));

    await expect(createRoutine(baseInput)).rejects.toThrow(
      /Unexpected Hevy routine response shape/
    );
  });
});

describe("updateRoutine", () => {
  it("PUTs to /v1/routines/{routineId} with the correct URL and method", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.hevyapp.com/v1/routines/routine-1");
      expect(init.method).toBe("PUT");
      return jsonResponse(routineApiResponse, 200);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await updateRoutine("routine-1", baseInput);
    expect(result.id).toBe("routine-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Regression test for a real Hevy 400 ("Unrecognized key(s) in object:
  // 'folder_id'") reported against update_routine: unlike POST /v1/routines,
  // PUT /v1/routines/{id} has no folder_id field in its schema at all —
  // sending the key (even as null) is rejected outright. createRoutine
  // still sends folder_id (see the "defaults omitted optional fields to
  // null" test above); updateRoutine must never send it.
  it("never includes a folder_id key in the PUT body, even though createRoutine sends one", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.routine).not.toHaveProperty("folder_id");
      expect(Object.keys(body.routine).sort()).toEqual(
        ["exercises", "notes", "title"]
      );
      return jsonResponse(routineApiResponse, 200);
    });
    vi.stubGlobal("fetch", fetchMock);

    await updateRoutine("routine-1", {
      title: baseInput.title,
      notes: baseInput.notes,
      exercises: baseInput.exercises,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects notes containing "@" without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateRoutine("routine-1", { ...baseInput, notes: "@bad" })
    ).rejects.toThrow(/must not contain "@"/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("URL-encodes a routineId containing special characters", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.hevyapp.com/v1/routines/foo%2Fbar..");
      return jsonResponse(routineApiResponse, 200);
    });
    vi.stubGlobal("fetch", fetchMock);

    await updateRoutine("foo/bar..", baseInput);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("getRoutineDetail", () => {
  it("GETs /v1/routines/{id} and returns full exercise/set detail", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.hevyapp.com/v1/routines/routine-1");
      // Unlike POST/PUT (single-element array under "routine"), GET wraps a
      // single routine object directly under "routine".
      return jsonResponse({
        routine: {
          id: "routine-1",
          title: "Tuesday: Back & Legs",
          folder_id: 7,
          notes: "focus on form",
          exercises: [
            {
              exercise_template_id: "tmpl-deadlift",
              title: "Deadlift (Barbell)",
              superset_id: null,
              rest_seconds: 90,
              notes: "go heavy",
              sets: [
                {
                  type: "warmup",
                  weight_kg: 60,
                  reps: 5,
                  rep_range: null,
                  distance_meters: null,
                  duration_seconds: null,
                },
                {
                  type: "normal",
                  weight_kg: null,
                  reps: null,
                  rep_range: { start: 8, end: 12 },
                  distance_meters: null,
                  duration_seconds: null,
                },
              ],
            },
          ],
          created_at: "2026-08-01T00:00:00Z",
          updated_at: "2026-08-02T00:00:00Z",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getRoutineDetail("routine-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      id: "routine-1",
      title: "Tuesday: Back & Legs",
      folderId: 7,
      notes: "focus on form",
      exercises: [
        {
          exerciseTemplateId: "tmpl-deadlift",
          title: "Deadlift (Barbell)",
          notes: "go heavy",
          restSeconds: 90,
          supersetId: null,
          sets: [
            {
              type: "warmup",
              reps: 5,
              repRange: null,
              weightKg: 60,
              distanceMeters: null,
              durationSeconds: null,
            },
            {
              type: "normal",
              reps: null,
              repRange: { start: 8, end: 12 },
              weightKg: null,
              distanceMeters: null,
              durationSeconds: null,
            },
          ],
        },
      ],
    });
  });

  it("URL-encodes a routineId containing special characters", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.hevyapp.com/v1/routines/foo%2Fbar..");
      return jsonResponse({
        routine: {
          id: "foo/bar..",
          title: "x",
          folder_id: null,
          notes: null,
          exercises: [],
          created_at: "x",
          updated_at: "x",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await getRoutineDetail("foo/bar..");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws a clear diagnostic if Hevy ever returns the array-wrapped shape instead", async () => {
    // Regression guard for the opposite mixup of the create/update bug: GET
    // wraps a single object, not an array — if Hevy ever changed that (or a
    // caller pointed this at the wrong shape), this should fail loudly
    // rather than silently returning undefined fields.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ routine: [{ id: "routine-1" }] }))
    );

    await expect(getRoutineDetail("routine-1")).rejects.toThrow(
      /Unexpected Hevy routine response shape/
    );
  });

  it("falls back to the supersets_id spelling if superset_id is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          routine: {
            id: "routine-1",
            title: "x",
            folder_id: null,
            notes: null,
            exercises: [
              {
                exercise_template_id: "tmpl-bench",
                supersets_id: 2,
                rest_seconds: null,
                notes: null,
                sets: [],
              },
            ],
            created_at: "x",
            updated_at: "x",
          },
        })
      )
    );

    const result = await getRoutineDetail("routine-1");
    expect(result.exercises[0].supersetId).toBe(2);
  });

  it("prefers an explicitly-present superset_id: null over a simultaneous supersets_id value", async () => {
    // Regression guard: `superset_id: null` means "explicitly no superset",
    // which must win even if a stray `supersets_id` key with a real value is
    // also present. A naive `e.superset_id ?? e.supersets_id ?? null` would
    // incorrectly fall through to 2 here since `??` treats explicit null the
    // same as the key being absent.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          routine: {
            id: "routine-1",
            title: "x",
            folder_id: null,
            notes: null,
            exercises: [
              {
                exercise_template_id: "tmpl-bench",
                superset_id: null,
                supersets_id: 2,
                rest_seconds: null,
                notes: null,
                sets: [],
              },
            ],
            created_at: "x",
            updated_at: "x",
          },
        })
      )
    );

    const result = await getRoutineDetail("routine-1");
    expect(result.exercises[0].supersetId).toBeNull();
  });
});

describe("createRoutineFolder", () => {
  it("POSTs the correct body and returns id/title", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.hevyapp.com/v1/routine_folders");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({
        routine_folder: { title: "Cut phase" },
      });
      // Hevy's real response wraps the created folder under
      // "routine_folder" — see the comment in lib/hevy.ts.
      return jsonResponse({
        routine_folder: {
          id: 42,
          title: "Cut phase",
          index: 0,
          created_at: "2026-08-01T00:00:00Z",
          updated_at: "2026-08-01T00:00:00Z",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createRoutineFolder("Cut phase");
    expect(result).toEqual({ id: 42, title: "Cut phase" });
  });

  it("throws a clear diagnostic if Hevy ever returns an unwrapped folder", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ id: 42, title: "Cut phase" }))
    );

    await expect(createRoutineFolder("Cut phase")).rejects.toThrow(
      /Unexpected Hevy routine_folder response shape/
    );
  });
});

describe("listRoutineFolders", () => {
  it("GETs a single page and returns id/title/index", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://api.hevyapp.com/v1/routine_folders?page=1&pageSize=10"
      );
      return jsonResponse({
        page: 1,
        page_count: 1,
        routine_folders: [
          {
            id: 7,
            title: "Push Pull Legs",
            index: 0,
            created_at: "2026-08-01T00:00:00Z",
            updated_at: "2026-08-01T00:00:00Z",
          },
          {
            id: 9,
            title: "外部エージェント作成",
            index: 1,
            created_at: "2026-08-02T00:00:00Z",
            updated_at: "2026-08-02T00:00:00Z",
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await listRoutineFolders();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      { id: 7, title: "Push Pull Legs", index: 0 },
      { id: 9, title: "外部エージェント作成", index: 1 },
    ]);
  });

  it("walks every page and merges results", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("page=1")) {
        return jsonResponse({
          page: 1,
          page_count: 2,
          routine_folders: [{ id: 1, title: "A", index: 0 }],
        });
      }
      expect(url).toContain("page=2");
      return jsonResponse({
        page: 2,
        page_count: 2,
        routine_folders: [{ id: 2, title: "B", index: 1 }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await listRoutineFolders();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.map((f) => f.id)).toEqual([1, 2]);
  });

  it("returns an empty array when the account has no folders", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ page: 1, page_count: 1, routine_folders: [] })
      )
    );

    expect(await listRoutineFolders()).toEqual([]);
  });
});

describe("listRoutines", () => {
  function routine(overrides: Partial<{ id: string; title: string; folder_id: number | null; exerciseCount: number }>) {
    return {
      id: overrides.id ?? "r1",
      title: overrides.title ?? "Routine",
      folder_id: overrides.folder_id ?? null,
      notes: null,
      exercises: Array.from({ length: overrides.exerciseCount ?? 0 }, () => ({
        exercise_template_id: "x",
        superset_id: null,
        rest_seconds: null,
        notes: null,
        sets: [],
      })),
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-02T00:00:00Z",
    };
  }

  it("GETs a single page and returns id/title/folderId/exerciseCount/updatedAt", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.hevyapp.com/v1/routines?page=1&pageSize=10");
      return jsonResponse({
        page: 1,
        page_count: 1,
        routines: [routine({ id: "r1", title: "Push", folder_id: 7, exerciseCount: 3 })],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await listRoutines();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        id: "r1",
        title: "Push",
        folderId: 7,
        exerciseCount: 3,
        updatedAt: "2026-08-02T00:00:00Z",
      },
    ]);
  });

  it("walks every page and merges results when folderId is omitted", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("page=1")) {
        return jsonResponse({
          page: 1,
          page_count: 2,
          routines: [routine({ id: "r1" })],
        });
      }
      expect(url).toContain("page=2");
      return jsonResponse({
        page: 2,
        page_count: 2,
        routines: [routine({ id: "r2" })],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await listRoutines();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("filters to a specific folderId, still walking every page first", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          page: 1,
          page_count: 1,
          routines: [
            routine({ id: "r1", folder_id: 7 }),
            routine({ id: "r2", folder_id: 9 }),
          ],
        })
      )
    );

    const result = await listRoutines(7);
    expect(result.map((r) => r.id)).toEqual(["r1"]);
  });

  it("filters to unfiled routines when folderId is explicitly null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          page: 1,
          page_count: 1,
          routines: [
            routine({ id: "r1", folder_id: null }),
            routine({ id: "r2", folder_id: 9 }),
          ],
        })
      )
    );

    const result = await listRoutines(null);
    expect(result.map((r) => r.id)).toEqual(["r1"]);
  });

  it("returns an empty array when the account has no routines", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ page: 1, page_count: 1, routines: [] }))
    );

    expect(await listRoutines()).toEqual([]);
  });
});

describe("searchExerciseTemplates", () => {
  // The exercise-template page cache is module-level state, so each test
  // here gets a fresh module instance to avoid one test's cached pages
  // leaking into the next.
  async function freshSearchExerciseTemplates() {
    vi.resetModules();
    const mod = await import("./hevy");
    return mod.searchExerciseTemplates;
  }

  function templatePage(items: Array<{ id: string; title: string }>, pageCount = 1) {
    return {
      page: 1,
      page_count: pageCount,
      exercise_templates: items.map((i) => ({
        id: i.id,
        title: i.title,
        type: "weight_reps",
        primary_muscle_group: "back",
        secondary_muscle_groups: [],
        is_custom: false,
      })),
    };
  }

  it("filters by case-insensitive substring match and respects limit", async () => {
    const search = await freshSearchExerciseTemplates();
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        templatePage([
          { id: "1", title: "Bench Press (Barbell)" },
          { id: "2", title: "Incline Bench Press (Dumbbell)" },
          { id: "3", title: "Squat (Barbell)" },
        ])
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const results = await search("bench", 1);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      id: "1",
      title: "Bench Press (Barbell)",
      muscleGroup: "back",
    });
  });

  it("walks multiple pages and merges results", async () => {
    const search = await freshSearchExerciseTemplates();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("page=1")) {
        return jsonResponse(templatePage([{ id: "1", title: "Bench Press" }], 2));
      }
      return jsonResponse(templatePage([{ id: "2", title: "Cable Bench Fly" }], 2));
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await search("bench", 10);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results.map((r) => r.id).sort()).toEqual(["1", "2"]);
  });

  it("rejects a whitespace-only query without calling fetch", async () => {
    const search = await freshSearchExerciseTemplates();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(search("   ")).rejects.toThrow(
      /query must not be empty or whitespace-only/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caches pages across calls within the TTL and refetches after it expires", async () => {
    const search = await freshSearchExerciseTemplates();
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse(templatePage([{ id: "1", title: "Squat" }])));
    vi.stubGlobal("fetch", fetchMock);

    await search("squat");
    await search("squat");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(11 * 60 * 1000);
    await search("squat");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("listWorkouts", () => {
  it("GETs /v1/workouts with default page/pageSize and maps the response, including routineId", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.hevyapp.com/v1/workouts?page=1&pageSize=5");
      return jsonResponse({
        page: 1,
        page_count: 4,
        workouts: [workoutApiResponse],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await listWorkouts();
    expect(result).toEqual({
      page: 1,
      pageCount: 4,
      workouts: [
        {
          id: "workout-1",
          title: "Push day",
          routineId: null,
          startTime: "2026-08-01T10:00:00Z",
          endTime: "2026-08-01T11:00:00Z",
          exerciseCount: 1,
          exercises: ["Bench Press (Barbell)"],
        },
      ],
    });
  });

  it("passes page/pageSize through and clamps pageSize to the 1-10 range", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ page: 2, page_count: 4, workouts: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await listWorkouts({ page: 2, pageSize: 999 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.hevyapp.com/v1/workouts?page=2&pageSize=10",
      expect.anything()
    );
  });

  it("clamps a page of 0 or negative up to 1", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ page: 1, page_count: 4, workouts: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await listWorkouts({ page: -3 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.hevyapp.com/v1/workouts?page=1&pageSize=5",
      expect.anything()
    );
  });

  it("surfaces routineId when a workout was logged from a routine", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          page: 1,
          page_count: 1,
          workouts: [{ ...workoutApiResponse, routine_id: "routine-1" }],
        })
      )
    );

    const result = await listWorkouts();
    expect(result.workouts[0].routineId).toBe("routine-1");
  });
});

describe("getWorkoutCount", () => {
  it("GETs /v1/workouts/count and returns the count", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.hevyapp.com/v1/workouts/count");
      return jsonResponse({ workout_count: 42 });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await getWorkoutCount()).toEqual({ count: 42 });
  });
});

describe("listWorkoutEvents", () => {
  it("GETs /v1/workouts/events with the default since/page/pageSize", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://api.hevyapp.com/v1/workouts/events?page=1&pageSize=5&since=1970-01-01T00%3A00%3A00Z"
      );
      return jsonResponse({ page: 1, page_count: 1, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await listWorkoutEvents();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes a custom since through, URL-encoded", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("since=2026-08-01T00%3A00%3A00Z");
      return jsonResponse({ page: 1, page_count: 1, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await listWorkoutEvents({ since: "2026-08-01T00:00:00Z" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clamps a page of 0 or negative up to 1", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("page=1&");
      return jsonResponse({ page: 1, page_count: 1, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await listWorkoutEvents({ page: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps 'updated' events to a workout summary and 'deleted' events to id/deletedAt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          page: 1,
          page_count: 1,
          events: [
            { type: "updated", workout: workoutApiResponse },
            { type: "deleted", id: "workout-2", deleted_at: "2026-08-02T00:00:00Z" },
          ],
        })
      )
    );

    const result = await listWorkoutEvents();
    expect(result).toEqual({
      page: 1,
      pageCount: 1,
      events: [
        {
          type: "updated",
          workout: {
            id: "workout-1",
            title: "Push day",
            routineId: null,
            startTime: "2026-08-01T10:00:00Z",
            endTime: "2026-08-01T11:00:00Z",
            exerciseCount: 1,
            exercises: ["Bench Press (Barbell)"],
          },
        },
        { type: "deleted", id: "workout-2", deletedAt: "2026-08-02T00:00:00Z" },
      ],
    });
  });
});

describe("getWorkoutDetail", () => {
  it("GETs /v1/workouts/{id} and returns full exercise/set detail including exerciseTemplateId/supersetId/customMetric/routineId", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.hevyapp.com/v1/workouts/workout-1");
      return jsonResponse({
        ...workoutApiResponse,
        routine_id: "routine-1",
        exercises: [
          {
            ...workoutApiResponse.exercises[0],
            supersets_id: 2,
            sets: [{ ...workoutApiResponse.exercises[0].sets[0], rpe: 8.5, custom_metric: 12 }],
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getWorkoutDetail("workout-1");
    expect(result).toEqual({
      id: "workout-1",
      title: "Push day",
      routineId: "routine-1",
      description: null,
      startTime: "2026-08-01T10:00:00Z",
      endTime: "2026-08-01T11:00:00Z",
      exercises: [
        {
          exerciseTemplateId: "tmpl-bench",
          title: "Bench Press (Barbell)",
          notes: null,
          supersetId: 2,
          sets: [
            {
              type: "normal",
              weightKg: 80,
              reps: 8,
              distanceMeters: null,
              durationSeconds: null,
              rpe: 8.5,
              customMetric: 12,
            },
          ],
        },
      ],
    });
  });

  it("URL-encodes a workoutId containing special characters", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.hevyapp.com/v1/workouts/foo%2Fbar..");
      return jsonResponse(workoutApiResponse);
    });
    vi.stubGlobal("fetch", fetchMock);

    await getWorkoutDetail("foo/bar..");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("createWorkout", () => {
  it("POSTs the correctly shaped request body", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.hevyapp.com/v1/workouts");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({
        workout: {
          title: "Push day",
          description: null,
          start_time: "2026-08-01T10:00:00Z",
          end_time: "2026-08-01T11:00:00Z",
          is_private: false,
          exercises: [
            {
              exercise_template_id: "tmpl-bench",
              superset_id: null,
              notes: null,
              sets: [
                {
                  type: "normal",
                  weight_kg: 80,
                  reps: 8,
                  distance_meters: null,
                  duration_seconds: null,
                  rpe: null,
                  custom_metric: null,
                },
              ],
            },
          ],
        },
      });
      return jsonResponse(workoutApiResponse, 201);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createWorkout(baseWorkoutInput);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      id: "workout-1",
      title: "Push day",
      routineId: null,
      startTime: "2026-08-01T10:00:00Z",
      endTime: "2026-08-01T11:00:00Z",
      exerciseCount: 1,
    });
  });

  it("defaults isPrivate to false when omitted", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.workout.is_private).toBe(false);
      return jsonResponse(workoutApiResponse, 201);
    });
    vi.stubGlobal("fetch", fetchMock);

    await createWorkout(baseWorkoutInput);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects exercise notes containing "@" without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createWorkout({
        ...baseWorkoutInput,
        exercises: [{ ...baseWorkoutInput.exercises[0], notes: "cc @coach" }],
      })
    ).rejects.toThrow(/must not contain "@"/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a workout-level description containing "@" without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createWorkout({ ...baseWorkoutInput, description: "ping me @coach" })
    ).rejects.toThrow(/must not contain "@"/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid set type without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createWorkout({
        ...baseWorkoutInput,
        exercises: [
          {
            ...baseWorkoutInput.exercises[0],
            sets: [{ type: "working" as CreateWorkoutInput["exercises"][number]["sets"][number]["type"], reps: 5 }],
          },
        ],
      })
    ).rejects.toThrow(/Invalid set type "working"/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid rpe value without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createWorkout({
        ...baseWorkoutInput,
        exercises: [
          {
            ...baseWorkoutInput.exercises[0],
            sets: [{ type: "normal", reps: 5, rpe: 8.25 }],
          },
        ],
      })
    ).rejects.toThrow(/Invalid rpe 8.25/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts every documented rpe value", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(workoutApiResponse, 201)));

    for (const rpe of [6, 7, 7.5, 8, 8.5, 9, 9.5, 10]) {
      await expect(
        createWorkout({
          ...baseWorkoutInput,
          exercises: [{ ...baseWorkoutInput.exercises[0], sets: [{ type: "normal", reps: 5, rpe }] }],
        })
      ).resolves.toBeDefined();
    }
  });

  it("never leaks read-only fields into the outgoing request body", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const raw = init.body as string;
      expect(raw).not.toContain("created_at");
      expect(raw).not.toContain("\"id\"");
      return jsonResponse(workoutApiResponse, 201);
    });
    vi.stubGlobal("fetch", fetchMock);

    const pollutedInput = {
      ...baseWorkoutInput,
      id: "should-not-be-sent",
      created_at: "should-not-be-sent",
    } as unknown as CreateWorkoutInput;

    await createWorkout(pollutedInput);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("propagates the raw Hevy error body on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "validation_error" }, 422))
    );

    await expect(createWorkout(baseWorkoutInput)).rejects.toThrow(/validation_error/);
  });

  it("throws a clear diagnostic (not a TypeError) if Hevy returns an unexpected shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ not: "a workout" }, 201)));

    await expect(createWorkout(baseWorkoutInput)).rejects.toThrow(
      /Unexpected Hevy workout response shape/
    );
  });
});

describe("updateWorkout", () => {
  it("PUTs to /v1/workouts/{workoutId} with the correct URL and method", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.hevyapp.com/v1/workouts/workout-1");
      expect(init.method).toBe("PUT");
      return jsonResponse(workoutApiResponse, 200);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await updateWorkout("workout-1", baseWorkoutInput);
    expect(result.id).toBe("workout-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects notes containing "@" without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateWorkout("workout-1", {
        ...baseWorkoutInput,
        exercises: [{ ...baseWorkoutInput.exercises[0], notes: "@bad" }],
      })
    ).rejects.toThrow(/must not contain "@"/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a workout-level description containing "@" without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateWorkout("workout-1", { ...baseWorkoutInput, description: "ping me @coach" })
    ).rejects.toThrow(/must not contain "@"/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid set type without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateWorkout("workout-1", {
        ...baseWorkoutInput,
        exercises: [
          {
            ...baseWorkoutInput.exercises[0],
            sets: [{ type: "working" as CreateWorkoutInput["exercises"][number]["sets"][number]["type"], reps: 5 }],
          },
        ],
      })
    ).rejects.toThrow(/Invalid set type "working"/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid rpe value without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateWorkout("workout-1", {
        ...baseWorkoutInput,
        exercises: [
          {
            ...baseWorkoutInput.exercises[0],
            sets: [{ type: "normal", reps: 5, rpe: 8.25 }],
          },
        ],
      })
    ).rejects.toThrow(/Invalid rpe 8.25/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never leaks read-only fields into the outgoing request body", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const raw = init.body as string;
      expect(raw).not.toContain("created_at");
      expect(raw).not.toContain("\"id\"");
      return jsonResponse(workoutApiResponse, 200);
    });
    vi.stubGlobal("fetch", fetchMock);

    const pollutedInput = {
      ...baseWorkoutInput,
      id: "should-not-be-sent",
      created_at: "should-not-be-sent",
    } as unknown as CreateWorkoutInput;

    await updateWorkout("workout-1", pollutedInput);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("propagates the raw Hevy error body on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "validation_error" }, 422))
    );

    await expect(updateWorkout("workout-1", baseWorkoutInput)).rejects.toThrow(
      /validation_error/
    );
  });

  it("throws a clear diagnostic (not a TypeError) if Hevy returns an unexpected shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ not: "a workout" }, 200)));

    await expect(updateWorkout("workout-1", baseWorkoutInput)).rejects.toThrow(
      /Unexpected Hevy workout response shape/
    );
  });

  it("URL-encodes a workoutId containing special characters", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.hevyapp.com/v1/workouts/foo%2Fbar..");
      return jsonResponse(workoutApiResponse, 200);
    });
    vi.stubGlobal("fetch", fetchMock);

    await updateWorkout("foo/bar..", baseWorkoutInput);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("getUserInfo", () => {
  it("GETs /v1/user/info and returns id/name/profileUrl", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.hevyapp.com/v1/user/info");
      return jsonResponse({
        data: { id: "user-1", name: "Jane Doe", url: "https://hevy.com/user/jane" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await getUserInfo()).toEqual({
      id: "user-1",
      name: "Jane Doe",
      profileUrl: "https://hevy.com/user/jane",
    });
  });
});

describe("getExerciseTemplateDetail", () => {
  it("GETs /v1/exercise_templates/{id} and returns full detail", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.hevyapp.com/v1/exercise_templates/tmpl-bench");
      return jsonResponse({
        id: "tmpl-bench",
        title: "Bench Press (Barbell)",
        type: "weight_reps",
        primary_muscle_group: "chest",
        secondary_muscle_groups: ["triceps", "shoulders"],
        is_custom: false,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getExerciseTemplateDetail("tmpl-bench");
    expect(result).toEqual({
      id: "tmpl-bench",
      title: "Bench Press (Barbell)",
      type: "weight_reps",
      muscleGroup: "chest",
      secondaryMuscleGroups: ["triceps", "shoulders"],
      isCustom: false,
    });
  });

  it("URL-encodes an exerciseTemplateId containing special characters", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.hevyapp.com/v1/exercise_templates/foo%2Fbar..");
      return jsonResponse({
        id: "foo/bar..",
        title: "x",
        type: "weight_reps",
        primary_muscle_group: "chest",
        secondary_muscle_groups: [],
        is_custom: false,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await getExerciseTemplateDetail("foo/bar..");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("createCustomExerciseTemplate", () => {
  const baseCustomExerciseInput: CreateCustomExerciseTemplateInput = {
    title: "Sled Push",
    exerciseType: "weight_reps",
    equipmentCategory: "other",
    muscleGroup: "quadriceps",
    otherMuscles: ["glutes", "hamstrings"],
  };

  it("POSTs the correctly shaped request body", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.hevyapp.com/v1/exercise_templates");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({
        exercise: {
          title: "Sled Push",
          exercise_type: "weight_reps",
          equipment_category: "other",
          muscle_group: "quadriceps",
          other_muscles: ["glutes", "hamstrings"],
        },
      });
      return jsonResponse({ id: 123 }, 200);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createCustomExerciseTemplate(baseCustomExerciseInput);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Hevy's spec documents this response as { id: integer }, unlike every
    // other exercise_template_id in the API (a UUID-like string) — see the
    // comment above assertCustomExerciseTemplateResponseShape in
    // lib/hevy.ts. Confirms the id is coerced to a string either way.
    expect(result).toEqual({ id: "123", title: "Sled Push" });
  });

  it("defaults otherMuscles to an empty array when omitted", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.exercise.other_muscles).toEqual([]);
      return jsonResponse({ id: 123 }, 200);
    });
    vi.stubGlobal("fetch", fetchMock);

    const withoutOtherMuscles: CreateCustomExerciseTemplateInput = {
      title: baseCustomExerciseInput.title,
      exerciseType: baseCustomExerciseInput.exerciseType,
      equipmentCategory: baseCustomExerciseInput.equipmentCategory,
      muscleGroup: baseCustomExerciseInput.muscleGroup,
    };
    await createCustomExerciseTemplate(withoutOtherMuscles);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a string id in the response as well as a number", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ id: "b459cba5-cd6d" }, 200)));

    const result = await createCustomExerciseTemplate(baseCustomExerciseInput);
    expect(result).toEqual({ id: "b459cba5-cd6d", title: "Sled Push" });
  });

  it("propagates the raw Hevy error body on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "exceeds-custom-exercise-limit" }, 403))
    );

    await expect(createCustomExerciseTemplate(baseCustomExerciseInput)).rejects.toThrow(
      /exceeds-custom-exercise-limit/
    );
  });

  it("throws a clear diagnostic (not a TypeError) if Hevy returns an unexpected shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ not: "an id" }, 200)));

    await expect(createCustomExerciseTemplate(baseCustomExerciseInput)).rejects.toThrow(
      /Unexpected Hevy custom exercise template response shape/
    );
  });
});

const FULL_BODY_MEASUREMENT_API_RESPONSE = {
  date: "2026-08-01",
  weight_kg: 80.5,
  lean_mass_kg: 65,
  fat_percent: 18.5,
  neck_cm: 38,
  shoulder_cm: 115,
  chest_cm: 95,
  left_bicep_cm: 35,
  right_bicep_cm: 35.5,
  left_forearm_cm: 28,
  right_forearm_cm: 28.5,
  abdomen: 85,
  waist: 80,
  hips: 95,
  left_thigh: 55,
  right_thigh: 55.5,
  left_calf: 37,
  right_calf: 37.5,
};

const FULL_BODY_MEASUREMENT_OUTPUT = {
  date: "2026-08-01",
  weightKg: 80.5,
  leanMassKg: 65,
  fatPercent: 18.5,
  neckCm: 38,
  shoulderCm: 115,
  chestCm: 95,
  leftBicepCm: 35,
  rightBicepCm: 35.5,
  leftForearmCm: 28,
  rightForearmCm: 28.5,
  abdomen: 85,
  waist: 80,
  hips: 95,
  leftThigh: 55,
  rightThigh: 55.5,
  leftCalf: 37,
  rightCalf: 37.5,
};

describe("getBodyMeasurementByDate", () => {
  it("GETs /v1/body_measurements/{date} and returns every field", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.hevyapp.com/v1/body_measurements/2026-08-01");
      return jsonResponse(FULL_BODY_MEASUREMENT_API_RESPONSE);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getBodyMeasurementByDate("2026-08-01");
    expect(result).toEqual(FULL_BODY_MEASUREMENT_OUTPUT);
  });

  it("URL-encodes a date-like path segment containing special characters", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.hevyapp.com/v1/body_measurements/2026%2F08%2F01");
      return jsonResponse(FULL_BODY_MEASUREMENT_API_RESPONSE);
    });
    vi.stubGlobal("fetch", fetchMock);

    await getBodyMeasurementByDate("2026/08/01");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("createBodyMeasurement", () => {
  const baseInput: CreateBodyMeasurementInput = {
    date: "2026-08-01",
    weightKg: 80.5,
    fatPercent: 18.5,
  };

  it("POSTs the correctly shaped request body, tolerates Hevy's empty response body, and returns the read-back entry", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === "POST") {
        expect(url).toBe("https://api.hevyapp.com/v1/body_measurements");
        expect(JSON.parse(init.body as string)).toEqual({
          date: "2026-08-01",
          weight_kg: 80.5,
          lean_mass_kg: null,
          fat_percent: 18.5,
          neck_cm: null,
          shoulder_cm: null,
          chest_cm: null,
          left_bicep_cm: null,
          right_bicep_cm: null,
          left_forearm_cm: null,
          right_forearm_cm: null,
          abdomen: null,
          waist: null,
          hips: null,
          left_thigh: null,
          right_thigh: null,
          left_calf: null,
          right_calf: null,
        });
        // Hevy's spec documents no response body on success — confirm this
        // doesn't crash hevyFetch's res.json() call.
        return emptyResponse(200);
      }
      // The follow-up read-back GET.
      expect(url).toBe("https://api.hevyapp.com/v1/body_measurements/2026-08-01");
      return jsonResponse({
        ...FULL_BODY_MEASUREMENT_API_RESPONSE,
        lean_mass_kg: null,
        neck_cm: null,
        shoulder_cm: null,
        chest_cm: null,
        left_bicep_cm: null,
        right_bicep_cm: null,
        left_forearm_cm: null,
        right_forearm_cm: null,
        abdomen: null,
        waist: null,
        hips: null,
        left_thigh: null,
        right_thigh: null,
        left_calf: null,
        right_calf: null,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createBodyMeasurement(baseInput);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      ...FULL_BODY_MEASUREMENT_OUTPUT,
      leanMassKg: null,
      neckCm: null,
      shoulderCm: null,
      chestCm: null,
      leftBicepCm: null,
      rightBicepCm: null,
      leftForearmCm: null,
      rightForearmCm: null,
      abdomen: null,
      waist: null,
      hips: null,
      leftThigh: null,
      rightThigh: null,
      leftCalf: null,
      rightCalf: null,
    });
  });

  it("propagates the raw Hevy error body on a non-2xx response (e.g. 409 duplicate date) without a follow-up read", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: "A measurement for this date already exists" }, 409)
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(createBodyMeasurement(baseInput)).rejects.toThrow(/already exists/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("updateBodyMeasurement", () => {
  it("PUTs to /v1/body_measurements/{date} with no date field in the body, tolerates the empty response, and returns the read-back entry", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === "PUT") {
        expect(url).toBe("https://api.hevyapp.com/v1/body_measurements/2026-08-01");
        const body = JSON.parse(init.body as string);
        expect(body).not.toHaveProperty("date");
        expect(body.weight_kg).toBe(81);
        return emptyResponse(200);
      }
      expect(url).toBe("https://api.hevyapp.com/v1/body_measurements/2026-08-01");
      return jsonResponse({ ...FULL_BODY_MEASUREMENT_API_RESPONSE, weight_kg: 81 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await updateBodyMeasurement("2026-08-01", { weightKg: 81 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.weightKg).toBe(81);
  });

  it("URL-encodes a date-like path segment containing special characters", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.hevyapp.com/v1/body_measurements/2026%2F08%2F01");
      return init.method === "PUT" ? emptyResponse(200) : jsonResponse(FULL_BODY_MEASUREMENT_API_RESPONSE);
    });
    vi.stubGlobal("fetch", fetchMock);

    await updateBodyMeasurement("2026/08/01", { weightKg: 81 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("propagates the raw Hevy error body on a non-2xx response (e.g. 404 no entry for that date) without a follow-up read", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: "No measurement found for the given date" }, 404)
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateBodyMeasurement("2026-08-01", { weightKg: 81 })).rejects.toThrow(
      /No measurement found/
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("getRoutineFolderDetail", () => {
  it("GETs /v1/routine_folders/{id} (unwrapped) and returns full detail", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.hevyapp.com/v1/routine_folders/42");
      return jsonResponse({
        id: 42,
        title: "Push Pull",
        index: 1,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getRoutineFolderDetail(42);
    expect(result).toEqual({
      id: 42,
      title: "Push Pull",
      index: 1,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    });
  });
});

describe("getExerciseHistory", () => {
  it("GETs /v1/exercise_history/{id} with no query params by default and maps every field", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.hevyapp.com/v1/exercise_history/tmpl-bench");
      return jsonResponse({
        exercise_history: [
          {
            workout_id: "workout-1",
            workout_title: "Push day",
            workout_start_time: "2026-08-01T10:00:00Z",
            workout_end_time: "2026-08-01T11:00:00Z",
            exercise_template_id: "tmpl-bench",
            weight_kg: 80,
            reps: 8,
            distance_meters: null,
            duration_seconds: null,
            rpe: 8.5,
            custom_metric: null,
            set_type: "normal",
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getExerciseHistory("tmpl-bench");
    expect(result).toEqual([
      {
        workoutId: "workout-1",
        workoutTitle: "Push day",
        workoutStartTime: "2026-08-01T10:00:00Z",
        workoutEndTime: "2026-08-01T11:00:00Z",
        setType: "normal",
        weightKg: 80,
        reps: 8,
        distanceMeters: null,
        durationSeconds: null,
        rpe: 8.5,
        customMetric: null,
      },
    ]);
  });

  it("passes startDate/endDate through as start_date/end_date query params when given", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://api.hevyapp.com/v1/exercise_history/tmpl-bench?start_date=2026-01-01T00%3A00%3A00Z&end_date=2026-12-31T23%3A59%3A59Z"
      );
      return jsonResponse({ exercise_history: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await getExerciseHistory("tmpl-bench", {
      startDate: "2026-01-01T00:00:00Z",
      endDate: "2026-12-31T23:59:59Z",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("URL-encodes an exerciseTemplateId containing special characters", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.hevyapp.com/v1/exercise_history/foo%2Fbar..");
      return jsonResponse({ exercise_history: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await getExerciseHistory("foo/bar..");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
