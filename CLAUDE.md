@AGENTS.md

## Workflow

Propose changes via pull request (feature branch + PR), not by committing directly to `main`. Open the PR and let the user review/merge, unless they explicitly ask for a direct push.

Every time you open a PR in this repo, automatically follow up with a two-step subagent loop — don't wait to be asked:
1. Spawn a subagent to review the PR (diff + CI) and post its findings as a GitHub PR review, findings first, no inline fixing.
2. Only if that review turns up findings, spawn a second, separate subagent to address them and push the fixes to the same branch.
If the review finds nothing, stop after step 1 — no fix subagent needed.

When asked to review a PR you did not just open yourself (e.g. reviewing someone else's PR, or a plain "review PR #N" request outside this auto-loop), post the review with findings first, as a separate step from fixing them. Don't fix-then-report in the same motion — it reads as unclear/backwards about what's already done vs. still open. Wait for the user (or a follow-up instruction) before pushing fixes for what the review found.
