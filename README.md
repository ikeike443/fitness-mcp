# fitness-mcp

A personal remote MCP (Model Context Protocol) server that lets Claude read your [Hevy](https://hevy.com) workout data directly in conversation. Deployed on Vercel's free Hobby tier.

## Status

- **Hevy**: implemented (read-only: recent workouts, workout detail, body measurements).
- **MacroFactor**: not implemented. MacroFactor's backend enabled Firebase App Check enforcement in May 2026, which blocks all third-party API access (including the previously-working unofficial client this project was going to reuse). There is currently no legitimate way to pull MacroFactor data programmatically. See [FatSecret Platform](https://platform.fatsecret.com/) as a possible alternative nutrition tracker with a real API, if you're open to switching apps.

## Tools exposed

| Tool | Description |
|---|---|
| `get_recent_workouts` | List recent Hevy workouts (title, time, exercises) |
| `get_workout_detail` | Full sets/reps/weight detail for one workout |
| `get_body_measurements` | Recent body measurement entries (weight, body fat %) |

All tools are read-only.

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

Should return the 3 tools above. A request with a missing/wrong token should get `401`.

## Environment variables

| Variable | Purpose |
|---|---|
| `HEVY_API_KEY` | Hevy Pro API key from https://hevy.com/settings?developer |
| `MCP_BEARER_TOKEN` | Shared secret this server requires on every request. Generate with `openssl rand -hex 32` |

Set these in the Vercel project's Environment Variables (Production + Preview). Never commit real values — `.env.example` only documents the names.

## Deploy

1. `vercel link`
2. `vercel env add HEVY_API_KEY` / `vercel env add MCP_BEARER_TOKEN` (repeat for each environment you use)
3. Connect this GitHub repo in the Vercel dashboard for auto-deploy on push to `main`, or run `vercel --prod` manually.
4. Note the deployed URL, e.g. `https://fitness-mcp.vercel.app/api/mcp`.

## Connect to Claude

Custom connectors can only be **added** from claude.ai (web) or the desktop app — not from the mobile app. Once added there, they're usable from mobile automatically.

1. On claude.ai: Settings → Connectors → Add custom connector.
2. Name: `Fitness Data`. URL: `https://fitness-mcp.vercel.app/api/mcp`.
3. Under "Request headers", add `Authorization: Bearer <MCP_BEARER_TOKEN>` (the same value set in Vercel).
4. Save. Claude should list the 3 tools above.

Try asking: "直近のワークアウトを教えて" (tell me about my recent workouts).
