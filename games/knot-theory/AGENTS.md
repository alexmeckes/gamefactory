# Knot Theory agent instructions

Build a compact, genuinely playable Godot 4 puzzle game around one continuous rope. The player is the tangle: direct manipulation must remain the center of every puzzle.

## Fixed product intent

- The rope is the only systemic toy. Pulling, threading, looping, pinning, tension, and topology should generate the depth.
- Teach through spatial situations and immediate feedback. Avoid long rules text and inventory-like mechanics.
- Preserve tactile clarity: grabbing, releasing, pinning, tension, crossings, success, and invalid states must all be legible.
- Deliver a complete vertical slice with a title/start state, several ordered puzzles, win feedback, progression, reset, and replay.
- Use code-native shapes, animation, particles, and synthesized audio unless the campaign explicitly supplies external assets.
- Treat the accepted `design-system.json`, `DESIGN_SYSTEM.md`, and Godot theme as the candidate's semantic design language. Refine implementations deliberately; do not silently replace tokens with one-off styling.
- Support mouse input first. Include keyboard reset and a discoverable way to advance or retry.

## Evidence contract

- Keep `factory_setup`, `factory_tick`, `factory_sample`, and `factory_collect` working for deterministic Godot evaluation.
- Automated scenarios may establish stability, interaction coverage, and goal-state transitions. They cannot prove that the rope feels good or that the puzzles are fun.
- `scenario_score` must be derived from observable simulated state, not returned as an unconditional constant.
- Return stable machine outcomes such as `pass`, `revise`, or `complete`; put nuanced prose in findings and context.

## Freedom to explore

The exact knot-recognition method, level count, visual metaphor, rope solver, target representation, and teaching order are open. Prefer a small coherent language with surprising recombination over a checklist of nautical knot names.
