import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

process.env.HEVY_API_KEY = "dummy-hevy-key";

import { createRoutine, updateRoutine, createRoutineFolder } from "./hevy";
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

const routineApiResponse = {
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
});

describe("updateRoutine", () => {
  it("PUTs to /v1/routines/{routineId} with the same body shape as createRoutine", async () => {
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

describe("createRoutineFolder", () => {
  it("POSTs the correct body and returns id/title", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.hevyapp.com/v1/routine_folders");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({
        routine_folder: { title: "Cut phase" },
      });
      return jsonResponse({
        id: 42,
        title: "Cut phase",
        index: 0,
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-01T00:00:00Z",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createRoutineFolder("Cut phase");
    expect(result).toEqual({ id: 42, title: "Cut phase" });
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
