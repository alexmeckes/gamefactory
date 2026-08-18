---
name: converge-game-spec
description: Evolve a game concept into a falsifiable, versioned GameFactory GameSpec without prematurely fixing the creative solution. Use for initial preproduction, spec critique, synthetic playtraces, evidence-driven amendments between vertical slices, or deciding whether a failed slice needs implementation repair versus a product-level change. Do not use to implement a slice or polish its presentation.
---

# Converge Game Spec

Preserve the supplied concept as the product boundary. Stabilize only what the next playable slice needs; leave implementation choices open unless evidence makes them product requirements.

## Separate certainty levels

1. Record hard user constraints verbatim.
2. Express the playable thesis as a small set of stable, falsifiable claim IDs.
3. Mark provisional beliefs as assumptions rather than silently upgrading them to requirements.
4. Keep attractive additions as opportunities. Do not let them block the next slice.
5. Describe required player outcomes, causal relationships, and experience qualities without prescribing layouts, algorithms, assets, content quantities, or a single implementation.
6. Preserve alternative solutions wherever the specification's falsifiers can judge them equally.

## Converge an initial revision

1. Use `frame-core-game` to establish one concrete repeated decision and feedback loop.
2. Draft a `gamefactory.game-spec/v1` document with stable claim IDs, falsifiers, assumptions, decisions, and dependency-ordered slice plans.
3. Run bounded specialist critiques and explicitly synthetic playtraces against the claims.
4. Classify findings as `blocker`, `assumption-risk`, or `opportunity`. Only blockers contradict an existing required claim or make the next slice untestable.
5. Let critics propose changes; let only the spec owner edit the specification.
6. Freeze after at most the configured convergence passes when the next slice is coherent and falsifiable. Do not wait to answer every future content or presentation question.

## Evolve from evidence

Treat `frozen` as a slice boundary lock, not a permanent design freeze.

1. Keep claims consumed by an active slice stable during that slice's execution.
2. Open an amendment between slice attempts only from new evidence: a triggered falsifier, engine trace, runtime capture, feasibility result, repeated synthetic-playtest finding, or direct user direction.
3. Prefer repairing the implementation when the build failed to satisfy a still-sound claim.
4. Amend the specification when the claim itself is wrong, incomplete, contradictory, or needlessly constraining.
5. Before editing, write an impact proposal containing the trigger, evidence, affected claims, affected slices, alternatives considered, and recommended change.
6. Increment the revision, retain stable claim IDs for the same semantic contract, include `supersedes`, and record change rationale and evidence. Add a new claim ID for a distinct contract; never repurpose an unrelated ID.
7. Re-run only slices whose consumed claim fingerprints or implementation dependencies changed. Preserve unrelated accepted work.
8. Reject speculative churn, preference-only rewrites, and full-spec regeneration when a local amendment is sufficient.

## Output contract

Return the complete GameSpec plus a `specReview` object containing `mode` (`initial` or `amendment`), `pass`, `findings`, `assumptions`, `opportunities`, `evidenceRefs`, `affectedClaims`, `affectedSlices`, `reusableSlices`, and `nextSlice`.

Return `pass` when the next slice is bounded and falsifiable. Return `revise` for claim-linked blockers. Return `needs_advisor` only for a material product contradiction or capability decision.
