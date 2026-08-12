# GameFactory Observatory

The hosted, read-only observability surface for GameFactory. It visualizes a factory run as a replayable directed graph and exposes agent lineage, model and token usage, evaluation evidence, decisions, and outcomes.

The site contains no factory execution capability. Godot, Git, agent processes, journals, and artifacts remain on the user's machine.

## Data modes

- **Private loopback bridge:** `gamefactory bridge` starts an authenticated,
  read-only listener on `127.0.0.1`. The signed-in user's browser connects to it
  directly after they paste its ephemeral key. No inbound tunnel or hosted
  secret is required.
- **Local development:** the local viewer continues to run on port 4317 by
  default.
- **Portable replay:** export the current snapshot from the Site and reopen that JSON file later. Replay files are parsed entirely in the browser.

The browser bridge reads one allowlisted resource:

- `/api/snapshot`

The local server requires the exact deployed HTTPS origin and an ephemeral
bearer key, responds to current browser local-network preflights, and refuses
bridge mode on a non-loopback host. It does not expose arbitrary URLs,
filesystem paths, artifacts, commands, or mutation endpoints.
