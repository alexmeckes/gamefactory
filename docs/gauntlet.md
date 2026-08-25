# Gauntlet game development

GameFactory's Gauntlet pattern turns an ambitious creative direction into bounded, evidence-backed production without confusing repeated agent activity with game quality.

## The pattern

1. Freeze a falsifiable game thesis and one player-complete slice.
2. Generate a small number of genuinely different coherent candidates in isolated workspaces.
3. Inside each candidate, fan out specialists on the decisions that benefit from independent thought.
4. Synthesize their briefs before implementation. Do not let several agents concurrently edit overlapping engine scenes and bootstrap code.
5. Give one protected integrator ownership of each candidate revision.
6. Capture fresh evidence from the real engine and shipping input boundary.
7. Run independent critics against distinct contracts: causality, comprehension, gameplay depth, motion/feel, presentation, accessibility, and technical health.
8. Give one arbiter responsibility for a short prioritized repair brief. Critics do not independently mutate the same candidate.
9. Re-run every invalidated evidence consumer after mutation. Reuse evidence only when its candidate fingerprint and protected invariants still match.
10. Stop for a human at product decisions: controls, comprehension, feel, fun, target approval when taste is unresolved, and final acceptance.

## What “harsh” means

A critic must have named dimensions, current engine artifacts, falsifiers, and authority to return `revise`. “Make it AAA” is direction, not a measurable contract. A bounded slice may be held to a professional craft bar without claiming parity with a large commercial game or looping forever.

Reference comparison is useful only when approved reference captures and the candidate are evaluated on the same declared dimensions and viewing conditions. References set a craft bar; they do not authorize copying protected content. If comparable captures are absent, the reviewer records `not_scored` instead of inventing a blind comparison.

## Durable progress and invalidation

Acceptance is layered:

- Technical evidence proves import, execution, causality, provenance, and regression health.
- Agent review can reject contract violations and identify likely comprehension or quality problems.
- Human play owns whether controls make sense, whether the loop communicates, and whether it is worth continuing.

A downstream failure invalidates only the artifacts that depend on the changed surface. A production-lighting repair must not discard an accepted gameplay checkpoint. If a reviewer finds that the accepted product thesis itself is false, it returns an explicit, evidence-backed spec amendment and starts a new gameplay revision. This preserves work without preserving invalid assumptions.

## Context discipline

Agents receive the frozen contract, a small set of current artifacts, and bounded structured handoffs. Use `inheritContext: false`, short history, capped handoffs, and explicit artifact references. Parallel specialists return attributable briefs; the synthesizer resolves contradictions; the integrator receives the synthesis rather than the entire conversation. This prevents context volume from becoming accidental authority.

## Why the writer stays singular

Parallelism belongs in exploration, asset work with disjoint ownership, evidence capture, and criticism. A Unity scene, bootstrap layer, and shared gameplay state are tightly coupled. One integrator per revision preserves coherence and makes provenance, rollback, repair, and evidence invalidation explainable. This is the practical lesson from earlier runs that lost time to overlapping write contracts, generated sidecars, stale captures, and late reviewer failures.
