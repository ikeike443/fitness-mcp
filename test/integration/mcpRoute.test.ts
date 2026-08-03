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
  it("lists all 6 tools", async () => {
    const { json } = await callMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, AUTH_HEADER);
    const names = json.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      "get_body_measurements",
      "get_daily_macros",
      "get_nutrition_trends",
      "get_recent_workouts",
      "get_weight_trend",
      "get_workout_detail",
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
