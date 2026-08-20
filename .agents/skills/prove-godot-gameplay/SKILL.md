---
name: prove-godot-gameplay
description: Implement or audit honest deterministic Godot gameplay evidence for clean-start and returning-player loops. Use when building an embodied Godot prototype, authoring factory scenarios, repairing scenario instrumentation, or judging whether metrics derive from real shipping input, visible runtime action, and state transitions. Do not use to judge visual polish.
---

# Prove Godot Gameplay

Treat the engine as the source of truth. Prove the core-game thesis through deterministic scenarios without replacing play with test-only shortcuts.

## Implement evidence paths

1. Inspect the configured Godot scenarios and upstream core-game thesis.
2. Keep clean-start and returning-player modes separate. Reset persistence for clean-start; seed only explicit returning-player prerequisites.
3. Make normal runtime startup respect the requested scenario mode without adding test-only movement, interaction, or resolution methods.
4. Configure `parameters.godot.embodiedProbe` (or a scenario-level override) with the visible actor node path, real `InputMap` steps, interaction target and range, and an observable consequence property. Keep this declaration small and game-specific.
5. Let the factory-owned Godot probe inject `InputEventAction` instances through `Input.parse_input_event`. Normal `_input`, `_unhandled_input`, and physics processing must drive the game. Do not create a candidate-owned proof runner or trace.
6. The external probe records `gamefactory.embodied-trace/v1`: chronological shipping input delivery, visible player-actor identity and position, measured spatial interaction, player-caused state changes, and continuous engine frames.
7. Derive metrics from probe-observed state and trace events. Never hard-code interaction counts, completion flags, pass values, or narrative outcomes.
8. Make invalid transitions, missing causal links, engine errors, absent nodes or actions, and absent metrics fail closed.
9. Keep richer game-specific telemetry optional. It cannot replace the factory-owned trace or its continuous captures.

## Required distinctions

- Navigation is not agency.
- Clicking, waiting, collecting, and configuring a timer are not consequential choices by themselves.
- A candidate-authored scenario result is not embodied evidence. Only the factory-owned probe can certify the embodied trace.
- A direct function replay is not shipping-input evidence, even when it reaches the same functions eventually used by the player.
- A changing coordinate is not movement evidence unless a visible runtime actor changes position in continuous engine captures.
- Text, timers, particle-only changes, or a static background do not prove embodied action.
- Offline simulation must use wall-clock semantics in normal play. Factory fast-forward must be explicit and isolated.
- Synthetic agents may test comprehension and causality; never label them human playtesters or evidence of fun.

## Review contract

For each scenario report initial state and mode, input-delivery method, visible player actor, measured displacement, spatial interactions, decisions and alternatives, disclosed information, player-caused state changes, carried state, metrics with trace sources, continuous captures, violations, engine errors, and artifact paths.

Return `pass` only when every required scenario is independently reproducible and trace-grounded. Return `revise` with the smallest gameplay or instrumentation defect and its evidence.
