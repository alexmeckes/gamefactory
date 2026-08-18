# The Long Company

The player commands a mercenary company on a years-long overland campaign that continues while they are away. It is simultaneously an idle game and an autobattler: recruit and upgrade units by tripling, build formation synergies, then set marching orders for four to twelve hours of deterministic offline travel and combat. Absence is not a safe faucet. Named units can be wounded, earn history-specific traits, or die permanently according to the route risk the player deliberately accepted.

## Product hook

Every five-minute check-in ends on one legible decision: **which route should the company march next?**

- The coast road is safe: slow gold, few battles, low casualty pressure.
- The war-torn valley pays roughly triple and levels units quickly, but a wounded unit that loses two fights in succession dies permanently.
- Routes must expose their expected time, reward, encounter pressure, and death rule before departure. The game may add one materially distinct middle route only if it improves the decision rather than cluttering it.

Returning produces a chronological illustrated battle report, not a collect button: what happened, when it happened relative to the player's absence, who acted, why an outcome occurred, and how the roster changed. Traits must be caused by logged events. A survivor who held a bridge alone might earn `Bridgekeeper: +40% defense when no ally is adjacent`; the chronicle, roster, and simulation must agree about the cause and effect.

Death feeds the meta rather than erasing value. A fallen veteran's portrait enters the company hall and radiates a bounded fraction of earned traits to future recruits of that type. Retiring a company turns the accumulated memorial wall into the next campaign's legacy multiplier. Cautious long-lived rosters and aggressive glorious casualties must both be viable economies.

## Vertical-slice contract

Prove one complete check-in loop rather than building years of content:

1. A planning state with a small named roster, readable formation positions/synergies, wounds/traits, and route cards centered on the risk decision.
2. A deterministic march simulation that uses persisted wall-clock departure time in normal play. A normal departure must remain in progress until its disclosed four-to-twelve-hour duration has actually elapsed, whether the game stays open or is closed and reopened. Returning early shows honest partial progress and never consumes the remaining hours through frame-time playback. Only an explicit factory/test scenario may fast-forward the march; after a completed absence, the causal battle reconstruction may play quickly without changing expedition time.
3. Meaningfully different coast and valley outcomes from the same starting roster. The valley must create genuine permanent-death risk through the disclosed consecutive-loss rule, not a scripted fake choice.
4. A return chronicle with at least seven ordered events, one memorable unit-specific incident, causal trait/scar earning, rewards, and a clear summary of survivors or death.
5. A company-hall state proving that a specific dead veteran becomes a portrait with a specific inherited legacy effect.
6. A replay/reset path for evaluating both routes without deleting the production interaction.

The initial cast may be small. Aldric the pikeman is an emotional test case, not a mandated survivor: deterministic fixtures may prove both a `Bridgekeeper` survival and a memorialized death in different route/seed scenarios.

Preserve `factory_setup`, `factory_tick`, `factory_sample`, and `factory_collect`. Factory scenarios must report route, deterministic seed, encounter count, causal chronicle events, wounds, deaths, earned traits, gold/experience, and legacy effects. Engine telemetry is evidence of behavior, never evidence that the game is fun.

The chronicle and memorial must be event projections rather than separately authored stories. A memorial's decisive location, time, wound/loss chain, source trait, inherited fraction, and recipient scope must agree with the persisted event log without inference.

## Product constraints

- Premium one-price feel; no energy timers, gacha language, fake urgency, or manipulative monetization.
- Second-monitor and handheld-readable at a native 480×270 pixel canvas with integer scaling.
- Mouse-first with obvious keyboard shortcuts; a check-in should remain understandable after days away.
- Do not turn the slice into a generic wave-defense screen. The route decision, named veterans, absence, chronicle, and memorial economy are the identity.
