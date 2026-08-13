# Emberline agent instructions

Build a compact, genuinely playable Godot 4 tower-defense game around a living
fuse, three readable workshop instruments, and composable heat reactions.

## Fixed product intent

- Strategy comes from placement, economy, reaction order, wave composition,
  and at least one meaningful opportunity to adapt—not tower quantity.
- Deliver a complete title, onboarding, four-or-more-wave run, boss, victory,
  defeat, reset, and replay loop.
- Preserve engine-native deterministic hooks: `factory_setup`, `factory_tick`,
  `factory_sample`, and `factory_collect`.
- Use actual simulated state for metrics. Never return an unconditional quality
  score or label automated telemetry as human evidence of fun.
- Mouse is primary. Make pause, speed, wave start, tower selection, upgrade or
  sell, and restart discoverable if those mechanics exist.
- Treat an accepted `design-system.json`, `DESIGN_SYSTEM.md`, and Godot theme as
  the semantic design language. Do not silently drift into one-off styling.
- Use code-native Godot rendering or project-bound generated assets. Keep
  external credentials out of the candidate and trace.

## Freedom to explore

The final board metaphor, enemy taxonomy, exact heat grammar, progression,
route, balance, and animation language remain open. Prefer a small surprising
system with strong feedback over a broad checklist of familiar tower-defense
features.

