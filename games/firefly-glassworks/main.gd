extends Node2D

# This is intentionally a graybox. It proves beam routing, direct manipulation,
# level progression, reset, and deterministic evidence without committing the
# project to a production art language.

const VIEW := Vector2(1152, 720)
const GRID_ORIGIN := Vector2(188, 126)
const CELL := 88.0
const COLS := 8
const ROWS := 5
const DIRS := [Vector2i.RIGHT, Vector2i.DOWN, Vector2i.LEFT, Vector2i.UP]
const BG := Color("11151b")
const PANEL := Color("1b222c")
const GRID := Color("34404d")
const INK := Color("e5edf4")
const MUTED := Color("8c9aa7")
const SOURCE := Color("ffb84d")
const TARGET := Color("75e6db")
const MIRROR := Color("da8cff")
const DANGER := Color("ff6b6b")

var mode := "title"
var level_index := 0
var mirrors: Dictionary = {}
var beam_points: Array[Vector2] = []
var beam_hit := false
var beam_loop := false
var hover_cell := Vector2i(-1, -1)
var rotations := 0
var resets := 0
var beam_recomputes := 0
var levels_completed := 0
var unique_mirrors_touched: Dictionary = {}
var completion_delay := -1.0
var motion_reveal := 1.0
var factory_mode := false
var factory_step := 0

var levels := [
	{
		"name": "FIRST REFLECTION",
		"lesson": "Rotate the plate so the firefly reaches the receiver.",
		"source": Vector2i(0, 3), "direction": 0, "target": Vector2i(3, 0),
		"mirrors": {Vector2i(3, 3): 1},
		"solution": {Vector2i(3, 3): 0}
	},
	{
		"name": "TWO TURNS",
		"lesson": "A route can carry intention around a corner twice.",
		"source": Vector2i(0, 4), "direction": 0, "target": Vector2i(6, 4),
		"mirrors": {Vector2i(2, 4): 1, Vector2i(2, 1): 1, Vector2i(6, 1): 0},
		"solution": {Vector2i(2, 4): 0, Vector2i(2, 1): 0, Vector2i(6, 1): 1}
	}
]

func _ready() -> void:
	set_process(true)
	queue_redraw()

func current_level() -> Dictionary:
	return levels[clampi(level_index, 0, levels.size() - 1)]

func cell_center(cell: Vector2i) -> Vector2:
	return GRID_ORIGIN + Vector2(cell.x + 0.5, cell.y + 0.5) * CELL

func point_to_cell(point: Vector2) -> Vector2i:
	var local := point - GRID_ORIGIN
	if local.x < 0.0 or local.y < 0.0:
		return Vector2i(-1, -1)
	var cell := Vector2i(int(local.x / CELL), int(local.y / CELL))
	return cell if inside(cell) else Vector2i(-1, -1)

func inside(cell: Vector2i) -> bool:
	return cell.x >= 0 and cell.x < COLS and cell.y >= 0 and cell.y < ROWS

func load_level(index: int) -> void:
	level_index = clampi(index, 0, levels.size() - 1)
	mirrors = current_level().mirrors.duplicate(true)
	beam_hit = false
	beam_loop = false
	completion_delay = -1.0
	motion_reveal = 1.0
	recompute_beam()
	queue_redraw()

func start_game() -> void:
	mode = "play"
	level_index = 0
	levels_completed = 0
	rotations = 0
	resets = 0
	beam_recomputes = 0
	unique_mirrors_touched.clear()
	load_level(0)

func rotate_mirror(cell: Vector2i, count_input := true) -> void:
	if not mirrors.has(cell):
		return
	mirrors[cell] = 1 - int(mirrors[cell])
	if count_input:
		rotations += 1
		unique_mirrors_touched[cell] = true
	recompute_beam()
	if beam_hit and not factory_mode:
		completion_delay = 0.55
	queue_redraw()

func reflect_direction(direction: int, orientation: int) -> int:
	# orientation 0 is '/', orientation 1 is '\\'.
	if orientation == 0:
		return [3, 2, 1, 0][direction]
	return [1, 0, 3, 2][direction]

func recompute_beam() -> void:
	beam_recomputes += 1
	beam_points = [cell_center(current_level().source)]
	beam_hit = false
	beam_loop = false
	var cell: Vector2i = current_level().source
	var direction: int = int(current_level().direction)
	var visited: Dictionary = {}
	for _step in range(80):
		cell += DIRS[direction]
		if not inside(cell):
			beam_points.append(cell_center(cell))
			break
		beam_points.append(cell_center(cell))
		if cell == current_level().target:
			beam_hit = true
			break
		var state_key := "%d,%d,%d" % [cell.x, cell.y, direction]
		if visited.has(state_key):
			beam_loop = true
			break
		visited[state_key] = true
		if mirrors.has(cell):
			direction = reflect_direction(direction, int(mirrors[cell]))

