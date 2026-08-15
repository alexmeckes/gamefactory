# Factory viewer and desktop Observatory

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
desktop-run campaign, each durably appended trace event schedules an immediate
snapshot refresh; coalesced polling remains as a fallback for externally
started processes and filesystem notifications that arrive late. After a run,
the replay cursor can move through the exact same sequence without a running
factory process. Refresh observers are deliberately best-effort: a renderer or
IPC failure is reported once and cannot fail the factory run.

## Desktop Observatory (recommended locally)

The Electron shell is the local control room. It reads the trace directly,
avoids browser local-network and CORS policy entirely, and can start or safely
stop a campaign through the existing `FactoryRunner`. The renderer remains a
sandboxed, unprivileged client behind a typed preload boundary.

```sh
cd apps/gamefactory-site
npm run desktop:start
```

Choose any `campaign.json` with **Open campaign**. If
`factory.config.json` is beside it, the app discovers it automatically. The app
finds the enclosing Git root, watches that factory's history, and persists only
the chosen campaign and config paths for the next launch.

For the included Knot Theory project:

```sh
npm run desktop:knot
```

`Run factory` uses the same core, extensions, leases, journals, worktrees, and
recovery rules as the CLI; the Observatory does not implement an alternate
orchestrator. `Stop safely` aborts through the runner and waits for its cleanup
boundary. **Export replay** produces the same portable JSON understood by the
hosted Site.

## Local browser viewer (fallback)

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

## Connect the hosted Observatory (optional fallback)

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

For Codex App Server contributors, the adapter records the resolved model and
reasoning-effort level from `thread/start` even when the campaign inherits the
user's subscription defaults. If App Server reroutes a turn, the
provider-reported destination model replaces that initial identity. Older
traces created before this capture was added remain `unreported`; they are not
rewritten using current defaults that may differ from the original run.

Artifacts are served only when their canonical file path remains inside the
configured artifact directory. Source paths and arbitrary filesystem paths are
not exposed to the browser.

## Operational behavior

The viewer does not acquire the campaign run lease and never writes to the
journal, result ledger, or artifacts. It is therefore safe to start before,
during, or after a factory run. A green live indicator means the selected run ID
currently owns the journal lease; otherwise the dashboard is in replay mode.
