---
name: choreograph-game-motion
description: Design, implement, and verify state-linked gameplay motion for a playable slice, including animation graphs, feedback timing, ambient continuity, transitions, camera, effects, and audio synchronization. Use when a game feels frozen, generated animation needs runtime choreography, or motion must communicate decisions and consequences. Do not use to add decorative loops to an unproven gameplay interaction.
---

# Choreograph Game Motion

Use motion to explain state, agency, consequence, and character. Prefer a few authored beats with clear purpose over animation quotas or constant noise.

## Build the motion grammar

1. Read the slice causal chain, scene target, component states, input mode, and performance constraints.
2. Inventory moments where the player needs temporal information: affordance, anticipation, commitment, impact, reaction, recovery, persistence, and transition.
3. Define shared timing, easing, exaggeration, camera, effects, and audio principles that fit the visual direction.
4. Distinguish gameplay-critical motion, interaction response, ambient continuity, and transition motion. Give each a state owner and interruption policy.

## Author the sequence

1. Create state graphs for relevant actors and interface components, including entry, exit, cancel, overlap, and fallback behavior.
2. Preserve readable silhouettes, pivots, contact points, frame cadence, and identity across source generation, segmentation, tracking, compilation, and engine playback.
3. Use anticipation and recovery only where they improve attribution or feel. Keep controls responsive and do not hide state changes behind spectacle.
4. Synchronize VFX, camera, hit-stop, screen response, and audio to real gameplay events rather than independent timers.
5. Add ambient motion that expresses world state without competing with the current decision.
6. Keep provider choices behind adapters. Omni, SAM3, pixel-motion, hand-authored frames, or engine-native tweening are production methods, not the contract.

## Verify through play

1. Capture the full interaction at shipping speed, plus slow inspection only when needed for diagnosis.
2. Verify anticipation, action, impact, reaction, recovery, interruption, repeated-loop seams, and transition continuity.
3. Compare motion against interaction traces so visible beats correspond to actual state changes.
4. Check responsiveness, clarity under repeated input, reduced-motion behavior when required, and performance at shipping scale.
5. Reject frozen tableaux, unrelated looping noise, duplicated effects, timing drift, animation that lies about state, and polish claims based only on source video.

## Output contract

Return a `motionReport` containing `specRevision`, `sliceId`, `motionGrammar`, `stateGraphs`, `eventBindings`, `timings`, `interruptions`, `ambientContinuity`, `transitions`, `providerProvenance`, `captures`, `traceLinks`, `violations`, and `regressionChecks`.

Return `pass` only when required motion is live, state-linked, readable, and evidenced in the engine. Return `revise` with a prioritized causal repair rather than a request for more animation generally.
