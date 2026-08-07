# fitness-mcp

![CI](https://github.com/ikeike443/fitness-mcp/actions/workflows/ci.yml/badge.svg)

A personal remote MCP (Model Context Protocol) server that lets Claude read your [Hevy](https://hevy.com) workout data and [MacroFactor](https://macrofactorapp.com) nutrition data directly in conversation. Deployed on Vercel's free Hobby tier.

## License

[MIT](./LICENSE)

## Status

- **Hevy**: implemented (read-only: recent workouts, workout detail, body measurements). Uses the official Hevy REST API directly.
- **MacroFactor**: implemented, but indirectly. MacroFactor's backend enabled Firebase App Check enforcement in May 2026, which blocks all third-party API access — there is no legitimate way to pull MacroFactor data live. Instead, this server reads the Google Sheets files produced by MacroFactor's manual "Granular Export" feature, which the user saves into a "Health data" Drive folder. Every MacroFactor tool call lazily syncs any newly exported files first, so a fresh manual export becomes visible to Claude on the very next question — no separate trigger/webhook needed.

## Tools exposed

| Tool | Description |
|---|---|
| `get_recent_workouts` | List recent Hevy workouts (title, time, exercises) |
| `get_workout_detail` | Full sets/reps/weight detail for one workout |
| `get_body_measurements` | Recent Hevy body measurement entries (weight, body fat %) |
| `get_daily_macros` | Daily calories/protein/carbs/fat/steps from MacroFactor exports |
| `get_weight_trend` | Daily weight, MacroFactor's smoothed weight trend, and body fat % |
| `get_nutrition_trends` | Precomputed monthly/yearly averages and weight change (cheap — reads a precomputed rollup, not raw daily data) |

All tools are read-only.

## How the MacroFactor sync works

MacroFactor has no usable API, so data instead flows: **MacroFactor app → manual "Granular Export" → Google Drive folder "Health data" → this server reads it on demand.**

- Each export creates a new `MacroFactor-<timestamp>` Google Sheet in that folder (never overwritten). Export date ranges can overlap or have gaps — the sync does not assume the latest file has full history.
- On every MacroFactor tool call, the server checks the Drive folder for export files it hasn't processed yet, merges any new ones into a small JSON store (`Health data/_store/daily-summary.json`), and recomputes precomputed monthly/yearly rollups for just the affected periods.
- If nothing new was exported since the last call, this is a fast no-write no-op — repeated questions ("how's my year going?") don't re-scan or re-download anything.
- When two exports cover the same date, the more recently *exported* one wins (compared by the timestamp encoded in the file name), regardless of Drive's file ordering.

### Setting up Google Drive access (one-time)

This app authenticates as **your own Google account** via OAuth — not a service account. A service account was tried first and doesn't work on a personal (non-Workspace) Gmail account: service accounts have zero Drive storage quota of their own, so `files.create` (and sometimes even `files.update`) gets rejected with `Service Accounts do not have storage quota`, even when the target folder is shared with them as Editor. Shared Drives and domain-wide delegation both sidestep that, but both are Google Workspace–only features. Authenticating as the real account avoids the problem entirely — and as a bonus, there's no folder-sharing step, since the app acts as the account that already owns "Health data".

1. Create or select a Google Cloud project.
2. Enable the **Google Drive API** and **Google Sheets API** for it.
3. Create an **OAuth 2.0 Client ID** (APIs & Services → Credentials → Create Credentials → OAuth client ID) of type **Desktop app**. Desktop-app clients don't have an "Authorized redirect URIs" field in the console at all (only Web-application-type clients do) — Google accepts a loopback redirect like `http://localhost:8877` from a Desktop client automatically, with nothing to pre-register.
4. Note the generated Client ID and Client Secret.
5. **Publish the OAuth consent screen to Production**: APIs & Services → OAuth consent screen → Publish App. This matters because while the consent screen stays in the default **Testing** status, Google issues refresh tokens for sensitive/restricted scopes (like `drive`) that silently **expire after 7 days** — the exact failure this project is meant to avoid would come back every week as `invalid_grant`. For a single-user personal app like this, moving to Production does *not* require Google's full verification review; you'll just see (and have to click through) an "unverified app" warning once during the consent flow below, since `drive` is a restricted scope.
6. Run the included helper script once, locally (not on Vercel), to get a refresh token:
   ```bash
   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... \
     node scripts/get-google-refresh-token.mjs
   ```
   It prints a URL — open it, sign in with the Google account that owns "Health data", click through the "unverified app" warning, and approve. The script then prints a refresh token.
7. Set `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REFRESH_TOKEN` (see below) — with the consent screen published to Production (step 5), the refresh token doesn't expire on its own, so this is a one-time setup.

## Authentication

Claude's "Request headers" option for custom connectors (a static `Authorization: Bearer <token>` header) is still in beta and not available on every account. So this server also implements a minimal **OAuth 2.1 authorization server** (Authorization Code + PKCE) at `/api/oauth/authorize` and `/api/oauth/token`, purely so Claude's standard OAuth Client ID/Secret fields work as an always-available fallback.

There's no login screen and no client database — `/authorize` auto-approves. That's safe because the real credential check happens at `/token`: a code can only be exchanged for an access token by presenting the correct `OAUTH_CLIENT_SECRET`, which never appears in a browser-visible URL (only `client_id` does, at `/authorize`). The access token it returns is just `MCP_BEARER_TOKEN` itself, so the resource-server check (`lib/auth.ts`) doesn't change depending on which path a client used to get it. See `lib/oauth.ts` for the full reasoning, including the accepted tradeoffs (no server-side session/code storage — codes are self-contained, HMAC-signed, and expire in 60s).

### Generating the three secrets from one memorable passphrase

`MCP_BEARER_TOKEN`, `OAUTH_CLIENT_ID`, and `OAUTH_CLIENT_SECRET` can all be derived deterministically from a single master passphrase, so losing the stored values isn't a disaster — just re-derive them:

```bash
export MASTER_PASSPHRASE="<your own long, random passphrase — e.g. openssl rand -base64 24>"

derive() {
  echo -n "$1" | openssl dgst -sha256 -hmac "$MASTER_PASSPHRASE" -hex | awk '{print $2}'
}

derive "fitness-mcp:bearer-token"        # → MCP_BEARER_TOKEN
derive "fitness-mcp:oauth-client-id"     # → OAUTH_CLIENT_ID
derive "fitness-mcp:oauth-client-secret" # → OAUTH_CLIENT_SECRET
```

The label strings aren't secret (they're safe to keep in this README) — only `MASTER_PASSPHRASE` is. Running `derive` again with the same passphrase always reproduces the same values.

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

Should return the 6 tools above. A request with a missing/wrong token should get `401`.

## Testing

Three layers, all run in CI (`.github/workflows/ci.yml`) on every push/PR — none require real Hevy/Google secrets, so they work the same in a public repo:

```bash
npm run test        # unit + integration (vitest) — pure logic, plus lib/googleDrive.ts
                     # mocked with an in-memory fake Drive, plus the real Next.js
                     # route handler exercised with fetch/Drive mocked
npm run build
npm run test:e2e     # starts a real `next start` server and hits it over real HTTP
                      # (node's built-in test runner, no extra dependency)
```

- **Unit** (`lib/*.test.ts`): date parsing, MacroFactor tab parsing, monthly/yearly rollup math, bearer-token verification, OAuth code signing/PKCE/redirect-URI allowlisting (including the RFC 7636 PKCE test vector).
- **Integration** (`test/integration/*.test.ts`): the MacroFactor sync algorithm (multi-export merge, overlap resolution, incremental rollups) against `test/fixtures/fakeGoogleDrive.ts`; the real `app/api/mcp/route.ts` handler wired to real `lib/auth.ts`/`lib/hevy.ts`/`lib/macrofactorStore.ts` with only `fetch` and Drive mocked; the real `/api/oauth/authorize` and `/api/oauth/token` route handlers; and the `.well-known` OAuth metadata routes.
- **E2E** (`test/e2e/*.e2e.test.mjs`): boots the production build and asserts over real HTTP — health check, 401 on bad/missing auth, `tools/list` returns all 6 tools, OAuth discovery metadata, and a full authorization-code + PKCE round trip that ends with a working access token against `/api/mcp`. Doesn't exercise real Hevy/MacroFactor data (CI has no real credentials by design).

## Environment variables

| Variable | Purpose |
|---|---|
| `HEVY_API_KEY` | Hevy Pro API key from https://hevy.com/settings?developer |
| `MCP_BEARER_TOKEN` | Shared secret this server requires on every request, and the access_token our OAuth flow issues — see Authentication above |
| `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` | Credentials for this server's own minimal OAuth authorization server — see Authentication above |
| `OAUTH_ALLOWED_REDIRECT_HOSTS` | Optional. Comma-separated allowlist for `/api/oauth/authorize`'s `redirect_uri`. Defaults to `claude.ai,claude.com` |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REFRESH_TOKEN` | OAuth credentials for this app's Drive/Sheets access to your own Google account — see setup steps above |

Set these in the Vercel project's Environment Variables (Production + Preview). Never commit real values — `.env.example` only documents the names.

## Deploy

1. `vercel link`
2. `vercel env add HEVY_API_KEY` / `vercel env add MCP_BEARER_TOKEN` / `vercel env add OAUTH_CLIENT_ID` / `vercel env add OAUTH_CLIENT_SECRET` / `vercel env add GOOGLE_OAUTH_CLIENT_ID` / `vercel env add GOOGLE_OAUTH_CLIENT_SECRET` / `vercel env add GOOGLE_OAUTH_REFRESH_TOKEN` (repeat for each environment you use)
3. Connect this GitHub repo in the Vercel dashboard for auto-deploy on push to `main`, or run `vercel --prod` manually.
4. Note the deployed URL. `fitness-mcp.vercel.app` is often already taken by an unrelated project on Vercel's shared `.vercel.app` namespace — check the actual assigned domain under Project → Settings → Domains (or `vercel inspect <deployment-url>`). This project's production URL is `https://fitness-mcp-eight.vercel.app/api/mcp`.

## Connect to Claude

Custom connectors can only be **added** from claude.ai (web) or the desktop app — not from the mobile app. Once added there, they're usable from mobile automatically.

1. On claude.ai: Settings → Connectors → Add custom connector.
2. Name: `Fitness Data`. URL: `https://fitness-mcp-eight.vercel.app/api/mcp`.
3. If your account has the "Request headers" beta: add `Authorization: Bearer <MCP_BEARER_TOKEN>` there and skip to step 5.
4. Otherwise, open Advanced settings and fill in **OAuth Client ID** / **OAuth Client Secret** with the `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` values set in Vercel. Claude will discover the `/authorize` and `/token` endpoints automatically via this server's `.well-known` metadata.
5. Save. Claude should list the 6 tools above.

Try asking: "直近のワークアウトを教えて" (tell me about my recent workouts) or "今月の平均カロリーは?" (what's my average calorie intake this month?).
