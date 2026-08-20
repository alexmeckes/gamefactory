---
name: plan-playable-slice
description: Turn selected frozen GameSpec claims into one bounded, player-complete vertical-slice contract with real-engine evidence and narrow mutation authority. Use before implementing a slice, when replacing departmental phases, or when a slice is too broad, static, or disconnected from player decisions. Do not use to rewrite the game specification or choose final visual assets.
---

# Plan Playable Slice

Plan the smallest experience that tests the selected claims in play. Preserve creative room inside the contract.

## Establish the slice

1. Read the current frozen GameSpec revision and select the smallest coherent claim set.
2. State one player-visible outcome and one primary uncertainty the slice must retire.
3. Walk through the complete causal chain: `input -> understandable state change -> feedback -> consequence -> next decision`.
4. Include the shipping camera and input mode. Scenario automation must cross the shipping input boundary; direct helper calls, menus, debug controls, timers, narration, or test harness shortcuts cannot substitute for the promised interaction.
5. State the entry state, exit state, carried state, failure or recovery path, and explicit non-goals.
6. Keep solution space open. Specify what evidence must demonstrate, not the exact code structure, layout, art composition, or tuning values unless they are consumed claims.

## Define authority and evidence

1. Give the writer narrow `mutablePaths` and list immutable concept, spec, evidence, and accepted-slice surfaces.
2. Name deterministic real-engine scenarios that exercise meaningful alternatives, not just the happy path.
3. Require a chronological shipping-input trace, visible runtime actor displacement, spatial interaction evidence, a continuous engine capture sequence, and motion evidence when player comprehension depends on time.
4. Name every required runtime asset by consumer and state. An asset file without a live consumer is not slice evidence.
5. Define metrics as trace-derived diagnostics. Never optimize a proxy as if it proved fun.
6. Define the acceptance decision and regression evidence required after repair.

## Route failures correctly

- Use an execution retry for infrastructure or transient provider failure.
- Use a creative repair when the implementation misses a valid claim.
- Request a GameSpec amendment when real evidence falsifies or contradicts the claim itself.
- Escalate to an advisor when the distinction remains materially ambiguous after inspecting evidence.

Do not expand the slice merely because a reviewer suggests an attractive feature. Record it as an opportunity for later spec convergence.

## Output contract

Return a `sliceContract` containing `id`, `specRevision`, `claimIds`, `claimFingerprint`, `playerOutcome`, `primaryRisk`, `entryState`, `causalChain`, `alternatives`, `exitState`, `carriedState`, `failureRecovery`, `nonGoals`, `mutablePaths`, `immutablePaths`, `scenarios`, `evidence`, `runtimeAssets`, `acceptance`, `attemptPolicy`, `dependencies`, and `opportunities`.

Return `pass` only when one play session can disprove the slice's core claims. Return `revise` when the plan is a departmental deliverable, static presentation, disconnected system, or broad feature list.
