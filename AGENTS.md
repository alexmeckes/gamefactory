# GameFactory agent instructions

GameFactory is an engine-neutral experimentation system. Keep the core small; put engine, model-provider, asset, workflow, and UI behavior behind extensions or adapters.

## Operating principles

- Treat campaign objectives as direction, not as permission to optimize a visible metric blindly.
- Respect `mutablePaths` and `immutablePaths` exactly. A candidate may only change the surface granted to it.
- Preserve room for exploration. State a hypothesis and assumptions, then choose a bounded approach; do not turn role guidance into a predetermined solution.
- Prefer evidence from the real engine, deterministic scenarios, tests, and preserved artifacts. Never describe synthetic playtests or proxy scores as human evidence of fun.
- Keep agent handoffs structured and attributable. Record the instruction layers, context references, upstream outputs, model identity, usage, and artifacts needed to explain a decision later.
- Fail closed when evidence, cleanup, acceptance, or provenance is incomplete. Retain the candidate when destructive cleanup would erase the only useful evidence.
- Keep credentials and private host instructions out of prompts, traces, logs, replay bundles, and candidate workspaces.

## Engineering expectations

- Use focused changes and add tests at the contract boundary being changed.
- Preserve existing user changes and unrelated worktree state.
- Keep Godot support engine-native; browser capture is optional evidence, never the universal execution model.
- Adapters may add provider-native telemetry, but the factory must remain usable with another agent provider.
- User-facing traces should distinguish configured identity from provider-reported identity and deterministic fixtures from real model runs.

Role charters under `extensions/agent-team/instructions/` define responsibilities and output contracts. They constrain authority and evidence quality, not the creative answer.