func complete_level() -> void:
	levels_completed = maxi(levels_completed, level_index + 1)
	if level_index + 1 < levels.size():
		load_level(level_index + 1)
	else:
		mode = "won"
		queue_redraw()

func _process(delta: float) -> void:
	if completion_delay >= 0.0:
		completion_delay -= delta
		if completion_delay <= 0.0:
			completion_delay = -1.0
			complete_level()

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseMotion:
		hover_cell = point_to_cell(event.position)
		queue_redraw()
	elif event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT and event.pressed:
		if mode == "title":
			start_game()
			return
		if mode == "won":
			start_game()
			return
		var cell := point_to_cell(event.position)
		if mirrors.has(cell):
			rotate_mirror(cell)
		elif Rect2(924, 612, 150, 46).has_point(event.position):
			resets += 1
			load_level(level_index)

func draw_text(text: String, position: Vector2, size: int, color := INK) -> void:
	draw_string(ThemeDB.fallback_font, position, text, HORIZONTAL_ALIGNMENT_LEFT, -1, size, color)

func draw_button(rect: Rect2, label: String, active := false) -> void:
	draw_rect(rect, SOURCE if active else PANEL, true)
	draw_rect(rect, INK if active else GRID, false, 2.0)
	var width := ThemeDB.fallback_font.get_string_size(label, HORIZONTAL_ALIGNMENT_LEFT, -1, 19).x
	draw_text(label, rect.position + Vector2((rect.size.x - width) * 0.5, 30), 19, BG if active else INK)

func _draw() -> void:
	draw_rect(Rect2(Vector2.ZERO, VIEW), BG, true)
	if mode == "title":
		draw_title()
	elif mode == "won":
		draw_won()
	else:
		draw_game()

func draw_title() -> void:
	draw_text("FIREFLY GLASSWORKS", Vector2(244, 254), 48)
	draw_text("GRAYBOX BUILD · GAMEPLAY BEFORE ART", Vector2(351, 301), 17, MUTED)
	draw_line(Vector2(332, 349), Vector2(820, 349), GRID, 2.0)
	draw_text("Turn plates. Carry one living beam. Learn what changes.", Vector2(297, 398), 21, INK)
	draw_button(Rect2(439, 470, 274, 54), "BEGIN EXPERIMENT", true)

func draw_game() -> void:
	var level := current_level()
	draw_text("FIREFLY GLASSWORKS / GRAYBOX", Vector2(48, 48), 22)
	draw_text("%02d / %02d" % [level_index + 1, levels.size()], Vector2(1000, 48), 17, MUTED)
	draw_text(level.name, Vector2(48, 82), 32)
	draw_text(level.lesson, Vector2(48, 110), 16, MUTED)
	for y in range(ROWS):
		for x in range(COLS):
			var cell := Vector2i(x, y)
			var rect := Rect2(GRID_ORIGIN + Vector2(x, y) * CELL, Vector2(CELL, CELL))
			if cell == hover_cell and mirrors.has(cell):
				draw_rect(rect.grow(-4), Color(MIRROR, 0.10), true)
			draw_rect(rect, GRID, false, 1.0)
	draw_source(level.source, int(level.direction))
	draw_target(level.target)
	for cell in mirrors:
		draw_mirror(cell, int(mirrors[cell]))
	draw_beam()
	draw_rect(Rect2(914, 126, 190, 438), PANEL, true)
	draw_rect(Rect2(914, 126, 190, 438), GRID, false, 2.0)
	draw_text("OBSERVATIONS", Vector2(934, 162), 16, MUTED)
	draw_text("Beam", Vector2(934, 211), 17)
	draw_text("ARRIVED" if beam_hit else "SEARCHING", Vector2(934, 239), 21, TARGET if beam_hit else SOURCE)
	draw_text("Rotations", Vector2(934, 296), 16, MUTED)
	draw_text(str(rotations), Vector2(934, 330), 28)
	draw_text("Rule", Vector2(934, 387), 16, MUTED)
	draw_text("/ and \\ turn", Vector2(934, 417), 17)
	draw_text("the beam", Vector2(934, 440), 17)
	if beam_loop:
		draw_text("LOOP DETECTED", Vector2(934, 503), 16, DANGER)
	draw_button(Rect2(924, 612, 150, 46), "RESET")
	draw_text("Click a violet plate to rotate it.", Vector2(188, 602), 17, MUTED)
	draw_text("The seed is deliberately unstyled. Its job is to expose the interaction.", Vector2(188, 638), 15, MUTED)

