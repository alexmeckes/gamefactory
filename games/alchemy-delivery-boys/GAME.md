# Alchemy Delivery Boys

## Product promise

You run a tiny village apothecary with two eager delivery boys. Villagers describe human problems, not recipe IDs. You mix an intentionally unfinished potion, choose how it travels, and use the journey itself to complete the chemistry. The road is part of the recipe.

The player should repeatedly think: **what should I put in the bottle, and what must happen to it before it arrives?**

## First playable slice

One compact workday with:

- three villagers with readable needs and personalities;
- six ingredients whose properties can be inferred through play;
- three routes with visible, predictable transformations;
- one tactile mixing interaction;
- a delivery choice between foot, bicycle, and handcart when it materially changes the mixture;
- immediate delivery outcomes and one evening consequence;
- a next-day request or relationship change caused by what actually happened.

Suggested route vocabulary: sunlight charges luminous ingredients, river chill stabilizes volatile mixtures, cobblestones aerate or agitate, hills add heat, rain dilutes, and long travel ferments. The implementation may refine this vocabulary, but every transformation must be legible before commitment and attributable afterward.

## Invariant loop

1. Read a villager's concrete problem and the relevant world conditions.
2. Choose a small combination of ingredients and manipulate the mixture.
3. Inspect the unfinished potion's observable traits; exact hidden recipes are not the point.
4. Choose a courier and route whose environmental transformations complete, preserve, or ruin it.
5. Watch the delivery resolve with clear causal feedback.
6. Deal with a specific consequence: gratitude, a side effect, a changed relationship, or a follow-up job.
7. Use what was learned to make a smarter, riskier, or kinder next delivery.

## Required first-session proof

The clean-start scenario must exercise real state transitions. It must show at least two materially different ingredient or handling decisions, a route transformation that changes potion state, a delivery outcome attributable to both mixture and route, and a reason to make another delivery. It cannot pass from timers, navigation, or hard-coded counters.

The consequence scenario must start from, or deterministically recreate, a prior delivered potion and prove that the recipient remembers the actual result. A different mixture or route must yield a counterfactual consequence.

## Falsifiers

The thesis fails if:

- the player follows exact recipe cards instead of reasoning from properties;
- the route is merely a travel-time or reward multiplier;
- brewing and delivery feel like unrelated minigames;
- outcomes are random enough that the player cannot explain them;
- the next request ignores what was delivered;
- the first five minutes contain waiting, passive playback, or excessive text before the first causal result.

## Non-goals for this slice

- a large overworld, economy, crafting tree, or ingredient grind;
- dozens of recipes or villagers;
- combat, reflex platforming, or punishing vehicle control;
- production art before the loop passes both scenarios;
- claims of fun without human playtest evidence.
