# Discovery workflow

`workflow:discovery` creates a bounded batch of deliberately different prototypes and evaluates them against the same design intent and playtest cohort.

Its default `selection` is `recommend`: every candidate worktree is discarded after its evidence and Git patch are preserved, and the strongest passing prototype is marked as the recommendation. This prevents an automated proxy from silently locking the game's creative direction. `selection: "accept"` is available for low-risk fixtures and requires all configured hard and human gates to pass.
