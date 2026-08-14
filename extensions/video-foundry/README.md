# Video foundry

Optional creative animation tooling, kept outside the factory core.

- `agent:video.google-omni` turns text/reference images into short MP4 studies using Google Gemini Omni.
- `agent:animation.compile` packs SAM3-produced transparent PNG frames into a sprite atlas and records temporal diagnostics.

Store the provider credential with `gamefactory credentials set google.gemini`, or use `GEMINI_API_KEY`. Only the credential name and resolution source are recorded. The value is never written into a candidate, prompt, result, or trace.

See `docs/video-animation-pipeline.md` for request contracts and graph wiring.
