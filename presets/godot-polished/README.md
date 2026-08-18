# Godot polished v2 project

This preset separates mechanical proof from visual production and refuses to promote a hybrid state.

Start from `project.template.json`. Its preproduction campaign uses `converge-game-spec` to freeze only the claims required by the next slice. Each slice then receives an enforced `projectSlice` contract: consumed claims, player outcome, primary risk, non-goals, mutation paths, evidence gates, and bounded retry ownership. Runtime evidence may trigger one explicit return edge to spec convergence; ordinary implementation or presentation defects stay inside the slice repair graph.

The slice graph asks Sol/xhigh to plan a player-complete slice, then builds and repairs one graybox before giving one production-slice writer ownership of the coherent engine implementation. Fresh evidence, art direction, integration, motion choreography, and final production judgment all route concrete `revise` outcomes back to that writer. Luna/high handles bounded investigation and evidence auditing with a Sol advisor available; Sol/medium builds the graybox; Sol/high-to-xhigh owns direction, production implementation, and final judgment. Tournament support remains available as a separate, targeted campaign for a named unresolved fork; it is not the default thinking loop.

`evaluator:design.system` independently validates the candidate's `gamefactory.polish-readiness/v1` manifest. A production slice fails when a required surface is prototype, placeholder, or omitted; a runtime asset is only reference, source, extracted, or engine-ready; a required polish gate lacks pinned evidence; a blocker remains; or the claimed capture is not a hashed engine-captured production target.

Copy the templates as `gamefactory.project.json`, `concept.md`, `game-spec.json`, `spec-campaign.json`, `campaign.json`, and `factory.json`. Replace all ids and contract placeholders. Slice `mutablePaths` are mandatory and must be no broader than the campaign boundary. Evidence gates accept only references to preserved artifacts, not booleans or proxy metrics. Frozen specs are archived with SHA-256 lineage under the factory data root.
