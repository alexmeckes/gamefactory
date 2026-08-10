# Godot bridge

Copy `addons/gamefactory` into a Godot 4 project. The host extension invokes
`scenario_runner.gd` directly, so enabling the editor plugin is optional.

A scenario scene can implement any of these methods on its root node:

- `factory_setup(parameters)` — apply seed/configuration before simulation.
- `factory_tick(tick)` — inject deterministic actions before each physics tick.
- `factory_sample()` — return per-tick telemetry fields.
- `factory_collect()` — return `{ "metrics": {}, "violations": [] }`.

The request body stays owned by this bridge. The core sees only the versioned
scenario reference and engine-neutral artifacts.
