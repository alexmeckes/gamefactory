# Knot Theory: The Workshop Studies

A compact Godot 4 rope-puzzle vertical slice. Directly shape one continuous rope through four ordered studies: pull slack into load, pass the whipped working end through a bone eye, seat a bight in an authored brass socket, take a live clockwise turn, and recombine the language in a working bell hoist.

## Controls

- Left-drag any free part of the rope to manage slack and tension.
- Pass only the coral-whipped working end through eyes; traverse the same eye backward to undo the contact.
- Right-click a rope bight at the visible brass socket to hold it; right-click again to release it.
- Release the working end over the cleat to set it. Grab the set cleat to undock.
- `R` resets the current study, `Esc` returns to the title, `Enter`/`Space` begins or advances, and `M` toggles synthesized sound.

Puzzle truth is an exact reversible contact word plus current geometry. Success requires the authored PASS order, any required HOLD, a continuous clockwise TURN that still exists around the capstan, SET at the cleat, and LOAD measured from the weakest authored rope span. Extra contacts, midpoint threading, free-space holds, disconnected partial wraps, wrong-way turns, and a taut tail attached to an upstream slack route are rejected.

All art, motion, particles, and sparse physical audio are generated in Godot code. The deterministic `factory_setup`, `factory_tick`, `factory_sample`, and `factory_collect` hooks exercise the same incremental drag path as mouse play and report observable contact, wrap, per-span load, machine, navigation, and goal state. These checks establish stability and state coverage; they do not claim that tactility or puzzle quality has been human playtested.

Open `project.godot` in Godot 4 and run the project. The immutable GameFactory capture runner produces title, first-puzzle, and finale frames under `.factory/previews` for visual review.

## Factory visual loop

The campaign treats visual quality as a first-class optimization target while keeping the deterministic Godot scenario as a required gameplay gate. Each candidate receives the pinned art target and visual contract, renders fresh representative states after implementation and every repair, and is reviewed by an independent visual-experience critic. The tournament selects on `visual_quality`; screenshots that are stale, undersized, unchanged from the original baseline, or missing concrete review evidence fail closed.
