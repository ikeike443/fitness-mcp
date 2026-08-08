import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

process.env.HEVY_API_KEY = "dummy-hevy-key";

import {
  createRoutine,
  updateRoutine,
  createRoutineFolder,
  listRoutineFolders,
  listRoutines,
  getRoutineDetail,
} from "./hevy";
import type { CreateRoutineInput } from "./hevy";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
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
