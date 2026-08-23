---
name: review-embodied-gameplay
description: Review trusted engine-recorded captures and interaction traces to determine whether shipping input drives a visible actor through a spatial world with readable causal consequences. Use after gameplay evidence capture or when a build may be a static plate, proxy interaction, or visually disconnected state machine. Do not use to judge final polish or claim that a game is fun.
---

# Review Embodied Gameplay

Judge the playable experience shown by engine evidence, not the implementation's source files, self-authored counters, concept images, or summary claims. The review is provider-neutral: a multimodal model may perform it, but the evidence and output contract control the judgment.

## Establish trustworthy evidence

Require the supplied gameplay contract and claim IDs, scenario identity, candidate or build revision, ordered engine frames, and a chronological trace of shipping input and observed state. Prefer continuous capture covering the complete interaction over selected stills.

Return `blocked` when provenance is missing, frames do not correspond to the trace, the visible player actor cannot be identified, or the evidence skips the moment needed to connect input with consequence. Do not infer embodiment from source code or candidate-authored proof claims.

## Review the embodied chain

Follow each required interaction from input to visible result:

1. Confirm normal shipping input moves a visible player-controlled actor rather than a cursor, test proxy, or automatic sequence.
2. Confirm displacement changes the actor's spatial relationship to world entities. A changing coordinate alone is insufficient.
3. Confirm interaction depends on a readable world target, range, contact, route, positioning, timing, or another spatial condition required by the contract.
4. Track relevant carried state across the interaction. The world should not silently replace the player's prior choice with an unrelated result.
5. Connect the player's action to an immediate visible consequence and then to any required outcome, reaction, or follow-up choice.
6. Compare plausible alternatives when the contract requires a decision. A decorative choice that cannot affect the outcome does not prove agency.

## Detect static-plate and proxy failures

Reject a build as non-embodied when the apparent world is primarily a fixed image while menus, hotspots, labels, counters, or invisible state changes perform the actual game. Also reject automatic traversal, direct function replay, text-only consequences, or particle-only feedback when the contract requires player-controlled movement and world interaction.

Do not reject a legitimate 2D game merely because its camera is fixed or its background is static. The controlling question is whether independently rendered actors and world entities visibly change spatial relationships and whether those changes participate in the causal interaction.

## Judge motion and comprehension

Separate causal motion from decoration. Look for readable anticipation, action, travel, impact, reaction, and recovery where the contract needs them. Ambient motion can support scene life but cannot substitute for player-caused feedback.

Report when the current player question, available target, carried state, or consequence is visually unintelligible. Do not turn optional polish, animation volume, or stylistic preference into a blocker unless it prevents a supplied claim from being observed.

## Return a claim-addressed decision

Return exactly one outcome:

- `pass`: the supplied evidence proves the required embodied chain. This does not establish fun, feel, or production quality.
- `revise`: a repairable implementation or evidence defect prevents an existing claim from being proven.
- `blocked`: missing or untrustworthy evidence prevents judgment.

Every `revise` or `blocked` result must contain at least one blocker citing an existing claim ID. If no existing claim is falsified or unverifiable, return `pass` and record the concern as an opportunity. Never invent a claim to force additional scope.

Use this structured shape:

```json
{
  "outcome": "pass | revise | blocked",
  "summary": "Concise evidence-grounded decision",
  "findings": [
    {
      "findingClass": "blocker | opportunity",
      "claimIds": ["existing.claim.id"],
      "owner": "implementation | evidence | contract",
      "issue": "Observable problem",
      "evidence": [
        {
          "artifactId": "declared artifact id",
          "timestampSeconds": 0
        }
      ],
      "playerImpact": "What the player cannot perceive or do",
      "repair": "Smallest coherent repair",
      "regressionEvidence": "Exact recapture needed to verify the repair"
    }
  ]
}
```

Use `null` rather than an invented timestamp when the evidence has no reliable time coordinate. Cite only declared artifacts.

Review one evidence bundle once. Re-review only after the candidate, build, or evidence hash changes. When embodiment passes but responsiveness, delight, difficulty, or fun remains uncertain, request a human playtest instead of manufacturing another automated defect.
