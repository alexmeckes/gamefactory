# Approved core-game handoff

Status: passed by the GameFactory core-game director in gameplay attempts v1 and v2. This file makes that accepted design decision durable across a downstream infrastructure retry; it does not claim human evidence of fun.

## Playable thesis

Each job is a deterministic prediction puzzle. A villager describes a desired human outcome and a side effect to avoid. The player chooses two ingredients and a handling method to make an intentionally unfinished potion, inspects its visible traits, then chooses a route and courier whose ordered environmental events complete it. The delivered state becomes the villager's remembered consequence.

The player must be able to explain every result as a sentence naming both mixture and journey.

## Required readable state

- The request uses ordinary human language, not a recipe name.
- Ingredient cards disclose directional properties and conditional reactions.
- The bottle exposes qualitative potion traits before commitment.
- Fold and Whisk differ mechanically; handling cannot be decorative.
- Route and courier previews disclose ordered heat, chill, exposure, settling, and agitation events.
- The journey visibly mutates the same bottle one event at a time.
- The doorstep ledger attributes the outcome to MIX, ROAD, and COURIER.
- Memory stores the exact delivered state and selects a different follow-up for a counterfactual outcome.

## Bounded workday

Use three villagers, six ingredients, three routes, and foot/bicycle/handcart courier plans. The representative clean-start job must require two meaningful ingredient decisions and a road/courier combination. The follow-up scenario must recreate or consume a prior delivery record and prove that a changed mixture or route causes a different final state, response, and next constraint.

## Evidence sequence

`request_read -> ingredient_1 -> ingredient_2 -> handling -> unfinished_inspected -> route_committed -> road_transform -> courier_transform -> delivered_state -> villager_response -> memory_write -> next_request`

Derive metrics from these real state transitions. Do not set completion flags or interaction counts directly.

## Falsifiers

- One plan dominates all requests.
- The route changes only time or reward.
- Brewing and travel can be evaluated independently.
- A counterfactual mixture, handling, route, or courier does not change the outcome.
- The follow-up ignores the stored delivery.
- The opening becomes passive, random, or recipe-card following.
