---
name: audit-game-build
description: Compare real engine captures and interaction traces against approved gameplay and visual contracts. Use for final build review, visual QA, UI overlap and scaling diagnosis, motion and game-feel review, target-fidelity checks, or producing a prioritized repair brief. Do not infer quality from source files or concept art alone.
---

# Audit Game Build

Judge the running game through preserved engine evidence. Distinguish objective contract failures from subjective opportunities.

## Inspect evidence

1. Verify capture provenance, scenario identity, viewport, scale, revision, and target hash.
2. Review complete sequences rather than one flattering frame.
3. Compare the build with the selected target and required state variants.
4. Inspect traces to connect visible feedback to real state changes.

## Audit dimensions

- gameplay legibility and current player question
- focal hierarchy and primary action
- peer-region overlap, clipping, and responsive stability
- typography hierarchy, density, and sustained readability
- actor, UI, and environment scale consistency
- authored specificity versus generic procedural surfaces
- target fidelity without sacrificing runtime clarity
- ambient continuity, interaction response, gameplay consequence, and transitions
- animation identity, timing, anticipation, impact, recovery, and loop quality
- accessibility and state differentiation where required

Reject frozen scenes, ornamental motion unrelated to state, concept-art backdrops, incoherent component mixtures, hidden controls, and polish claims unsupported by runtime evidence.

## Repair brief

For each finding record severity, affected state, evidence artifact and timestamp, violated contract, player impact, smallest coherent repair, and regression evidence to capture. Group related symptoms under one root cause.

Return `pass` only when no blocker remains and required evidence is complete. Return `revise` for repairable build problems. Return `blocked` when missing or untrustworthy evidence prevents judgment.
