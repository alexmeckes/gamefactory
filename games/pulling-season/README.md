# Pulling Season

Pulling Season is a Unity 6 first-person physics gardening comedy about managing three plots of oversized, temperamental produce through a three-shift season.

## Current product contract

Revision 3 preserves the embodied crop pull and adds the actual small game around it: three simultaneous turnip, beet, and long-carrot plots; limited water and loosening; growth driven by harvest order; visible traits and earned quality; stable carrying; Market versus Compost recovery; three escalating shifts; bounded upgrades; save/resume; completion; and replay.

Read [GAME_DESIGN.md](GAME_DESIGN.md) for the human-facing design and [game-spec.json](game-spec.json) for the frozen machine-readable contract. The next bounded slice is `complete-shift`.

Trusted Unity scenarios remain causal and regression evidence. They are not a substitute for a person deciding whether controls, comprehension, game feel, art direction, or fun work.

## Commands

```powershell
npm run factory -- spec validate games/pulling-season/game-spec.json --project-id pulling-season
npm run factory -- project doctor games/pulling-season/gamefactory.project.json
npm run factory -- project run games/pulling-season/gamefactory.project.json
```

The project stops for human approval after the gameplay Gauntlet and again after the production Gauntlet. See [the reusable Gauntlet contract](../../docs/gauntlet.md) for the orchestration rationale.
