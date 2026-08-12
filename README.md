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
- optional task-specific agent DAGs with structured handoffs, conditions, retries, and bounded critic repairs;
- parallel candidate tournaments with deterministic winner selection;
- fsync-backed experiment phase journals with idempotent restart recovery;
- a graph-first realtime flight recorder with live agent/subagent attempts, model and token/cost accounting, bounded progress, dependency edges, historical replay, evaluator waterfalls, metrics, and artifact inspection;
- shared workflow-runtime primitives for scheduling, evaluation, preservation, finalization, and recovery;
- versioned design intent, divergent prototype discovery, and enforced human gates;
- multiple-choice game intake with explicit delegation to design agents;
- engine-backed synthetic player cohorts across personas, scenarios, and seeds;
- modality-neutral asset briefs, command-backed generation, versioned style packs, provenance manifests, and PNG gates;
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

Watch a run as it happens—or replay the same trace afterward—from the project
directory that owns the campaign and `.factory` data:

```sh
npm run factory -- view campaign.json --config factory.config.json
# open http://127.0.0.1:4317
```

The viewer is read-only. It tails the durable journal and result ledger, so it
does not add a database, reporter extension, or engine-specific capture step to
the factory loop. See [the viewer guide](docs/viewer.md).

Start a game from an ordinary description with five short multiple-choice decisions. Every question includes `Figure it out`, which leaves that decision open for design agents instead of applying a hidden default:

```sh
npm run factory -- intake "A strange cooperative game about navigating a living library" --config examples/godot/factory.config.json --output examples/godot/game.brief.json
```

The Godot example is a playable arena game named Pulse Runner. Open
`examples/godot/project.godot` in Godot to play it. Factory runs additionally
require a Godot 4 executable named `godot` (or set `parameters.godot.binary`)
and a clean Git worktree:

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

Run `npm run smoke:godot:assets` to generate three competing enemy-drone
sprites, validate their alpha, provenance, and pinned style pack, import only
on-style survivors into Pulse Runner, capture actual gameplay, and accept
exactly one production asset.

Run `npm run smoke:godot:discovery` to compare three divergent tuning
prototypes across novice, optimizer, and survivor policies. The 36 real Godot
playtests produce a recommendation and preserved evidence, but intentionally do
not merge a creative direction.

Start with [the architecture](docs/architecture.md), then read the
[extension guide](docs/extensions.md), [Godot guide](docs/godot.md), and
[multi-agent guide](docs/multi-agent.md), [design and playtesting guide](docs/design.md),
then read the [asset foundry guide](docs/assets.md)
and [safety notes](docs/safety.md).

## Repository map

- `packages/core` — stable kernel.
- `packages/design-sdk` — versioned design intent and human-playtest contracts.
- `packages/extension-sdk` — tiny authoring helpers.
- `packages/workflow-sdk` — reusable control-plane and recovery mechanics for workflow extensions.
- `packages/viewer` — read-only live dashboard and historical flight recorder.
- `packages/cli` — `intake`, `run`, `doctor`, `list`, and `explain`.
- `extensions/*` — workflows, agent orchestration, Git, Godot, and test adapters.
- `bridges/godot` — copyable in-engine addon.
- `presets/godot-minimal` — the minimal serious Godot capability set.
- `examples/*` — smoke and engine fixtures.
