# Contributing to hevy-fitness-mcp

Thanks for considering a contribution. This is a small, personal-deploy MCP server (fork it, point it at your own Hevy account, deploy your own copy — see the README) rather than a hosted multi-tenant service, so the bar for contributions is "does this make the codebase better for people running their own fork," not "does this need to work for a shared production fleet."

## Before you start

- **Check `lib/hevy/openapi-snapshot.json` first.** It's a checked-in copy of Hevy's public OpenAPI spec and is the source of truth for what Hevy's API actually looks like — endpoint paths, request/response shapes, field names. If you're adding or changing a tool, confirm the shape against this file before writing code, not against assumptions or memory of the API.
- **Search for existing issues/PRs** covering the same tool or endpoint before starting, to avoid duplicate work.
- **For anything beyond a small fix**, open an issue first describing what you want to change and why, before investing time in a PR. This is especially true for anything touching the write-tool `confirm` dry-run pattern (see below) or the OAuth implementation (`lib/oauth.ts`) — both have non-obvious design constraints explained in code comments that are easy to accidentally regress.

## Reporting issues

Good bug reports include:
- Which tool (e.g. `create_routine`), and the exact arguments you called it with (redact your `HEVY_API_KEY` and any personal data if you paste a request/response).
- What you expected vs. what actually happened — for a Hevy API mismatch, the raw error message from `lib/hevy.ts`'s thrown `Error` is usually the most useful thing to include, since it includes the raw Hevy response body.
- Whether the affected tool is read-only or a write tool. Write-tool bugs are higher priority given the real-account-write risk described below.

## Development setup

```bash
npm install
cp .env.example .env.local   # fill in values — see README's "Local development" section
vercel dev
```

See the README's **Local development**, **Testing**, and **Environment variables** sections for the full setup and the `derive()` recipe for generating the three secrets from one passphrase.

## Making changes

### Coding conventions

- Follow the existing style in the file you're editing rather than introducing a new pattern — this codebase favors explicit field-by-field mapping (never spreading raw caller input into a Hevy request body) and explaining *why*, not just *what*, in comments near non-obvious decisions (e.g. see `lib/hevy.ts`'s comments on `unwrapRoutineResponse`, `assertWorkoutShape`).
- `lib/hevy.ts` is the single Hevy API client. Snake_case Hevy field names get mapped to camelCase at the boundary of every function that returns data to the MCP layer — keep new code consistent with that.
- Every write tool follows the same `confirm: boolean` dry-run pattern (see `app/api/mcp/route.ts`'s `confirmSchema` and `dryRunPreview`): `confirm` defaults to `false`/omitted, in which case the tool must return the exact payload it *would* send instead of calling Hevy, and only `confirm: true` performs the real write. If you add a new write tool, reuse this exact pattern — don't invent a new confirmation mechanism.
- Run `npm run lint` and `npx tsc --noEmit` before opening a PR; both run in CI and block merge.

### Adding a new Hevy endpoint / tool

1. Confirm the endpoint's request/response shape against `lib/hevy/openapi-snapshot.json` (see above).
2. Add the client function(s) to `lib/hevy.ts`. For a write endpoint, export a `toXBody(input)` function separately from the function that performs the actual write, so the MCP layer can reuse it for the dry-run preview (see `toCreateRoutineBody`/`createRoutine` as the reference pair).
3. Register the tool in `app/api/mcp/route.ts` with a Zod `inputSchema` and a clear `description` — see existing tools for the level of detail expected (what the tool does, any Hevy-side quirks/limitations, and for write tools, an explicit statement that it's a real write once `confirm: true`).
4. Add tests at all three layers your change touches — see **Testing** below.
5. Update the README's tool table and tool count (search the repo for the current count, e.g. `grep -rn "22 tools"`, and update every occurrence — README, `test/integration/mcpRoute.test.ts`, `test/e2e/mcp.e2e.test.mjs`).

## Testing

This repo uses three layers — see the README's **Testing** section for exactly what each layer covers and why. In short:

```bash
npm run test        # unit (lib/*.test.ts) + integration (test/integration/*.test.ts)
npm run build
npm run test:e2e     # test/e2e/*.e2e.test.mjs — real HTTP against a real `next start` server
```

None of these three layers touch a real Hevy account — everything is mocked via `fetch`. That's intentional: this repo has no shared Hevy test account, and CI runs on every PR from a public repo, so it must never require real credentials.

**If your change touches a write tool** (`create_*`/`update_*`), you additionally need to manually verify it against your own real Hevy Pro account before it can be considered done — automated tests alone aren't enough for write paths given Hevy's API has already shown real-world surprises (undocumented response wrapping, no delete endpoints, etc.) that only show up against the live API. Follow the README's **"Manually verifying Hevy write operations"** checklist, and update that checklist with a new step if you're adding a new write tool.

Match the existing test style closely rather than introducing new patterns — see `lib/hevy.test.ts` and `test/integration/mcpRoute.test.ts` for the established conventions (a shared `jsonResponse`/`emptyResponse` helper, dry-run and confirmed-write test pairs for every write tool, explicit request-body assertions rather than loose partial matches).

## Opening a pull request

- Branch off `main`; don't commit directly to it.
- Keep PRs scoped to one logical change (one new tool, one bug fix) — this makes review and, if needed, revert much easier. Large multi-tool PRs are harder to review carefully given the real-account-write risk.
- Fill in what changed and why. If your change affects a write tool's request/response shape, call out explicitly whether you've verified it against a real Hevy account or whether that's still outstanding.
- CI (lint, typecheck, unit/integration tests, build, e2e) must pass before merge.

## A note on the write-tool safety design

Two things work together to keep write tools from silently corrupting real Hevy data — both are considered part of this project's core design, not incidental details:

1. The `confirm: boolean` dry-run default described above, enforced in code.
2. Guidance for the *calling* LLM to show the user the full planned content and get explicit approval before ever setting `confirm: true` — see `.claude/skills/hevy-routine-builder/SKILL.md` for the detailed workflow this project follows when building/editing Hevy routines through these tools, which you're welcome to adapt for other write tools or your own workflow.

If you're changing anything related to either of these, please call it out explicitly in your PR description — this is the one area of the codebase where a subtle regression has real, hard-to-undo consequences (Hevy's API has no delete endpoints for any resource this server can create).
