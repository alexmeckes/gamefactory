# GameFactory

GameFactory is a lightweight, engine-neutral experimentation factory for game
development. It combines an autoresearch-style measured improvement loop with a
Pi-style minimal core and lazy extensions. Godot is the first real engine path;
browser capture is merely an optional future adapter, not an architectural
assumption.

What is implemented:

- a zero-runtime-dependency campaign kernel and capability registry;
- manifest-only discovery and on-demand extension activation;
- bounded, resumable baseline/propose/evaluate/keep/discard campaigns;
- append-only JSONL experiment records and engine-neutral artifacts;
- deterministic mock drivers and integration tests;
- detached Git worktree isolation;
- model-neutral command-agent integration;
- specialist agent teams with parallel scouts/critics and one protected writer;
- parallel candidate tournaments with deterministic winner selection;
- Godot 4 import gating, fixed-tick in-engine scenarios, telemetry, and capture;
- an extension SDK, contract-test helpers, CLI, preset, and runnable examples.

## Quick start

Requires Node.js 20+.

```sh
npm install
npm run build
npm test
npm run factory -- list --config examples/mock/factory.config.json
npm run factory -- run examples/mock/campaign.json --config examples/mock/factory.config.json
```

The Godot example additionally requires a Godot 4 executable named `godot` (or
set `parameters.godot.binary`) and a clean Git worktree:

```sh
npm run factory -- doctor examples/godot/campaign.json --config examples/godot/factory.config.json
npm run factory -- run examples/godot/campaign.json --config examples/godot/factory.config.json
```

To exercise the entire Godot pipeline without touching the current repository,
set `GODOT_BINARY` and run `npm run smoke:godot`. The harness creates and
removes a temporary Git repository around the Godot fixture.

Run `npm run smoke:godot:multi-agent` to exercise three competing worktrees.
Each candidate uses parallel scouts, a planner, one implementer, and parallel
critics before Godot evaluation; only the strongest passing candidate is kept.
Set `FACTORY_SMOKE_VERBOSE=true` to print the complete provenance and artifact
ledger instead of the compact smoke summary.

Start with [the architecture](docs/architecture.md), then read the
[extension guide](docs/extensions.md), [Godot guide](docs/godot.md), and
[multi-agent guide](docs/multi-agent.md), then the [safety notes](docs/safety.md).

## Repository map

- `packages/core` — stable kernel.
- `packages/extension-sdk` — tiny authoring helpers.
- `packages/cli` — `run`, `doctor`, `list`, and `explain`.
- `extensions/*` — workflows, agent orchestration, Git, Godot, and test adapters.
- `bridges/godot` — copyable in-engine addon.
- `presets/godot-minimal` — the minimal serious Godot capability set.
- `examples/*` — smoke and engine fixtures.
