class_name FireflyBeamSolver
extends RefCounted

# Pure grid trace used by play, deterministic witnesses, and the frozen-shutter
# counterfactual. Mechanism history remains in the caller; this function only
# reports what a single state snapshot causes.

static func reflect_direction(direction: int, orientation: int) -> int:
	# orientation 0 is '/', orientation 1 is '\\'.
	if orientation == 0:
		return [3, 2, 1, 0][direction]
	return [1, 0, 3, 2][direction]


static func inside(cell: Vector2i, columns: int, rows: int) -> bool:
	return cell.x >= 0 and cell.x < columns and cell.y >= 0 and cell.y < rows


static func trace(
		level: Dictionary,
		mirrors: Dictionary,
		latch_open: bool,
		directions: Array,
		columns: int,
		rows: int
	) -> Dictionary:
	var cells: Array[Vector2i] = [level.source]
	var sensor_contacts: Array[Vector2i] = []
	var cell: Vector2i = level.source
	var direction: int = int(level.direction)
	var visited: Dictionary = {}
	var latch: Dictionary = level.get("latch", {})
	var termination := "step_bound"
	var hit := false
	var looped := false

	for _step in range(80):
		cell += directions[direction]
		cells.append(cell)
		if not inside(cell, columns, rows):
			termination = "board_edge"
			break
		if not latch.is_empty() and cell == latch.sensor:
			sensor_contacts.append(cell)
		if not latch.is_empty() and not latch_open and cell == latch.shutter:
			termination = "closed_shutter"
			break
		if cell == level.target:
			hit = true
			termination = "receiver"
			break
		var state_key := "%d,%d,%d" % [cell.x, cell.y, direction]
		if visited.has(state_key):
			looped = true
			termination = "loop"
			break
		visited[state_key] = true
		if mirrors.has(cell):
			direction = reflect_direction(direction, int(mirrors[cell]))

	return {
		"cells": cells,
		"hit": hit,
		"loop": looped,
		"sensor_contacts": sensor_contacts,
		"termination": termination
	}
