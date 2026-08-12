# Safety and reproducibility

The Git workspace extension creates detached worktrees outside the repository.
Rejected candidates are removed. Accepted candidates become a single commit and
are cherry-picked only while the main worktree is clean.

Production campaigns should:

- run inside a version-controlled project with a recoverable remote;
- use explicit `mutablePaths` and `immutablePaths`;
- keep credentials outside candidate worktrees;
- sandbox untrusted agent commands and engine projects at the OS/container layer;
- cap experiments, wall time, cost, and consecutive crashes;
- pin engine, extension, evaluator, scenario, and seed versions;
- retain JSONL records and raw artifacts;
- keep synthetic playtest evidence explicitly labeled and calibrate it against human traces;
- exclude participant identities and raw personal data from preserved playtest reports;
- require human review before shipping or publishing a build.

The extension manifest declares permissions for inspection, but v0.1 does not
provide an OS security boundary. Capability declaration and process sandboxing
are separate concerns.

Local command agents scrub the inherited environment by default, keep only a
small process-compatibility allowlist, support explicit variable allowlists and
additions, enforce wall-clock and combined-output limits, and retain failure
evidence outside disposable candidates. Artifact preservation is fail-closed:
missing, non-file, uncopyable, or (when allowed roots are configured) out-of-scope
evidence retains the candidate and blocks the campaign rather than leaving a
dangling ledger reference.

Read-only team roles are protected by content-aware mutation detection. This is
a cooperative guardrail, not OS isolation: a hostile process can still access
anything allowed to the current operating-system user. Use a container or
sandbox broker for untrusted commands or game projects.
