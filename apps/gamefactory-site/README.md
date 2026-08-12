# GameFactory Observatory

The hosted, read-only observability surface for GameFactory. It visualizes a factory run as a replayable directed graph and exposes agent lineage, model and token usage, evaluation evidence, decisions, and outcomes.

The site contains no factory execution capability. Godot, Git, agent processes, journals, and artifacts remain on the user's machine.

## Data modes

- **Private bridge:** the deployed Site expects a private HTTP binding named `gamefactory`, exposed to the Worker as `CUSTOMER_HTTP_GAMEFACTORY`.
- **Local development:** copy `.env.example` to `.env.local`; the default points at the loopback viewer on port 4317.
- **Portable replay:** export the current snapshot from the Site and reopen that JSON file later. Replay files are parsed entirely in the browser.

The Worker only proxies three allowlisted, read-only resources:

- `/api/snapshot`
- `/api/stream`
- `/artifacts/{sha256}`

It does not proxy arbitrary URLs, filesystem paths, commands, or mutation endpoints.
