# Wickward

A one-swap fantasy autobattler production slice. Arrange three candle guardians, then watch them hold the line against a night-moth swarm.

> Historical example: Wickward predates the `godot-polished` project preset and is not a preset-conformance fixture. Its manifest intentionally records the seven gates that were actually run; it does not claim the later scene-target, layout-integrity, typography-system, component-fidelity, or scene-life approvals. Use `presets/godot-polished` for the current production contract.

- Click one guardian and then another to swap them.
- Rear gains power, center grants haste, and front protects the whole formation.
- Press Space or click **Light the Line** to start the automatic battle.
- Press R to reset.

The six runtime characters are generated-source assets extracted with SAM3 and deterministically normalized to a shared 16-color palette at 64×64. The two referenced source sheets remain under `design/` for reproducibility; the unreferenced v1 UI sheet and dead runtime lane were removed. The game loads only `assets/runtime/`.

Combat uses a code-native whole-pixel motion system over those authored sprites: anticipation and lunges, recoil and squash, curved projectile trails, delayed impacts, hit-stop, formation links, Warden blocks, Seer chain arcs, Chime pulses, animated defeats, and a staged result reveal. The captured runtime sequence is `evidence/captures/wickward-motion.mp4`.
