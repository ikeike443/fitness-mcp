import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../lib/googleDrive", () => import("../fixtures/fakeGoogleDrive"));

import { resetFakeDrive, seedExportFile } from "../fixtures/fakeGoogleDrive";
import { HEALTH_DATA_FOLDER_ID } from "../../lib/macrofactorStore";

process.env.MCP_BEARER_TOKEN = "test-bearer-token";
process.env.HEVY_API_KEY = "dummy-hevy-key";

// Imported after env vars are set, since route.ts registers tools eagerly at
// module load and the auth wrapper reads MCP_BEARER_TOKEN lazily per-request
// (so this ordering matters less for auth, but keeps things predictable).
import { POST } from "../../app/api/mcp/route";

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function callMcp(body: unknown, headers: Record<string, string> = {}) {
  const res = await POST(request(body, headers));
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  const json = dataLine ? JSON.parse(dataLine.slice("data: ".length)) : null;
  return { status: res.status, json, raw: text };
}

const AUTH_HEADER = { authorization: "Bearer test-bearer-token" };

beforeEach(() => {
  resetFakeDrive();
  vi.unstubAllGlobals();
});

describe("POST /api/mcp auth", () => {
  it("rejects requests with no Authorization header", async () => {
    const { status } = await callMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(status).toBe(401);
  });

  it("rejects requests with the wrong bearer token", async () => {
    const { status } = await callMcp(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { authorization: "Bearer wrong-token" }
    );
    expect(status).toBe(401);
  });

  it("accepts requests with the correct bearer token", async () => {
    const { status } = await callMcp(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      AUTH_HEADER
    );
    expect(status).toBe(200);
  });
});

describe("POST /api/mcp tools/list", () => {
  it("lists all 13 tools", async () => {
    const { json } = await callMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, AUTH_HEADER);
    const names = json.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      "create_routine",
      "create_routine_folder",
      "get_body_measurements",
      "get_daily_macros",
      "get_nutrition_trends",
      "get_recent_workouts",
      "get_routine_detail",
      "get_weight_trend",
      "get_workout_detail",
      "list_routine_folders",
      "list_routines",
      "search_exercise_templates",
      "update_routine",
    ]);
  });
});

describe("POST /api/mcp tools/call — Hevy (real lib/hevy.ts, fetch mocked)", () => {
  it("get_recent_workouts returns summarized workouts from the Hevy API response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toContain("api.hevyapp.com/v1/workouts");
        return new Response(
          JSON.stringify({
            page: 1,
            page_count: 1,
            workouts: [
              {
                id: "w1",
                title: "Push day",
                description: null,
                start_time: "2026-08-01T10:00:00Z",
                end_time: "2026-08-01T11:00:00Z",
                updated_at: "2026-08-01T11:00:00Z",
                created_at: "2026-08-01T11:00:00Z",
                exercises: [{ index: 0, title: "Bench Press", notes: null, exercise_template_id: "x", sets: [] }],
              },
            ],
          }),
          { status: 200 }
        );
      })
    );

    const { json } = await callMcp(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_recent_workouts", arguments: {} } },
      AUTH_HEADER
    );

    const workouts = JSON.parse(json.result.content[0].text);
    expect(workouts).toEqual([
      {
        id: "w1",
        title: "Push day",
        startTime: "2026-08-01T10:00:00Z",
        endTime: "2026-08-01T11:00:00Z",
        exerciseCount: 1,
        exercises: ["Bench Press"],
      },
    ]);
  });

  it("surfaces a Hevy API error as a tool error instead of crashing the server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 }))
    );

    const { status, json } = await callMcp(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_recent_workouts", arguments: {} } },
      AUTH_HEADER
    );

    // The HTTP transport itself should stay healthy (200) even though the
    // underlying tool call failed — MCP reports tool failures inside the
    // result payload, not as an HTTP error.
    expect(status).toBe(200);
    expect(json.result.isError).toBe(true);
  });

  it("get_body_measurements returns recent measurements from the Hevy API response", async () => {
    // Regression test: the Hevy API wraps the list under "body_measurements",
    // not "measurements" — a mismatch here previously crashed the tool with
    // "Cannot read properties of undefined (reading 'map')".
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toContain("api.hevyapp.com/v1/body_measurements");
        return new Response(
          JSON.stringify({
            page: 1,
            page_count: 1,
            body_measurements: [
              { date: "2026-08-01", weight_kg: 70.5, fat_percent: 15.2 },
            ],
          }),
          { status: 200 }
        );
      })
    );

    const { json } = await callMcp(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_body_measurements", arguments: {} } },
      AUTH_HEADER
    );

    const measurements = JSON.parse(json.result.content[0].text);
    expect(measurements).toEqual([
      { date: "2026-08-01", weightKg: 70.5, fatPercent: 15.2 },
    ]);
  });
});

