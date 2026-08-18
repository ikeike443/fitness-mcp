# fitness-mcp

![CI](https://github.com/ikeike443/fitness-mcp/actions/workflows/ci.yml/badge.svg)

A personal remote MCP (Model Context Protocol) server that lets Claude read and manage your [Hevy](https://hevy.com) workout data directly in conversation. Deployed on Vercel's free Hobby tier.

## License

[MIT](./LICENSE)

## Contributing

Bug reports and PRs are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for the dev setup, coding conventions, and what's expected of a PR that touches a write tool.

## Status

- **Hevy**: fully implemented against Hevy's public OpenAPI spec — read: workouts (paginated list, count, change events, detail), exercise history, body measurements (recent list and full detail by date), exercise template search and detail, routine folder listing and detail, routine listing and detail, and basic account info. Write: create/update workouts (real logged training sessions), create/update routines (reusable workout plan templates), routine folders, custom exercise templates, and body measurements — so a training menu, an actual session, a brand-new exercise, or a new measurement can all be pushed directly into the Hevy app from conversation. Uses the official Hevy REST API directly. `lib/hevy/openapi-snapshot.json` is a checked-in copy of Hevy's public OpenAPI spec — every endpoint in it now has a corresponding MCP tool.

## Tools exposed

| Tool | Type | Description |
|---|---|---|
| `list_workouts` | read | List logged Hevy workouts, newest first, with real pagination (`page`/`pageSize`) |
| `get_workout_count` | read | Total number of workouts logged on the account |
| `list_workout_events` | read | Workout update/delete events since a timestamp, for tracking changes without re-fetching everything |
| `get_workout_detail` | read | Full sets/reps/weight/RPE detail for one workout |
| `create_workout` | write | Log a completed workout (an actual training session, not a template) |
| `update_workout` | write | Replace an existing logged workout's title/description/times/exercises entirely |
| `get_body_measurements` | read | Recent Hevy body measurement entries (weight, body fat % only) |
| `get_body_measurement_by_date` | read | Full body measurement entry (weight, body fat %, every tracked circumference) for one specific date |
| `create_body_measurement` | write | Log a new body measurement entry for a date that doesn't already have one |
| `update_body_measurement` | write | Replace an existing body measurement entry for a date entirely (Hevy nulls out any field you omit — not a merge) |
| `search_exercise_templates` | read | Search Hevy's exercise library by name to resolve the `exercise_template_id` needed by the create/update tools |
| `get_exercise_template_detail` | read | Full detail (type, primary/secondary muscle groups, custom or not) for one exercise template |
| `create_custom_exercise_template` | write | Create a new custom exercise template for something not already in Hevy's library |
| `get_exercise_history` | read | Every set ever logged for one exercise across past workouts, optionally date-bounded — for progression/PR questions |
| `list_routines` | read | List existing Hevy routines (id, title, folder, exercise count, updated time), optionally filtered by folder, to find a `routineId` |
| `get_routine_detail` | read | Full exercise/set/rep(-range)/weight/rest-time detail for one routine (template) — read the current contents before `update_routine` overwrites them |
| `create_routine` | write | Create a new Hevy routine (workout plan template) |
| `update_routine` | write | Replace an existing Hevy routine's title/notes/exercises entirely (folder assignment cannot be changed via update — see below) |
| `list_routine_folders` | read | List existing routine folders (id, title, index) to resolve a `folderId` by name |
| `get_routine_folder_detail` | read | Detail (title, index, created/updated timestamps) for one routine folder |
| `create_routine_folder` | write | Create a folder to organize routines |
| `get_user_info` | read | Basic info (id, display name, public profile URL) for the account `HEVY_API_KEY` belongs to |

`create_workout`/`update_workout` log or replace a real training session (what was actually done, with real start/end times and performed sets); `create_routine`/`update_routine` create or replace a reusable plan/template. Use the workout tools for "log what I just did" and the routine tools for "design a plan I can follow later."

The `write` tools make real changes to the user's Hevy account (creating/replacing workouts, routines, folders, exercise templates, and body measurements). Every write tool takes a `confirm` argument that defaults to `false`: with `confirm` false or omitted, the tool is a no-op dry run — it never calls the Hevy API, and instead returns the exact payload it would have sent, wrapped as `{ dryRun: true, payload: {...} }`. Only `confirm: true` performs the real write. Tool descriptions also instruct the calling LLM to show the user the full planned content and get explicit confirmation before setting `confirm: true` — but since that argument is set by the same LLM deciding whether to call the tool at all, this instruction is not a guarantee of human confirmation on its own; the dry-run default is what actually prevents an accidental real write regardless of what the LLM does. There is no scope separation between read and write tools at the authentication layer (see Authentication below) — any authenticated caller can invoke any tool.

### Building routines with Claude Code

[`.claude/skills/hevy-routine-builder/SKILL.md`](./.claude/skills/hevy-routine-builder/SKILL.md) is a [Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills) checked into this repo: if you fork it and use Claude Code against your fork, Claude picks this up automatically whenever you ask it to build or edit a Hevy routine through these tools. It covers picking weights from your real training history, the pre-write confirmation step, and folder handling — feel free to read it even if you're driving the tools through Claude.ai/the app instead of Claude Code, and to adapt it to your own preferences (rep/rest defaults, etc.).

## Authentication

Claude's "Request headers" option for custom connectors (a static `Authorization: Bearer <token>` header) is still in beta and not available on every account. So this server also implements a minimal **OAuth 2.1 authorization server** (Authorization Code + PKCE) at `/api/oauth/authorize` and `/api/oauth/token`, purely so Claude's standard OAuth Client ID/Secret fields work as an always-available fallback.

There's no login screen and no client database — `/authorize` auto-approves. That's safe because the real credential check happens at `/token`: a code can only be exchanged for an access token by presenting the correct `OAUTH_CLIENT_SECRET`, which never appears in a browser-visible URL (only `client_id` does, at `/authorize`). The access token it returns is just `MCP_BEARER_TOKEN` itself, so the resource-server check (`lib/auth.ts`) doesn't change depending on which path a client used to get it. See `lib/oauth.ts` for the full reasoning, including the accepted tradeoffs (no server-side session/code storage — codes are self-contained, HMAC-signed, and expire in 60s).

### Generating the three secrets from one memorable passphrase

`MCP_BEARER_TOKEN`, `OAUTH_CLIENT_ID`, and `OAUTH_CLIENT_SECRET` can all be derived deterministically from a single master passphrase, so losing the stored values isn't a disaster — just re-derive them. Paste this into a fresh terminal (it isn't installed anywhere permanent on purpose — see below) and it'll prompt for the passphrase once per session instead of making you type it into every command:

```bash
derive() {
  if [ -z "$MASTER_PASSPHRASE" ]; then
    printf "Master passphrase: "
    read -rs MASTER_PASSPHRASE
    echo
  fi
  echo -n "$1" | openssl dgst -sha256 -hmac "$MASTER_PASSPHRASE" -hex | awk '{print $2}'
}

derive "fitness-mcp:bearer-token"        # → MCP_BEARER_TOKEN
derive "fitness-mcp:oauth-client-id"     # → OAUTH_CLIENT_ID
derive "fitness-mcp:oauth-client-secret" # → OAUTH_CLIENT_SECRET
```

The label strings aren't secret (they're safe to keep in this README) — only the passphrase is. Running `derive` again with the same passphrase always reproduces the same values.

