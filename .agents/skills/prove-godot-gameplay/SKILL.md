---
name: prove-godot-gameplay
description: Implement or audit honest deterministic Godot gameplay evidence for clean-start and returning-player loops. Use when building a Godot graybox, authoring factory scenarios, repairing scenario instrumentation, or judging whether metrics derive from real player actions and state transitions. Do not use to judge visual polish.
---

# Prove Godot Gameplay

Treat the engine as the source of truth. Prove the core-game thesis through deterministic scenarios without replacing play with test-only shortcuts.

## Implement evidence paths

1. Inspect the configured Godot scenarios and upstream core-game thesis.
2. Keep clean-start and returning-player modes separate. Reset persistence for clean-start; seed only explicit returning-player prerequisites.
3. Make the factory setup entry point respect the requested scenario mode.
4. Drive the same gameplay functions used by a player. Test-only fast-forward may advance elapsed time but must not invent decisions or bypass state transitions.
5. Record a chronological trace of inputs, disclosed information, state changes, resolution events, and resulting choices.
6. Derive metrics from recorded state and trace events. Never hard-code interaction counts, completion flags, pass values, or narrative outcomes.
7. Make invalid transitions, missing causal links, engine errors, and absent metrics fail closed.
8. Emit only core artifact kinds: `image`, `video`, `audio`, `replay`, `telemetry`, `profile`, `test-report`, `log`, `build`, `crash-dump`, or `other`. Use `telemetry` for chronological gameplay traces and describe narrower semantics in the label and metadata.

## Required distinctions

- Navigation is not agency.
- Clicking, waiting, collecting, and configuring a timer are not consequential choices by themselves.
- A scenario result is not evidence unless its trace explains how the result happened.
- Offline simulation must use wall-clock semantics in normal play. Factory fast-forward must be explicit and isolated.
- Synthetic agents may test comprehension and causality; never label them human playtesters or evidence of fun.

## Review contract

For each scenario report initial state and mode, decisions and alternatives, disclosed information, causal events, carried state, metrics with trace sources, violations, engine errors, and artifact paths.

Return `pass` only when every required scenario is independently reproducible and trace-grounded. Return `revise` with the smallest gameplay or instrumentation defect and its evidence.
