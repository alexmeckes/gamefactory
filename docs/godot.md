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

## Visual evidence gate

`godot.visual` turns engine-native screenshots plus a semantic critic's
structured review into a tournament gate. A candidate must provide each
configured PNG at the required dimensions, cite a concrete observation for
every view, meet the overall and per-dimension score thresholds, and return a
`pass` judgment. Optional baseline hashes prevent an unchanged prototype from
passing under a newly optimistic description.

The evaluator reads the latest structured output from
`.factory/agent-team/<experiment>/graph/<reviewNode>/attempt-*/output.json`.
Pair it with a read-only capture graph node marked `refreshAfterRepair` so
repairs regenerate frames before the visual critic runs again. Keep the
deterministic scenario evaluator as a separate gate; visual craft cannot excuse
broken game behavior, and telemetry cannot substitute for seeing the game.

```json
{
  "parameters": {
    "godot": {
      "visualReview": {
        "reviewNode": "visual-critic",
        "minimumScore": 72,
        "minimumDimensionScore": 55,
        "requiredDimensions": ["material_depth", "focal_hierarchy"],
        "requiredViews": [
          {
            "id": "title",
            "path": ".factory/previews/title.png",
            "baselineSha256": "optional-pinned-hash"
          }
        ],
        "requiredSequences": [
          {
            "id": "primary-action",
            "paths": [
              ".factory/previews/action-000.png",
              ".factory/previews/action-001.png",
              ".factory/previews/action-002.png"
            ],
            "minimumFrames": 3
          }
        ]
      }
    }
  }
}
```

Every required sequence frame must be a valid candidate-local PNG at the
configured minimum dimensions. At least `minimumFrames` frames must exist, at
least two hashes must differ, and the semantic critic must cite the sequence
with a concrete temporal observation. This proves observable state change; it
does not claim that an automated trace is human evidence of feel or fun.

The scene root may implement:

- `factory_setup(parameters)`
- `factory_tick(tick)`
- `factory_sample() -> Dictionary`
- `factory_collect() -> { metrics, violations }`

See [`examples/godot`](../examples/godot) for a complete fixture. The example
uses a trivial command agent to make the loop demonstrable without model keys.
