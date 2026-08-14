# Firefly Glassworks — Workshop Carries the Rule

This candidate is a deliberately plain Godot graybox for one bounded gameplay
hypothesis: a beam-triggered latch adds a readable second routing stage when
opening it creates a visible, persistent board state that still requires
another mirror rotation. Mirrors remain the only player-controlled puzzle
instrument.

Play with the mouse, or select mirrors with the arrow keys and rotate with
Space/Enter. Press R or use the board button for a complete level reset.

The four-puzzle sequence teaches reflection, introduces the linked latch,
requires an open-then-pivot decision, and finishes with a wake/route/return
recombination. The finale permits both preparation-first and wake-first
shortest solutions; preparation is an available strategy, not a required
lesson. Factory telemetry verifies both witnesses, authored completion,
causal order, fixed-point bounds, reset restoration, and a frozen-closed
counterfactual. Those deterministic results are not human evidence of fun,
clarity, or play duration.

Run the phases from the repository root:

```powershell
node scripts/run-firefly-phases.mjs gameplay
node scripts/run-firefly-phases.mjs art-slice
node scripts/run-firefly-phases.mjs production
```

Each phase requires a clean Git worktree and must accept a real candidate
commit before the next phase can begin. This phase intentionally uses only
engine-drawn graybox geometry and system typography.
