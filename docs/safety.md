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
- require human review before shipping or publishing a build.

The extension manifest declares permissions for inspection, but v0.1 does not
provide an OS security boundary. Capability declaration and process sandboxing
are separate concerns.
