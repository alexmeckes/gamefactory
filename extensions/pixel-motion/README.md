# Pixel Motion extension

`gamefactory.pixel-motion` is the deterministic production stage between generated motion and a Godot-ready pixel animation. It contributes:

- `agent:pixel-motion.compile`, which converts tracked PNG cutouts into palette-locked, pivot-stable pixel frames, an atlas, and a Godot `SpriteFrames` resource;
- `evaluator:pixel-motion.quality`, which fails closed on broken hashes, clipping, palette escape, anchor drift, static/chaotic motion, and poor loop closure.

The extension has no model, Python, or engine dependency. It composes with the existing optional lane rather than hiding it:

```text
video.google-omni -> sam3.track -> pixel-motion.compile -> Godot scenario -> pixel-motion.quality
```

Omni proposes motion. SAM3 preserves object identity and produces full-frame transparent cutouts. Pixel Motion selects frames, stabilizes them, downsamples them, locks them to the declared palette, and produces inspectable engine assets. Agents remain free to choose the action, timing, staging, and expressive poses; the extension enforces the production contract.

In an `agent.team` graph, a motion director or writer authors the three candidate-local request files, then ordinary `agent-driver` nodes invoke the capabilities in order:

```json
{
  "id": "compile-pixel-motion",
  "adapter": "agent-driver",
  "driver": "pixel-motion.compile",
  "role": "worker",
  "permissions": "write",
  "dependsOn": ["track-motion"],
  "artifacts": ["assets/pixel"]
}
```

The campaign activates `agent:video.google-omni`, `agent:sam3.track`, `agent:pixel-motion.compile`, and `evaluator:pixel-motion.quality`. The `godot-video-animation` preset supplies all of them lazily.

## Request

By default the compiler reads `pixel-motion.request.json` from the candidate:

```json
{
  "apiVersion": "gamefactory.pixel-motion/v1",
  "jobs": [{
    "id": "hero-repair",
    "animationName": "repair",
    "sourceDirectory": "art/tracked/hero-repair",
    "outputDirectory": "assets/pixel/hero-repair",
    "frameGlob": "*.cutout.png",
    "sourceStride": 2,
    "targetFrames": 8,
    "framesPerSecond": 8,
    "loop": true,
    "anchor": "bottom-center",
    "fit": "contain",
    "allowUpscale": false,
    "allowClipping": false,
    "alphaThreshold": 24,
    "frame": {
      "width": 48,
      "height": 48,
      "pivotX": 24,
      "pivotY": 44,
      "padding": 2
    },
    "palette": {
      "path": "art/palettes/foundry-night.json"
    }
  }]
}
```

A palette file may be either a JSON array or `{ "colors": [...] }`. Colors use `#RRGGBB`. Small experiments can put `colors` directly inside `palette`.

`contain` performs deterministic area downsampling before nearest-palette quantization. It does not enlarge small input unless `allowUpscale` is explicit. `bottom-center` is the normal character and grounded-prop anchor; `centroid` is useful for floating effects. `fit: "none"` is available for already pixel-native sources and fails if pixels leave the declared frame unless clipping is explicitly allowed.

## Outputs

Each job writes:

- `frames/0000.png` and the other normalized editable frames;
- `atlas.png`;
- `<job-id>.tres`, a Godot 4 `SpriteFrames` resource referencing the atlas through `res://`;
- `pixel-motion.json`, containing palette, hashes, frame contract, and diagnostics.

Godot scenes should use nearest texture filtering. The generated resource intentionally does not rewrite `project.godot` or engine import state; that remains under the Godot adapter and the candidate writer's authority.

## Quality gates

Campaign-level thresholds live under `parameters.pixelMotion`:

```json
{
  "pixelMotion": {
    "requestPath": "pixel-motion.request.json",
    "maximumLoopSeamError": 0.35,
    "maximumAnchorDrift": 0.02,
    "minimumTemporalChange": 0.005,
    "maximumTemporalChange": 0.85
  }
}
```

These gates measure production coherence, not whether the animation is fun. A real Godot scenario still needs to evaluate gameplay-scale readability, timing, responsiveness, collision alignment, and feel.

## Real smoke test

The repository includes a deliberately small end-to-end beetle walk-cycle test. It performs one Google Omni generation, tracks 48 frames with SAM3, compiles eight 48x48 pixel frames, evaluates them, and asks Godot to load the generated resource:

```powershell
$env:GAMEFACTORY_SAM3_PYTHON = "D:\GameFactory\runtimes\sam3\venv\Scripts\python.exe"
$env:GODOT_BINARY = "C:\path\to\godot_console.exe"
npm run smoke:pixel-motion -- "D:\GameFactory\experiments\pixel-motion-smoke-new"
```

The output directory must not already exist. The first run uses the configured `google.gemini` credential or `GEMINI_API_KEY` and may incur provider charges. To retry tracking or compilation without another generation call, point the harness at an existing MP4:

```powershell
$env:GAMEFACTORY_SMOKE_SOURCE_VIDEO = "D:\GameFactory\experiments\prior\motion\beetle-walk.mp4"
npm run smoke:pixel-motion -- "D:\GameFactory\experiments\pixel-motion-smoke-retry"
```

Each attempt remains separate and writes its request files, trace, sanitized stage reports, quality result, atlas, editable frames, and Godot resource below its own output root.
