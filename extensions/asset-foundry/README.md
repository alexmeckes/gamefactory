# Asset Foundry extension

This extension keeps asset generation outside the GameFactory kernel. It contributes:

- `agent:asset.command`, a modality-neutral adapter for configured generator or processor commands;
- `evaluator:asset.technical`, the first technical profile, currently implemented for RGBA PNG images;
- `evaluator:asset.style`, a deterministic style-profile gate for PNG palette, coverage, contrast, and silhouette measurements.

The command receives `GAMEFACTORY_ASSET_REQUEST`, `GAMEFACTORY_ASSET_RESULT`, and `GAMEFACTORY_CANDIDATE`. It writes the requested production file and a generator report. The foundry then creates a hashed `gamefactory.assets/v1` manifest and returns both the production asset and its evidence for content-addressed preservation.

Image inspection is dependency-free and measures dimensions, alpha, transparent corners, safe margin, opaque coverage, contrast, channel means, signal-color dominance, silhouette symmetry, and manifest integrity. Style profiles are versioned, hash their canonical references, and are copied into each generated asset's provenance manifest.

Audio, model, animation, and font evaluators should be separate lightweight extensions using the same asset brief, style-profile, and manifest contracts from `@gamefactory/asset-sdk`. Textual required and prohibited traits are intended for generator prompts and optional semantic or human judges; `asset.style` only claims the deterministic metrics it can actually measure.