func draw_source(cell: Vector2i, direction: int) -> void:
	var center := cell_center(cell)
	draw_circle(center, 17, SOURCE)
	draw_circle(center, 25, SOURCE, false, 3.0)
	draw_line(center, center + Vector2(DIRS[direction]) * 31.0, SOURCE, 5.0)

func draw_target(cell: Vector2i) -> void:
	var center := cell_center(cell)
	draw_circle(center, 26, TARGET if beam_hit else Color(TARGET, 0.22))
	draw_circle(center, 26, TARGET, false, 4.0)
	draw_circle(center, 9, BG)

func draw_mirror(cell: Vector2i, orientation: int) -> void:
	var center := cell_center(cell)
	draw_circle(center, 29, Color(MIRROR, 0.13))
	draw_circle(center, 29, MIRROR, false, 2.0)
	var a := Vector2(-22, 22) if orientation == 0 else Vector2(-22, -22)
	var b := -a
	draw_line(center + a, center + b, MIRROR, 7.0)
	draw_circle(center, 5, INK)

func draw_beam() -> void:
	if beam_points.size() < 2:
		return
	var total_segments := beam_points.size() - 1
	var visible := clampf(motion_reveal, 0.0, 1.0) * float(total_segments)
	for index in range(total_segments):
		var amount := clampf(visible - float(index), 0.0, 1.0)
		if amount <= 0.0:
			break
		var start := beam_points[index]
		var finish := start.lerp(beam_points[index + 1], amount)
		draw_line(start, finish, Color(SOURCE, 0.24), 11.0)
		draw_line(start, finish, SOURCE if not beam_hit else TARGET, 3.0)

func draw_won() -> void:
	draw_text("ROUTE COMPLETE", Vector2(353, 290), 48, TARGET)
	draw_text("The interaction survived two transformations.", Vector2(350, 347), 20)
	draw_text("This is deterministic proof, not evidence that it is fun.", Vector2(323, 386), 17, MUTED)
	draw_button(Rect2(439, 456, 274, 54), "RUN AGAIN", true)

func capture_motion_frame(index: int) -> void:
	if mode != "play":
		start_game()
	var solution: Dictionary = current_level().solution
	for cell in solution:
		mirrors[cell] = solution[cell]
	recompute_beam()
	motion_reveal = clampf(float(index) / 6.0, 0.0, 1.0)
	queue_redraw()

func factory_setup(_parameters: Dictionary) -> void:
	factory_mode = true
	factory_step = 0
	start_game()

func factory_tick(tick: int) -> void:
	if mode == "won":
		return
	if tick % 24 != 0:
		return
	var solution: Dictionary = current_level().solution
	var cells := solution.keys()
	if factory_step < cells.size():
		var cell: Vector2i = cells[factory_step]
		if int(mirrors[cell]) != int(solution[cell]):
			rotate_mirror(cell, true)
		factory_step += 1
	elif beam_hit:
		levels_completed = maxi(levels_completed, level_index + 1)
		if level_index + 1 < levels.size():
			load_level(level_index + 1)
			factory_step = 0
		else:
			mode = "won"
			queue_redraw()

func factory_sample() -> Dictionary:
	return {
		"level": level_index + 1,
		"levels_completed": levels_completed,
		"beam_hit": beam_hit,
		"beam_loop": beam_loop,
		"rotations": rotations,
		"beam_recomputes": beam_recomputes,
		"state": mode
	}

func factory_collect() -> Dictionary:
	var violations: Array = []
	if levels_completed < levels.size() or mode != "won":
		violations.append({"code":"firefly.incomplete", "message":"The deterministic route did not complete every authored graybox puzzle.", "severity":"error"})
	if rotations <= 0 or unique_mirrors_touched.is_empty():
		violations.append({"code":"firefly.no-interaction", "message":"The run did not exercise mirror rotation.", "severity":"error"})
	var contract_score := float(levels_completed * 30 + mini(unique_mirrors_touched.size(), 6) * 4 + (20 if mode == "won" else 0))
	return {
		"metrics": {
			"gameplay_contract_score": contract_score,
			"levels_completed": levels_completed,
			"authored_levels": levels.size(),
			"rotations": rotations,
			"unique_mirrors_touched": unique_mirrors_touched.size(),
			"beam_recomputes": beam_recomputes,
			"completion": 1.0 if mode == "won" else 0.0
		},
		"violations": violations
	}
