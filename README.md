# fitness-mcp

A personal remote MCP (Model Context Protocol) server that lets Claude read your [Hevy](https://hevy.com) workout data and [MacroFactor](https://macrofactorapp.com) nutrition data directly in conversation. Deployed on Vercel's free Hobby tier.

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

1. Create or select a Google Cloud project.
2. Enable the **Google Drive API** and **Google Sheets API** for it.
3. Create a **Service Account** (IAM & Admin → Service Accounts). No IAM roles needed.
4. Create and download a **JSON key** for the service account.
5. Base64-encode it: `base64 -w0 key.json`
6. Set the result as the `GOOGLE_SERVICE_ACCOUNT_KEY_BASE64` env var (see below).
7. In Google Drive, share the **"Health data"** folder with the service account's email (the `client_email` field in the JSON key) as **Editor** — the app creates and writes to a `_store` subfolder inside it.
8. No domain-wide delegation needed — this is a personal Gmail account, a plain folder share is enough.

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

## Environment variables

| Variable | Purpose |
|---|---|
| `HEVY_API_KEY` | Hevy Pro API key from https://hevy.com/settings?developer |
| `MCP_BEARER_TOKEN` | Shared secret this server requires on every request. Generate with `openssl rand -hex 32` |
| `GOOGLE_SERVICE_ACCOUNT_KEY_BASE64` | Base64-encoded service-account JSON key with Drive/Sheets access to the "Health data" folder — see setup steps above |

Set these in the Vercel project's Environment Variables (Production + Preview). Never commit real values — `.env.example` only documents the names.

## Deploy

1. `vercel link`
2. `vercel env add HEVY_API_KEY` / `vercel env add MCP_BEARER_TOKEN` / `vercel env add GOOGLE_SERVICE_ACCOUNT_KEY_BASE64` (repeat for each environment you use)
3. Connect this GitHub repo in the Vercel dashboard for auto-deploy on push to `main`, or run `vercel --prod` manually.
4. Note the deployed URL, e.g. `https://fitness-mcp.vercel.app/api/mcp`.

## Connect to Claude

Custom connectors can only be **added** from claude.ai (web) or the desktop app — not from the mobile app. Once added there, they're usable from mobile automatically.

1. On claude.ai: Settings → Connectors → Add custom connector.
2. Name: `Fitness Data`. URL: `https://fitness-mcp.vercel.app/api/mcp`.
3. Under "Request headers", add `Authorization: Bearer <MCP_BEARER_TOKEN>` (the same value set in Vercel).
4. Save. Claude should list the 6 tools above.

Try asking: "直近のワークアウトを教えて" (tell me about my recent workouts) or "今月の平均カロリーは?" (what's my average calorie intake this month?).
