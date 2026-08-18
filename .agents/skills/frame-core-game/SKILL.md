---
name: frame-core-game
description: Resolve a game concept into one coherent, falsifiable playable thesis before implementation. Use for new game concepts, weak or inert gameplay loops, first-session redesigns, or when an agent is offering multiple vague ideas instead of committing to a bounded core game. Do not use for visual styling or content expansion after the loop is proven.
---

# Frame Core Game

Commit to the strongest bounded interpretation of the supplied game concept. Preserve its distinctive promise; do not replace it with a safer genre default.

## Build the thesis

1. Identify the fantasy the player should feel, expressed as an observable experience rather than lore.
2. Define one repeated consequential decision. State what the player chooses, why alternatives differ, and what prevents an obvious answer.
3. Define the information available before the decision and the uncertainty the player must manage.
4. Define immediate causal feedback that lets the player attribute the result to the decision.
5. Define carried state that changes the next decision.
6. Define the reason to play another round before relying on progression, collection, timers, or narrative promises.
7. Walk through a concrete clean-start session using specific example values and outcomes.
8. State counterfactual choices and how their outcomes differ.
9. State non-goals that keep the first implementation small.
10. Write falsifiers: evidence that would prove the thesis confusing, inert, dominated, or disconnected from the larger game.

## Preserve exploration without indecision

- Resolve ordinary ambiguity with explicit assumptions.
- Record an open question only when it can materially change the thesis.
- Recommend a tournament only when one named variable has cheap, isolatable, falsifiable implementations.
- Never use a tournament for broad ideation, general polish, or "make it more fun."

## Output contract

Return a `coreGame` object containing `thesis`, `playerFantasy`, `repeatedDecision`, `information`, `uncertainty`, `causalFeedback`, `carriedState`, `nextRoundPull`, `firstSession`, `examples`, `counterfactuals`, `nonGoals`, `falsifiers`, `assumptions`, `openQuestions`, and optional `tournamentQuestion`.

Return `pass` when one thesis is concrete enough to implement and disprove. Return `revise` when it still lacks a consequential decision or causal feedback. Return `needs_advisor` only for a material capability or product contradiction.
