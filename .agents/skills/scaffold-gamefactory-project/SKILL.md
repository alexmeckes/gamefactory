---
name: scaffold-gamefactory-project
description: Turn a game concept into a versioned, engine-neutral GameFactory v2 project with bounded spec convergence, claim-addressed vertical slices, campaign routing, evidence gates, and optional targeted experiments. Use when starting a game, migrating an ad hoc prototype, or revising project orchestration. Do not use to implement the game itself.
---

# Scaffold GameFactory Project

Create a small project contract that preserves creative room while making product decisions, slice boundaries, and runtime evidence explicit.

## Establish inputs

1. Preserve the supplied concept verbatim as the product boundary.
2. Ask only pointed multiple-choice questions that materially alter production. Include `figure-it-out` for every question and pass delegated choices to the core-game director.
3. Identify engine, target platform, session shape, visual constraints, persistence needs, and hard exclusions.
4. Record assumptions instead of blocking on choices a bounded design agent can safely make.

## Converge the game specification

Create a preproduction campaign that preserves the original concept verbatim and produces `gamefactory.game-spec/v1`.

1. Let a spec owner draft one falsifiable playable thesis with stable claim IDs.
2. Use bounded specialist critique and explicitly synthetic playtraces to probe agency, counterfactuals, spatial interaction, progression, scope, and technical feasibility.
3. Classify violations of existing claims as blockers and new ideas as opportunities. Critics propose; only the spec owner amends.
4. Resolve contradictions and freeze the spec after at most three convergence passes by default. Block only when claims consumed by the next slice remain open; future claims and questions may remain explicitly provisional. Treat the freeze as a lock for the next slice, not a lifetime revision ceiling. Later engine or playtest evidence may open a claim-addressed amendment between slice attempts.

Record the player actor, camera, controls, world model, verbs, state transitions, first-session loop, consequences, continuation, visual and motion thesis, technical assumptions, exclusions, falsifiers, and planned slices. Describe outcomes and risks without prescribing the creative solution.

Use stable claim IDs and separate hard constraints, assumptions, and opportunities. When evidence invalidates a claim, increment the GameSpec revision, record `supersedes` and change evidence, and rerun only slices whose consumed claim fingerprints or implementation dependencies changed.

## Create vertical slices

Break implementation into the smallest dependency-ordered slices that each deliver a complete player experience:

`input -> understandable state change -> feedback -> consequence -> another decision`

For every slice, declare:

- consumed spec claim IDs;
- one player-visible outcome and one primary risk;
- dependencies, non-goals, and narrow mutable paths;
- named real-engine scenarios, interaction traces, captures, and motion evidence;
- separate execution retry, creative repair, spec amendment, and advisor escalation policies;
- one accepted revision before dependent slices advance.

Do not create departmental phases such as all gameplay followed by all art. A slice may use design or asset specialists, but reference-only images, asset batches, UI screens, back-end systems, or animation reels are not independently acceptable slices. Require generated assets to name a runtime consumer and appear in a current engine capture.

Add a tournament or discovery phase only for a named unresolved question with isolated, cheap, falsifiable candidates. State the variable, hypotheses, shared baseline, evaluator, and stopping rule.

## Configure orchestration

- Route Sol/xhigh to core synthesis, screen selection, and final judgment.
- Route Sol/medium-to-high to implementation.
- Route Luna/high to bounded scouting and criticism with explicit Sol advisor escalation.
- Bind only the skills each node needs.
- Keep threads ephemeral unless evidence requires retention.
- Use budgets as safety limits, not design goals.
- Keep engine, asset provider, and UI behavior behind extensions.
- Give nodes explicit authority: observe, propose, mutate-candidate, mutate-spec, or approve.
- Require blocker findings to cite existing claim IDs. Route new scope to the spec owner as a non-blocking opportunity.
- Require every review to apply to the current writer generation; mutations invalidate dependent evidence and judgments automatically.
- Bind `converge-game-spec` to the spec owner, `plan-playable-slice` to slice planning, and add `integrate-game-assets` and `choreograph-game-motion` only after their upstream target or gameplay contracts exist.

## Write and validate

Create or update the immutable concept, `GAME_SPEC.json`, `gamefactory.project.json`, slice campaigns, and factory configurations from the closest maintained preset. Prefer `gamefactory.dev/v2`; retain v1 only for explicit legacy compatibility. Use `preproduction.maximumConvergencePasses` for each bounded convergence episode; do not cap the lifetime GameSpec revision number. Narrow mutable paths. Require durable traces, accepted revisions, named scenarios, and runtime evidence. Run manifest/spec validation, build/tests, and project doctor before execution.

Return the current spec revision, amendment policy, slice graph, assumptions, delegated questions, selected skills, expected evidence, and any explicit tournament escape hatch.
