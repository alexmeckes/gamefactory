# Knot Theory: Eyelet to Hoist

A compact Godot 4 rope-puzzle vertical slice. Drag one continuous rope through four workshop puzzles: take up slack, thread an eyelet, make a clockwise wrap, then combine those actions to raise a shutter and ring a bell.

Controls: left mouse drags any nearby rope section; right-click a section to pin or unpin it; release the working end over the brass cleat to dock; click a docked cleat to undock; `R` resets; `Esc` returns to the title.

Sparse tactile cues are synthesized in code for grabbing, docking, release, tension, reset, and the resolving chord. Wrap recognition accepts only a single continuous annular rope interval, so separated partial turns cannot combine into a false loop.

The deterministic factory hooks report geometry-derived routing, signed winding, docking, bounded-span tautness, machine displacement, navigation, and goal transitions. Successful scenarios move the working end incrementally through the same drag function used by mouse input; they do not inject solved rope geometry. Automated evidence verifies stability and observable state transitions, not tactile feel or fun.

Open `project.godot` in Godot 4 and run the project to play. From the repository root, the original multi-agent campaign can be inspected or run with:

```powershell
npm run factory -- doctor games/knot-theory/campaign.json --config games/knot-theory/factory.config.json
npm run factory -- run games/knot-theory/campaign.json --config games/knot-theory/factory.config.json
```

`addons/gamefactory/capture_runner.gd` creates deterministic title, first-puzzle, and finale frames under `.factory/previews` for visual QA.
