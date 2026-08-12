# Factory viewer

The viewer is a read-only flight recorder for a campaign. It uses the same two
durable control files the factory already writes, plus a best-effort execution
trace:

- the workflow journal supplies ordered, fsync-backed phase events;
- the result ledger supplies final metrics, evaluator details, agent
  provenance, and preserved artifacts.
- `.factory/traces/<campaign>.jsonl` supplies live agent topology, dependency
  edges, attempts, bounded subprocess progress, retries, evaluator scheduling,
  skipped work, and artifact counts.

That makes live observation and after-the-fact replay the same feature. During a
run, the viewer polls file metadata and pushes a new snapshot to connected
browsers only when the trace changes. After a run, the replay cursor can move
through the exact same sequence without a running factory process.

## Start it

Run this from the project directory used as the factory runner's working
directory:

```sh
gamefactory view campaign.json --config factory.config.json
```

When using this repository directly:

```sh
npm run factory -- view campaign.json --config factory.config.json
```

The default address is `http://127.0.0.1:4317`. Use `--port 0` to select an
available port, or set an explicit port with `--port`. The server binds only to
the loopback interface unless `--host` is deliberately changed.

## Connect the hosted Observatory

Use bridge mode when you want the private hosted Observatory to display the
trace from this computer:

```sh
npm run factory -- bridge campaign.json --config factory.config.json
```

The command prints a loopback endpoint and a random, one-time bridge key. Open
**Live bridge** in the Observatory and paste both values. The browser may ask
for local-network access; allow it for the Observatory to reach the loopback
listener. The page polls a full read-only snapshot, so node starts, progress,
agent lineage, extensions, creative inputs, model identity, tokens, evaluator
results, and decisions update together.

The bridge is intentionally not a public tunnel:

- it always binds to `127.0.0.1`;
- it permits only the configured HTTPS Observatory origin;
- cross-origin reads require the one-time key;
- it exposes only `/api/snapshot`, not artifacts, commands, or filesystem paths;
- the key exists only for the life of the command and is stored only in the
  browser tab session after pairing.

The local journal and result ledger remain the durable history. Keep the bridge
running to inspect an old run in the hosted Observatory, or download a portable
replay from the Site for inspection without the bridge.

## What the dashboard shows

- a graph-first overview of campaign fan-out, candidates, isolated workspaces,
  agent teams, contributors, evaluator waterfalls, decisions, and outcomes;
- collapsible candidate clusters with agent, evaluation, and decision focus
  filters so large runs remain navigable;
- parallel experiment lanes as an optional timing view;
- the acceptance intent, applied outcome, and cleanup boundary;
- primary-metric comparisons across candidates;
- evaluator ordering, pass/fail outcomes, summaries, and evidence counts;
- specialist-agent roles and summaries when agent-team provenance is present;
- agent/subagent lineage, provider/model identity, retry attempts, detailed token categories, and billing basis;
- the effective prompt stack for each invocation, including project instructions, versioned role charter, task, context, handoffs, and App Server instruction sources;
- preserved screenshots, logs, telemetry, reports, and other artifacts;
- all compatible recorded run IDs for the selected campaign.

Every graph node has an entry and completion boundary in the durable trace. The
replay cursor therefore changes nodes from hidden to running to their recorded
outcome, and active edges animate while work moves through them. Clicking a
candidate expands its internal execution graph; clicking a child node focuses
the inspection panel on that operation without losing the experiment context.

The trace is observational rather than authoritative. Trace writes are
serialized, but a trace I/O failure is caught and can never change evaluation,
acceptance, cleanup, or recovery. The journal remains the sole recovery source
of truth. Progress events report bounded byte counts and semantic summaries;
they never copy raw subprocess output or inherited environment variables.
Effective prompt manifests are deliberately included for auditability, but
they contain only the bounded GameFactory-controlled layers and
provider-reported source paths—not hidden provider system prompts or
credential-bearing environment values.

Usage totals are computed from unique leaf invocations, so a persisted
contributor and its matching live attempt do not double-count. The viewer shows
how many invocations reported tokens and cost. Missing usage is displayed as
`unreported`, never as zero; partial cost totals carry a `+`. Cost source and an
optional pricing-table version remain attached to each invocation.

Artifacts are served only when their canonical file path remains inside the
configured artifact directory. Source paths and arbitrary filesystem paths are
not exposed to the browser.

## Operational behavior

The viewer does not acquire the campaign run lease and never writes to the
journal, result ledger, or artifacts. It is therefore safe to start before,
during, or after a factory run. A green live indicator means the selected run ID
currently owns the journal lease; otherwise the dashboard is in replay mode.