This is deliberately left as a copy-paste snippet rather than something installed into `~/.bashrc`: putting the function alone in a shell rc file is fine, but putting `export MASTER_PASSPHRASE=...` there too means the passphrase sits in plaintext on disk indefinitely — a tradeoff we're choosing not to make by default. If you don't mind that tradeoff on your own machine, adding both to `~/.bashrc` works and skips the per-session prompt entirely.

## Local development

```bash
npm install
cp .env.example .env.local   # fill in real values
vercel dev
```

Smoke test (replace `$MCP_BEARER_TOKEN`):

```bash
curl -X POST http://localhost:3000/api/mcp \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Should return the 22 tools above. A request with a missing/wrong token should get `401`.

## Testing

Three layers, all run in CI (`.github/workflows/ci.yml`) on every push/PR — none require real Hevy secrets, so they work the same in a public repo:

```bash
npm run test        # unit + integration (vitest) — pure logic, plus the real Next.js
                     # route handler exercised with fetch mocked
npm run build
npm run test:e2e     # starts a real `next start` server and hits it over real HTTP
                      # (node's built-in test runner, no extra dependency)
```

- **Unit** (`lib/*.test.ts`): bearer-token verification, OAuth code signing/PKCE/redirect-URI allowlisting (including the RFC 7636 PKCE test vector), Hevy routine/workout/exercise-template/body-measurement request-body construction and validation (`@` rejection in notes, set-type enum, rpe enum, read-only field stripping, exercise-template search caching/pagination, routine-folder listing/pagination-walk/detail read-shape, routine listing/folder-filtering/pagination-walk, routine/workout detail read-shape unwrapping, workout list/count/events pagination and response-shape assertions, custom exercise template creation response-shape coercion, body-measurement create/update tolerating Hevy's empty write response and reading back the canonical entry afterward, exercise-history field mapping and date-range query params).
- **Integration** (`test/integration/*.test.ts`): the real `app/api/mcp/route.ts` handler wired to real `lib/auth.ts`/`lib/hevy.ts` with only `fetch` mocked, including a full `search_exercise_templates` → `create_routine_folder` → `create_routine` × 3 walkthrough of a real 3-day/week training program, and that every write tool's `confirm: false`/omitted dry-run path returns the exact would-be payload without ever calling `fetch`; the real `/api/oauth/authorize` and `/api/oauth/token` route handlers; and the `.well-known` OAuth metadata routes.
- **E2E** (`test/e2e/*.e2e.test.mjs`): boots the production build and asserts over real HTTP — health check, 401 on bad/missing auth, `tools/list` returns all 22 tools, OAuth discovery metadata, and a full authorization-code + PKCE round trip that ends with a working access token against `/api/mcp`. Doesn't exercise real Hevy data (CI has no real credentials by design).

### Manually verifying Hevy write operations

CI never touches real Hevy data, so the write tools (`create_routine`, `update_routine`, `create_routine_folder`, `create_workout`, `update_workout`, `create_custom_exercise_template`, `create_body_measurement`, `update_body_measurement`) — and the read tools over the same resources — need a one-off manual check against a real Hevy Pro account after any change to them:

1. Set a real `HEVY_API_KEY` in `.env.local`, then run `vercel dev`.
2. Call `search_exercise_templates` with a real query (e.g. via the smoke-test `curl` pattern above, using `tools/call` instead of `tools/list`) and confirm real candidates come back.
3. Call `create_routine` with an obviously-throwaway title (e.g. `"fitness-mcp manual test — delete me"`) and no `confirm` (or `confirm: false`) first, and check the returned `dryRun: true` payload looks right — nothing is written yet. Then call it again with `confirm: true`, and note the returned `id`.
4. Open the Hevy app or web app and visually confirm the routine was created with the expected exercises, sets, reps, and weights.
5. Check whether the returned `webUrl` (`https://hevy.com/routines/{id}`) actually opens the routine — it's an unverified best-effort guess at Hevy's URL pattern, not a documented API field. If it doesn't resolve, that's worth a follow-up to remove or fix the field.
6. Call `get_routine_detail` with that `id` and confirm the returned exercises/sets/reps/weights match what you just created — this also confirms the `title` and `superset_id` fields actually come back on a real GET response (see the "unverified" comments on those fields in `lib/hevy.ts`). Call `list_routines` (with no `folderId`, then with the folder's id, then with `folderId: null`) and confirm the new routine shows up in the right buckets.
7. Optionally call `update_routine` against the same `id` to verify the overwrite path (note it has no `folderId` parameter — Hevy's update endpoint has no `folder_id` field at all, and sending one, even `null`, 400s, so a routine's folder can only be set at creation), and `create_routine_folder` followed by `create_routine` with its returned `folderId` to verify folder filing. Call `list_routine_folders` afterward and confirm the newly created folder shows up with a matching `id`/`title`.
8. **Delete the test routine manually in the Hevy app.** Hevy's public API has no documented `DELETE /v1/routines` endpoint, so this server cannot clean up after itself — there is intentionally no `delete_routine` tool.
9. Call `create_workout` the same way — dry run first, then `confirm: true` with an obviously-throwaway title, real `start_time`/`end_time`, and a real `exercise_template_id`. **This is the one to watch most closely**: unlike routines, `create_workout`/`update_workout` assume Hevy's OpenAPI spec is accurate about the response being a bare `Workout` object rather than wrapped like routines are (see the comment above `assertWorkoutShape` in `lib/hevy.ts`) — this has not been confirmed against a real account. If the call throws `Unexpected Hevy workout response shape`, that confirms Hevy wraps it after all and `lib/hevy.ts` needs the same kind of unwrapping `unwrapRoutineResponse` does for routines.
10. Call `get_workout_detail` with the returned `id` and confirm exercises/sets/reps/weights/RPE match, then `list_workouts` and `list_workout_events` (with a `since` before the workout's creation) and confirm it shows up in both. Optionally call `update_workout` against the same `id` to verify the overwrite path, and `get_workout_count` to sanity-check the total went up by one.
11. **Delete the test workout manually in the Hevy app** (same reasoning as step 8 — no documented delete endpoint).
12. Call `get_exercise_template_detail` with a real `exercise_template_id` (from step 2) and confirm the returned type/muscle groups match what's shown in the Hevy app.
13. Call `create_custom_exercise_template` — dry run first, then `confirm: true` with an obviously-throwaway title. **Also worth watching closely**: Hevy's spec documents the creation response as `{ id: integer }`, unlike every other `exercise_template_id` in the API (a UUID-like string) — `createCustomExerciseTemplate` in `lib/hevy.ts` coerces whatever comes back to a string, but this hasn't been confirmed against a real account. Call `get_exercise_template_detail` with the returned id and confirm it resolves and the fields match what you sent.
14. **Delete the test custom exercise manually in the Hevy app** (same reasoning as step 8 — no documented delete endpoint for exercise templates either).
15. Call `get_exercise_history` with a real `exercise_template_id` you've actually logged sets for and confirm the returned weight/reps/set type/RPE and workout id/title match your real workout history for that exercise.
16. Call `create_body_measurement` for an obviously-far-past throwaway date (so it won't collide with a real entry) — dry run first, then `confirm: true` with a weight and a couple of other fields set. **Also worth watching closely**: Hevy's spec documents no response body at all for this write (unlike every other write in this API) — `createBodyMeasurement` in `lib/hevy.ts` handles that by doing a follow-up `GET /v1/body_measurements/{date}` and returning that instead of echoing the input; confirm the tool actually returns data (not an error) and that it matches what you sent.
17. Call `get_body_measurement_by_date` with that date directly and confirm all fields match.
18. Call `update_body_measurement` against the same date, changing one field and *omitting* another field that had a value in step 16 — confirm the omitted field comes back `null`, not unchanged (Hevy replaces the whole entry on `PUT`, it does not merge).
19. **Delete the test body measurement manually in the Hevy app** (same reasoning as step 8 — no documented delete endpoint here either).
20. Call `get_routine_folder_detail` with a real folder id (from step 7, or `list_routine_folders`) and confirm the title/index/timestamps match.
21. Call `get_user_info` and confirm the returned id/name/profile URL match your account.
22. Never commit a real `HEVY_API_KEY`, and never run this check in CI.

## Environment variables

| Variable | Purpose |
|---|---|
| `HEVY_API_KEY` | Hevy Pro API key from https://hevy.com/settings?developer (read + write — workouts, routines, routine folders) |
| `MCP_BEARER_TOKEN` | Shared secret this server requires on every request, and the access_token our OAuth flow issues — see Authentication above |
| `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` | Credentials for this server's own minimal OAuth authorization server — see Authentication above |
| `OAUTH_ALLOWED_REDIRECT_HOSTS` | Optional. Comma-separated allowlist for `/api/oauth/authorize`'s `redirect_uri`. Defaults to `claude.ai,claude.com` |

Set these in the Vercel project's Environment Variables (Production + Preview). Never commit real values — `.env.example` only documents the names.

## Deploy

1. `vercel link`
2. `vercel env add HEVY_API_KEY` / `vercel env add MCP_BEARER_TOKEN` / `vercel env add OAUTH_CLIENT_ID` / `vercel env add OAUTH_CLIENT_SECRET` (repeat for each environment you use)
3. Connect this GitHub repo in the Vercel dashboard for auto-deploy on push to `main`, or run `vercel --prod` manually.
4. Note the deployed URL. `fitness-mcp.vercel.app` is often already taken by an unrelated project on Vercel's shared `.vercel.app` namespace — check the actual assigned domain under Project → Settings → Domains (or `vercel inspect <deployment-url>`). This project's production URL is `https://fitness-mcp-eight.vercel.app/api/mcp`.

## Connect to Claude

Custom connectors can only be **added** from claude.ai (web) or the desktop app — not from the mobile app. Once added there, they're usable from mobile automatically.

1. On claude.ai: Settings → Connectors → Add custom connector.
2. Name: `Fitness Data`. URL: `https://fitness-mcp-eight.vercel.app/api/mcp`.
3. If your account has the "Request headers" beta: add `Authorization: Bearer <MCP_BEARER_TOKEN>` there and skip to step 5.
4. Otherwise, open Advanced settings and fill in **OAuth Client ID** / **OAuth Client Secret** with the `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` values set in Vercel. Claude will discover the `/authorize` and `/token` endpoints automatically via this server's `.well-known` metadata.
5. Save. Claude should list the 22 tools above.

Try asking: "直近のワークアウトを教えて" (tell me about my recent workouts), or "3日/週の筋トレメニューを考えてHevyに登録して" (design a 3-day/week training menu and register it in Hevy).
