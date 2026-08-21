# Alchemy Delivery Boys — production boundary

The authoritative concept is preserved verbatim in `concept.md`; the frozen claims and slice contract live in `game-spec.json`. Production must improve the accepted playable loop rather than replace it.

## Product promise

The player is a small courier-alchemist in a living place: choose and brew a mixture, physically carry it through a route that changes it, deliver it to a villager, read the villager's attributable reaction, and make an informed next choice.

## Accepted core

- Godot desktop game with direct movement and interaction controls.
- A compact, navigable workshop-and-garden encounter.
- Brewing, route traversal, delivery, reaction, and follow-up choice share one persistent potion state.
- The factory-owned `first-session` scenario is the behavioral floor; production may not replace it with menus, automatic travel, static plates, or proxy counters.
- Production targets one coherent encounter, not a large recipe catalog or village simulation.

## Hard exclusions

- No sequence of mostly static illustrated panels.
- No recipe menu followed by automatic travel.
- No generated whole-screen image used as the runtime world.
- No procedural placeholder geometry, text glyph, or default control presented as finished art.
- No evidence counters, self-authored quality scores, or concept art described as a playable build.

## Delegated production decisions

The production team owns the exact pixel-art direction, palette, typography by information role, sprite treatment, animation cadence, environmental detail, and UI surface design. Those choices must be reviewed first as coherent whole-screen targets, decomposed into independently animatable assets, and verified again inside the live Godot scene.
