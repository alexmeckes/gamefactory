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
- append-only JSONL experiment records, a local SQLite project-event index, and engine-neutral artifacts;
- deterministic mock drivers and integration tests;
- detached Git worktree isolation;
- model-neutral command-agent integration plus a native Codex App Server adapter;
- specialist agent teams with parallel scouts/critics and one protected writer;
- optional task-specific agent DAGs with structured handoffs, conditions, retries, and bounded critic repairs;
- explicit advisor escalation from efficient primary agents to frontier models, preserving partial evidence and separate provenance;
- parallel candidate tournaments with deterministic winner selection;
- an optional read-only Sol Campaign Director that frames contrasting round hypotheses and synthesizes cross-candidate learning without control-plane authority;
- fsync-backed experiment phase journals with idempotent restart recovery;
- a graph-first realtime flight recorder with live agent/subagent attempts, model, token, and billing-basis accounting, exact extension activation provenance, separate creative-input nodes, bounded progress, dependency edges, historical replay, evaluator waterfalls, metrics, and artifact inspection;
- shared workflow-runtime primitives for scheduling, evaluation, preservation, finalization, and recovery;
- versioned design intent, divergent prototype discovery, and enforced human gates;
- candidate-authored, ImageGen-assisted design systems with semantic tokens, engine adapters, pinned provenance, and integrity gates;
- multiple-choice game intake with explicit delegation to design agents;
- engine-backed synthetic player cohorts across personas, scenarios, and seeds;
- modality-neutral asset briefs, command-backed generation, versioned style packs, provenance manifests, and PNG gates;
- optional SAM 3 concept segmentation that agents can invoke as a graph node to produce verified masks and transparent cutouts;
- optional Google Omni motion studies, SAM 3 persistent video tracking, and deterministic sprite-atlas compilation;
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

For a native local control room with no loopback bridge or browser permission,
launch the Electron Observatory. It can open campaigns, follow the live agent
graph, start or safely stop a run, and export portable replay bundles:

```sh
cd apps/gamefactory-site
npm run desktop:knot
```

To use the private hosted Observatory instead, start its authenticated
loopback bridge and paste the printed endpoint and one-time key into **Live
bridge**:

```sh
npm run factory -- bridge campaign.json --config factory.config.json
```

The browser viewer is read-only. The desktop Observatory can additionally
start and safely stop runs while reusing the same runner and durable trace; it
does not add an engine-specific capture step to the factory loop. See [the
viewer guide](docs/viewer.md).

## Local runtime storage

Keep active repositories outside cloud-synced folders. Set
`GAMEFACTORY_DATA_ROOT` to place generated journals, traces, results, preserved
artifacts, and the project SQLite index on a local disk while retaining the
same portable relative paths from checked-in campaign files:

```powershell
[Environment]::SetEnvironmentVariable("GAMEFACTORY_DATA_ROOT", "D:\GameFactoryData", "User")
```

Project journeys remain available as fsync-backed JSONL audit logs. When a
local data root is configured, the CLI also maintains `factory.sqlite` in WAL
mode for transactional event lookup. Images, video, logs, and other large
artifacts remain content-addressed files; SQLite stores event metadata rather
than large blobs. Git remains the source-code backup and synchronization layer.

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
This smoke command deliberately uses deterministic fixture contributors so it
is repeatable in tests. To run the same architecture with real Codex agents and
your signed-in Codex configuration, use `npm run run:godot:codex`. The real
campaign talks to `codex app-server`, inherits the configured model and effort
unless a node explicitly overrides `model` and `reasoningEffort`, and records
both requested and provider-resolved routing alongside thread, turn,
instruction, token, and native subagent events in the trace.
Set `FACTORY_SMOKE_VERBOSE=true` to print the complete provenance and artifact
ledger instead of the compact smoke summary.

Run `npm run benchmark:model-routing` to compare the built-in Luna/high and
Sol/medium, high, and xhigh routing arms on the same read-only tasks. The report
uses a deterministic evidence rubric and records latency plus subscription token
consumption; it does not estimate dollar cost. `benchmark:model-routing:smoke`
runs one task per arm for a quicker protocol check.

Run `npm run smoke:godot:assets` to generate three competing enemy-drone
sprites, validate their alpha, provenance, and pinned style pack, import only
on-style survivors into Pulse Runner, capture actual gameplay, and accept
exactly one production asset.

For generated concept sheets that need to become editable production layers,
activate `agent:sam3.segment` and use an `agent-driver` graph node. The optional
SAM 3 extension validates candidate-local requests, invokes an isolated Python
worker, and records every prompt, mask, cutout, confidence, checkpoint identity,
post-processing setting, and content hash. It does not install or load the model
for campaigns that do not request it. See [the SAM 3 extension guide](extensions/sam3/README.md).

For animation that benefits from a generated motion study, activate the optional
`video.google-omni` -> `sam3.track` -> `animation.compile` lane. Configure a
runtime-only Google key with `npm run factory -- credentials set google.gemini`;
on Windows it is protected with current-user DPAPI and never copied into a
candidate or trace. See [the video animation guide](docs/video-animation-pipeline.md).

Run `npm run smoke:godot:discovery` to compare three divergent tuning
prototypes across novice, optimizer, and survivor policies. The 36 real Godot
playtests produce a recommendation and preserved evidence, but intentionally do
not merge a creative direction.

Start with [the architecture](docs/architecture.md), then read the
[extension guide](docs/extensions.md), [Godot guide](docs/godot.md), and
[multi-agent guide](docs/multi-agent.md), [design and playtesting guide](docs/design.md),
the [design-system guide](docs/design-system.md), then read the [asset foundry guide](docs/assets.md)
and [safety notes](docs/safety.md).

## Repository map

- `packages/core` — stable kernel.
- `packages/design-sdk` — versioned design intent, design-system, and human-playtest contracts.
- `packages/extension-sdk` — tiny authoring helpers.
- `packages/workflow-sdk` — reusable control-plane and recovery mechanics for workflow extensions.
- `packages/viewer` — read-only live dashboard and historical flight recorder.
- `packages/cli` — `intake`, `run`, `doctor`, `list`, and `explain`.
- `extensions/*` — workflows, agent orchestration, Git, Godot, and test adapters.
- `extensions/sam3` — optional text-prompted segmentation and cutout worker.
- `extensions/video-foundry` — optional provider video generation and deterministic animation compilation.
- `bridges/godot` — copyable in-engine addon.
- `presets/godot-minimal` — the minimal serious Godot capability set.
- `examples/*` — smoke and engine fixtures.
