// End-to-end test: starts a real `next start` server and hits it over real
// HTTP. Requires `npm run build` to have been run first.
//
// This intentionally does NOT exercise real Hevy/MacroFactor data — CI has no
// real HEVY_API_KEY or GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 (this repo may be
// public), so it only verifies the protocol-level surface: the server boots,
// serves the health-check page, enforces bearer auth, and lists all tools.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PORT = 3199;
const BASE_URL = `http://localhost:${PORT}`;
const BEARER_TOKEN = "e2e-test-bearer-token";

let serverProcess;

async function waitForServer(url, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not accepting connections yet; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

before(async () => {
  const nextBin = path.join(REPO_ROOT, "node_modules", ".bin", "next");
  serverProcess = spawn(nextBin, ["start", "-p", String(PORT)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      MCP_BEARER_TOKEN: BEARER_TOKEN,
      HEVY_API_KEY: "dummy-e2e-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess.stderr.on("data", (chunk) => {
    process.stderr.write(`[next start] ${chunk}`);
  });

  await waitForServer(BASE_URL);
});

after(() => {
  serverProcess?.kill();
});

test("root page responds and identifies the server", async () => {
  const res = await fetch(BASE_URL);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /fitness-mcp/);
});

test("rejects unauthenticated MCP requests with 401", async () => {
  const res = await fetch(`${BASE_URL}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 401);
});

test("rejects requests with the wrong bearer token", async () => {
  const res = await fetch(`${BASE_URL}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer definitely-wrong",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 401);
});

test("lists all 6 tools with a valid bearer token", async () => {
  const res = await fetch(`${BASE_URL}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${BEARER_TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 200);

  const text = await res.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  assert.ok(dataLine, `expected an SSE "data:" line in response: ${text}`);
  const json = JSON.parse(dataLine.slice("data: ".length));

  const names = json.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "get_body_measurements",
    "get_daily_macros",
    "get_nutrition_trends",
    "get_recent_workouts",
    "get_weight_trend",
    "get_workout_detail",
  ]);
});