describe("POST /api/mcp tools/call — Hevy routines (real lib/hevy.ts, fetch mocked)", () => {
  // lib/hevy.ts caches exercise_templates pages in module-level state (by
  // design — see lib/hevy.ts), and this test file's real route.ts import
  // means that module instance is shared across every test below. All
  // mocked exercise_templates responses in this describe block therefore
  // return this same catalog, so whichever test populates the cache first,
  // later searches in other tests still find what they're looking for.
  const EXERCISE_CATALOG = [
    {
      id: "tmpl-bench",
      title: "Bench Press (Barbell)",
      type: "weight_reps",
      primary_muscle_group: "chest",
      secondary_muscle_groups: [],
      is_custom: false,
    },
    {
      id: "tmpl-deadlift",
      title: "Deadlift (Barbell)",
      type: "weight_reps",
      primary_muscle_group: "back",
      secondary_muscle_groups: [],
      is_custom: false,
    },
    {
      id: "tmpl-legpress",
      title: "Leg Press (Machine)",
      type: "weight_reps",
      primary_muscle_group: "legs",
      secondary_muscle_groups: [],
      is_custom: false,
    },
  ];

  function exerciseTemplatesResponse() {
    return new Response(
      JSON.stringify({ page: 1, page_count: 1, exercise_templates: EXERCISE_CATALOG }),
      { status: 200 }
    );
  }

  it("search_exercise_templates returns candidates from the Hevy API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toContain("api.hevyapp.com/v1/exercise_templates");
        return exerciseTemplatesResponse();
      })
    );

    const { json } = await callMcp(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "search_exercise_templates", arguments: { query: "bench" } },
      },
      AUTH_HEADER
    );

    const results = JSON.parse(json.result.content[0].text);
    expect(results).toEqual([
      { id: "tmpl-bench", title: "Bench Press (Barbell)", muscleGroup: "chest" },
    ]);
  });

  it("create_routine is rejected before touching the Hevy API when confirm is not true", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { status, json } = await callMcp(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "create_routine",
          arguments: {
            title: "Tuesday: Back & Legs",
            exercises: [{ exerciseTemplateId: "tmpl-deadlift", sets: [{ type: "normal", reps: 5 }] }],
          },
        },
      },
      AUTH_HEADER
    );

    expect(status).toBe(200);
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(/confirm/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("create_routine POSTs the routine to Hevy and returns its id when confirmed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe("https://api.hevyapp.com/v1/routines");
        expect(init.method).toBe("POST");
        return new Response(
          JSON.stringify({
            routine: [
              {
                id: "routine-1",
                title: "Tuesday: Back & Legs",
                folder_id: null,
                notes: null,
                exercises: [],
                created_at: "2026-08-01T00:00:00Z",
                updated_at: "2026-08-01T00:00:00Z",
              },
            ],
          }),
          { status: 201 }
        );
      })
    );

    const { json } = await callMcp(
      {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: {
          name: "create_routine",
          arguments: {
            title: "Tuesday: Back & Legs",
            exercises: [{ exerciseTemplateId: "tmpl-deadlift", sets: [{ type: "normal", reps: 5 }] }],
            confirm: true,
          },
        },
      },
      AUTH_HEADER
    );

    const routine = JSON.parse(json.result.content[0].text);
    expect(routine).toEqual({
      id: "routine-1",
      title: "Tuesday: Back & Legs",
      folderId: null,
      exerciseCount: 0,
      webUrl: "https://hevy.com/routines/routine-1",
    });
  });

  it("update_routine is rejected before touching the Hevy API when confirm is not true", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { status, json } = await callMcp(
      {
        jsonrpc: "2.0",
        id: 15,
        method: "tools/call",
        params: {
          name: "update_routine",
          arguments: {
            routineId: "routine-1",
            title: "Tuesday: Back & Legs (v2)",
            exercises: [{ exerciseTemplateId: "tmpl-deadlift", sets: [{ type: "normal", reps: 4 }] }],
          },
        },
      },
      AUTH_HEADER
    );

    expect(status).toBe(200);
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(/confirm/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("update_routine PUTs to the routine's id when confirmed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe("https://api.hevyapp.com/v1/routines/routine-1");
        expect(init.method).toBe("PUT");
        return new Response(
          JSON.stringify({
            routine: [
              {
                id: "routine-1",
                title: "Tuesday: Back & Legs (v2)",
                folder_id: null,
                notes: null,
                exercises: [],
                created_at: "2026-08-01T00:00:00Z",
                updated_at: "2026-08-02T00:00:00Z",
              },
            ],
          }),
          { status: 200 }
        );
      })
    );

    const { json } = await callMcp(
      {
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: {
          name: "update_routine",
          arguments: {
            routineId: "routine-1",
            title: "Tuesday: Back & Legs (v2)",
            exercises: [{ exerciseTemplateId: "tmpl-deadlift", sets: [{ type: "normal", reps: 4 }] }],
            confirm: true,
          },
        },
      },
      AUTH_HEADER
    );

    const routine = JSON.parse(json.result.content[0].text);
    expect(routine.id).toBe("routine-1");
    expect(routine.title).toBe("Tuesday: Back & Legs (v2)");
  });

  it("list_routine_folders GETs and returns id/title/index, no confirm required", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://api.hevyapp.com/v1/routine_folders?page=1&pageSize=10"
      );
      return new Response(
        JSON.stringify({
          page: 1,
          page_count: 1,
          routine_folders: [
            { id: 7, title: "週3回メニュー", index: 0, created_at: "x", updated_at: "x" },
          ],
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { json } = await callMcp(
      {
        jsonrpc: "2.0",
        id: 15,
        method: "tools/call",
        params: { name: "list_routine_folders", arguments: {} },
      },
      AUTH_HEADER
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const folders = JSON.parse(json.result.content[0].text);
    expect(folders).toEqual([{ id: 7, title: "週3回メニュー", index: 0 }]);
  });

  it("list_routines GETs and returns id/title/folderId/exerciseCount/updatedAt, no confirm required", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.hevyapp.com/v1/routines?page=1&pageSize=10");
      return new Response(
        JSON.stringify({
          page: 1,
          page_count: 1,
          routines: [
            {
              id: "routine-1",
              title: "火曜：背中・脚",
              folder_id: 7,
              notes: null,
              exercises: [{ exercise_template_id: "tmpl-deadlift", superset_id: null, rest_seconds: null, notes: null, sets: [] }],
              created_at: "2026-08-01T00:00:00Z",
              updated_at: "2026-08-02T00:00:00Z",
            },
          ],
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { json } = await callMcp(
      {
        jsonrpc: "2.0",
        id: 17,
        method: "tools/call",
        params: { name: "list_routines", arguments: {} },
      },
      AUTH_HEADER
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const routines = JSON.parse(json.result.content[0].text);
    expect(routines).toEqual([
      {
        id: "routine-1",
        title: "火曜：背中・脚",
        folderId: 7,
        exerciseCount: 1,
        updatedAt: "2026-08-02T00:00:00Z",
      },
    ]);
  });

  it("get_routine_detail GETs /v1/routines/{id} and returns full exercise/set detail, no confirm required", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.hevyapp.com/v1/routines/routine-1");
      return new Response(
        JSON.stringify({
          routine: {
            id: "routine-1",
            title: "火曜：背中・脚",
            folder_id: 7,
            notes: null,
            exercises: [
              {
                exercise_template_id: "tmpl-deadlift",
                title: "Deadlift (Barbell)",
                superset_id: null,
                rest_seconds: 90,
                notes: null,
                sets: [
                  { type: "normal", weight_kg: 120, reps: 4, rep_range: null, distance_meters: null, duration_seconds: null },
                ],
              },
            ],
            created_at: "2026-08-01T00:00:00Z",
            updated_at: "2026-08-02T00:00:00Z",
          },
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { json } = await callMcp(
      {
        jsonrpc: "2.0",
        id: 18,
        method: "tools/call",
        params: { name: "get_routine_detail", arguments: { routineId: "routine-1" } },
      },
      AUTH_HEADER
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const routine = JSON.parse(json.result.content[0].text);
    expect(routine).toEqual({
      id: "routine-1",
      title: "火曜：背中・脚",
      folderId: 7,
      notes: null,
      exercises: [
        {
          exerciseTemplateId: "tmpl-deadlift",
          title: "Deadlift (Barbell)",
          notes: null,
          restSeconds: 90,
          supersetId: null,
          sets: [
            {
              type: "normal",
              reps: 4,
              repRange: null,
              weightKg: 120,
              distanceMeters: null,
              durationSeconds: null,
            },
          ],
        },
      ],
    });
  });

  it("create_routine_folder is rejected before touching the Hevy API when confirm is not true", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { status, json } = await callMcp(
      {
        jsonrpc: "2.0",
        id: 16,
        method: "tools/call",
        params: {
          name: "create_routine_folder",
          arguments: { title: "週3回メニュー" },
        },
      },
      AUTH_HEADER
    );

    expect(status).toBe(200);
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(/confirm/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("create_routine_folder POSTs the folder and returns its id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe("https://api.hevyapp.com/v1/routine_folders");
        expect(init.method).toBe("POST");
        return new Response(
          JSON.stringify({
            routine_folder: {
              id: 7,
              title: "週3回メニュー",
              index: 0,
              created_at: "2026-08-01T00:00:00Z",
              updated_at: "2026-08-01T00:00:00Z",
            },
          }),
          { status: 201 }
        );
      })
    );

    const { json } = await callMcp(
      {
        jsonrpc: "2.0",
        id: 14,
        method: "tools/call",
        params: { name: "create_routine_folder", arguments: { title: "週3回メニュー", confirm: true } },
      },
      AUTH_HEADER
    );

    const folder = JSON.parse(json.result.content[0].text);
    expect(folder).toEqual({ id: 7, title: "週3回メニュー" });
  });

  it("builds a full 3-day/week program: folder + search + create_routine x3", async () => {
    // Mirrors the real menu from the feature proposal: Tue (back/legs),
    // Thu (chest/shoulders/triceps), Sat (legs/shoulders/biceps/abs).
    let routineCreateCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/v1/exercise_templates")) {
          return exerciseTemplatesResponse();
        }
        if (url.endsWith("/v1/routine_folders")) {
          return new Response(
            JSON.stringify({
              routine_folder: {
                id: 99,
                title: "週3回メニュー",
                index: 0,
                created_at: "2026-08-01T00:00:00Z",
                updated_at: "2026-08-01T00:00:00Z",
              },
            }),
            { status: 201 }
          );
        }
        if (url.endsWith("/v1/routines")) {
          routineCreateCalls += 1;
          const body = JSON.parse((init!.body as string)) as {
            routine: { title: string; folder_id: number | null };
          };
          expect(body.routine.folder_id).toBe(99);
          return new Response(
            JSON.stringify({
              routine: [
                {
                  id: `routine-${routineCreateCalls}`,
                  title: body.routine.title,
                  folder_id: body.routine.folder_id,
                  notes: null,
                  exercises: [],
                  created_at: "2026-08-01T00:00:00Z",
                  updated_at: "2026-08-01T00:00:00Z",
                },
              ],
            }),
            { status: 201 }
          );
        }
        throw new Error(`unexpected fetch to ${url}`);
      })
    );

    // 1. Resolve exercise_template_ids via search.
    const { json: searchJson } = await callMcp(
      {
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: { name: "search_exercise_templates", arguments: { query: "deadlift" } },
      },
      AUTH_HEADER
    );
    const deadlift = JSON.parse(searchJson.result.content[0].text)[0];
    expect(deadlift.id).toBe("tmpl-deadlift");

    // 2. Create a folder to group the 3 days.
    const { json: folderJson } = await callMcp(
      {
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: { name: "create_routine_folder", arguments: { title: "週3回メニュー", confirm: true } },
      },
      AUTH_HEADER
    );
    const folder = JSON.parse(folderJson.result.content[0].text);
    expect(folder.id).toBe(99);

    // 3. Create the three day-routines under that folder.
    const days = [
      {
        title: "火曜：背中・脚",
        exercises: [
          {
            exerciseTemplateId: deadlift.id,
            sets: [
              { type: "warmup", reps: 5 },
              { type: "normal", reps: 4 },
              { type: "normal", reps: 4 },
              { type: "normal", reps: 3 },
            ],
          },
        ],
      },
      {
        title: "木曜：胸・肩・三頭",
        exercises: [
          {
            exerciseTemplateId: "tmpl-bench",
            sets: [
              { type: "warmup", reps: 5 },
              { type: "normal", reps: 5 },
              { type: "normal", reps: 5 },
            ],
          },
        ],
      },
      {
        title: "土曜：脚・肩・二頭・腹筋",
        exercises: [
          {
            exerciseTemplateId: "tmpl-legpress",
            sets: [
              { type: "normal", reps: 9 },
              { type: "normal", reps: 9 },
              { type: "normal", reps: 9 },
            ],
          },
        ],
      },
    ];

    for (const [i, day] of days.entries()) {
      const { json } = await callMcp(
        {
          jsonrpc: "2.0",
          id: 22 + i,
          method: "tools/call",
          params: {
            name: "create_routine",
            arguments: { ...day, folderId: folder.id, confirm: true },
          },
        },
        AUTH_HEADER
      );
      const routine = JSON.parse(json.result.content[0].text);
      expect(routine.title).toBe(day.title);
      expect(routine.folderId).toBe(99);
    }

    expect(routineCreateCalls).toBe(3);
  });
});

describe("POST /api/mcp tools/call — MacroFactor (real lib/macrofactorStore.ts, Drive mocked)", () => {
  it("get_daily_macros returns data merged from a fake Drive export", async () => {
    seedExportFile(HEALTH_DATA_FOLDER_ID, {
      name: "MacroFactor-20260801090000",
      modifiedTime: "2026-08-01T09:00:00.000Z",
      tabs: {
        "カロリー＆PFC": [
          ["日時", "カロリー（kcal ）", "脂質（g ）", "炭水化物（g ）", "たんぱく質（g ）"],
          ["2026/8/1", "2200", "60", "220", "150"],
        ],
      },
    });

    const { json } = await callMcp(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "get_daily_macros",
          arguments: { startDate: "2026-08-01", endDate: "2026-08-01" },
        },
      },
      AUTH_HEADER
    );

    const macros = JSON.parse(json.result.content[0].text);
    expect(macros).toEqual([
      { date: "2026-08-01", calories: 2200, proteinG: 150, carbsG: 220, fatG: 60, steps: undefined },
    ]);
  });
});
