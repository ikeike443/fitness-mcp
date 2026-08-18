---
name: hevy-routine-builder
description: Use when creating, editing, or reviewing a Hevy workout routine (template) through this server's create_routine/update_routine/search_exercise_templates/list_routine_folders/get_routine_detail tools — e.g. "build me a workout plan", "put this in Hevy", "review my routine", "check my muscle-group balance". Read this before calling any of those tools: getting weight/rep selection, the pre-write confirmation step, or folder handling wrong risks writing bad data into the user's real Hevy account.
---

# Hevy Routine Builder

A standard workflow and rule set for creating/updating Hevy routines (workout plan templates) through this server's MCP tools.

## Overview

1. Check the user's actual training history (`list_workouts` / `get_workout_detail`, or `get_exercise_history` for one exercise across all past workouts) to learn real working weights for the relevant exercises.
2. Pick exercises, and resolve each one's `exerciseTemplateId` via `search_exercise_templates` — never guess an ID. If the search returns multiple plausible candidates, ask the user which one they mean.
3. Decide weight, reps, and rest time per the rules below.
4. **Before writing anything, show the full plan as a table and get explicit confirmation from the user.**
5. **Confirm the destination folder** (see "Folder handling" below).
6. Only after both are confirmed, call `create_routine` (new) or `update_routine` (overwrite) with `confirm: true`.

Do not skip steps 4–5 and set `confirm: true` regardless. This tool's `confirm` flag exists specifically so a call with `confirm: false`/omitted never touches Hevy — it returns the exact payload that *would* be sent instead, as a `dryRun: true` preview. Use that dry-run response as what you show the user in step 4, then re-call with `confirm: true` only after they say yes. This is a real write to the user's live Hevy account with no way to undo it automatically (see "Known limitations" below).

## Choosing weights (priority order)

Always prefer the user's real logged history over a computed estimate.

1. **Prefer the user's own past logs for the same exercise.** Call `get_exercise_history` (or `get_workout_detail` on a relevant recent workout) and use a recent working weight/rep/RPE combination close to what you're proposing.
2. **If there's no history for that exact exercise**, infer from a closely related exercise/movement pattern (e.g. no data for a chest-supported row variant → use their regular incline dumbbell row numbers as a starting point).
3. **If there's no history for anything closely related**, reason from a combination of nearby-muscle-group exercises the user has logged and general population norms for an intermediate lifter — and say so explicitly.

Always state your reasoning when proposing a weight (actual logged history vs. inferred, and if inferred, from what) — flag inferred/untested weights clearly (e.g. "estimated, untested") rather than presenting them with the same confidence as logged history.

## Default reps and rest time

| Exercise type | Reps | Rest |
|---|---|---|
| Isolation / high-rep, low-load | ~15 | ~1 min |
| Main compound lifts, moderate load | ~10 | ~1.5 min |
| A specific strength-goal ("PR") exercise the user has a concrete numeric target for | ~5 | ~2 min |

These are starting defaults to propose, not fixed rules — adjust based on what the user actually asks for or what their history suggests works for them.

For a PR-target exercise, a warmup-to-working-set pyramid (e.g. light warmup sets stepping up in weight, then the working weight, optionally a lighter backoff set) tends to work well. Each set in a Hevy routine can independently specify `type` (`warmup`/`normal`/`failure`/`dropset`), weight, and reps — use `type: "warmup"` for the ramp-up sets and `type: "normal"` for the working sets to represent this structure.

## Pre-write confirmation (required)

Before calling `create_routine`/`update_routine` with `confirm: true`, always present in chat:

- A full table of exercises × sets × reps × weight × rest time.
- The basis for each weight (logged history, or inferred — and from what).
- If this is an **update** to an existing routine: if you don't already know its exact current contents, call `get_routine_detail` first — `update_routine` is a full overwrite, not a patch, so anything you're not aware of gets silently discarded. This matters especially if the user may have edited the routine manually in the Hevy app since you last looked at it.

Skipping confirmation risks writing something the user didn't intend into their real Hevy account. Also don't assume a non-2xx/error response means nothing was written — always treat a write call (once `confirm: true` is set) as something that may have partially succeeded, and verify with a read (`get_routine_detail`) if there's any doubt.

## Folder handling (required)

Always confirm the destination folder explicitly:

1. Call `list_routine_folders` to get existing folders (id + title).
2. If the user named a folder, match it by title and use that `folderId`. If nothing matches, ask them.
3. If the user didn't mention a folder, ask whether it should go in no folder or a specific one — don't default silently.
4. If the folder they want doesn't exist yet, confirm with the user before calling `create_routine_folder` to make it.

**Important:** Hevy's API cannot change which folder an existing routine is filed under — `folderId` is only accepted by `create_routine`, not `update_routine`. If the user wants to move an existing routine to a different folder, tell them it requires recreating the routine in the new folder (there's no in-place move).

## Muscle-group balance check

When proposing a multi-exercise or multi-day routine, finish with a per-muscle-group weekly set-count table (e.g. chest 12, back 12, shoulders 9, biceps 6) as a sanity check. Flag any muscle group that's noticeably under-served relative to the others, and suggest an addition if appropriate.

## Saving time: supersets and giant sets

If the user wants to save time without cutting exercises, propose supersets (2 exercises back-to-back) or giant sets (3+) rather than trimming volume — compressing rest time keeps total volume while cutting session length.

**Match equipment within a superset/giant set.** Exercises grouped together should be completable without leaving one piece of equipment — same dumbbell rack, same cable station (just changing pulley height/attachment), or all-bodyweight. In a busy gym, a superset that requires moving between two separate fixed stations (e.g. barbell bench press + lat pulldown machine) usually doesn't work in practice even if it looks good on paper (e.g. antagonist-pair supersets), because someone else will be using the equipment in between. Only propose a cross-equipment pairing if the user has told you it's actually workable in their specific gym.

Represent a superset/giant set in the routine using Hevy's `supersetId` — give every exercise in the group the same superset group number.

When presenting a superset/giant-set plan, group it visually and label it clearly (e.g. "[Superset] Exercise A + Exercise B") so it reads differently from a normal sequential list. Note that the configured rest time applies after finishing one full round of the group, not between the individual exercises within it.

## Exercise selection notes

- For cable crossover-style exercises, the muscle emphasis is determined by **pulley position**, not the exercise name. A low pulley pulling upward hits the upper chest; a high pulley pulling downward hits the lower chest — judge by the actual movement path, not by whether "low" or "high" appears in the name.
- If the user's name for an exercise doesn't map cleanly to Hevy's English exercise library, infer the likely match from their logged history (weight used, frequency) and confirm with them whenever `search_exercise_templates` returns multiple plausible candidates — never silently pick one.

## Known limitations

- Hevy's public API has no `DELETE` endpoint for routines (or workouts, folders, exercise templates, or body measurements) — there is intentionally no `delete_routine` tool anywhere in this server. If a test/throwaway routine needs removing, that has to happen manually in the Hevy app.
- `update_routine` cannot change a routine's folder (see "Folder handling" above) — this is a real Hevy API limitation, not a bug in this server.
