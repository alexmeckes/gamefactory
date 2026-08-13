# GameFactory Observatory

The graph-first observability surface for GameFactory. It visualizes a factory
run as a replayable directed graph and exposes agent lineage, model and token
usage, evaluation evidence, decisions, and outcomes.

The project has two deliberately different shells:

- **Electron desktop app:** the local control room. It reads the journal and
  trace directly, opens campaigns with a native file picker, runs or safely
  stops the factory, and exports portable replays. The renderer is sandboxed
  behind a narrow preload API; it has no Node.js or filesystem access.
- **Hosted Site:** the portable, read-only viewer. It opens replay bundles and
  can still use the authenticated loopback bridge where browser local-network
  policy allows it.

Godot, Git, agent processes, journals, and artifacts always remain on the
user's machine.

## Desktop app

From this directory:

```sh
npm run desktop:start
```

Open the repository's Knot Theory campaign immediately:

```sh
npm run desktop:knot
```

Build a portable Windows directory under `out/`:

```sh
npm run desktop:package
```

The packaged app contains the Observatory and core runner. A selected campaign
still resolves its configured extensions from that campaign's GameFactory
checkout, preserving the core-plus-extensions architecture instead of bundling
every engine and generator into the desktop shell.

## Data modes

- **Direct desktop:** no server, bridge key, browser permission, or CORS. Native
  IPC pushes changed snapshots from the local journal into the graph.
- **Private loopback bridge:** `gamefactory bridge` starts an authenticated,
  read-only listener on `127.0.0.1`. The signed-in user's browser connects to it
  directly after they paste its ephemeral key. No inbound tunnel or hosted
  secret is required.
- **Local development:** the local viewer continues to run on port 4317 by
  default.
- **Portable replay:** export the current snapshot from the Site and reopen that JSON file later. Replay files are parsed entirely in the browser.

The optional browser bridge reads one allowlisted resource:

- `/api/snapshot`

The local server requires the exact deployed HTTPS origin and an ephemeral
bearer key, responds to current browser local-network preflights, and refuses
bridge mode on a non-loopback host. It does not expose arbitrary URLs,
filesystem paths, artifacts, commands, or mutation endpoints.
