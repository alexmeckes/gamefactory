# Godot workflow

Copy [`bridges/godot/addons/gamefactory`](../bridges/godot/addons/gamefactory)
into the target Godot 4 project. Then load the Godot and workflow extensions in
`factory.config.json` and request `evaluator:godot.scenario` in the campaign.

The evaluation waterfall is:

1. `godot --headless --editor --quit` catches import and script errors.
2. The host runs `scenario_runner.gd` with an absolute request/output path.
3. The bridge loads the requested scene, seeds randomness, advances fixed ticks,
   calls optional `factory_*` hooks, and writes telemetry plus `result.json`.
4. The evaluator normalizes that result for the workflow.

Set `parameters.godot.rendered` to `true` and provide `capture_ticks` only when
visual evidence is useful. Logic, simulation, regression, and performance runs
stay headless. Browser capture is unrelated to this path.

The scene root may implement:

- `factory_setup(parameters)`
- `factory_tick(tick)`
- `factory_sample() -> Dictionary`
- `factory_collect() -> { metrics, violations }`

See [`examples/godot`](../examples/godot) for a complete fixture. The example
uses a trivial command agent to make the loop demonstrable without model keys.
