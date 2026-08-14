# Firefly Glassworks

This project is the clean end-to-end validation case for GameFactory's staged
gameplay and visual-production process.

Run the phases from the repository root:

```powershell
node scripts/run-firefly-phases.mjs gameplay
node scripts/run-firefly-phases.mjs art-slice
node scripts/run-firefly-phases.mjs production
```

Each phase requires a clean Git worktree and must accept a real candidate
commit before the next phase can begin. Phase one intentionally starts from a
plain, code-drawn graybox.
