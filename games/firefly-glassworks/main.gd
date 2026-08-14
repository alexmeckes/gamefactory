extends Node2D

# This is intentionally a graybox. It tests whether one visible, monotonic
# workshop latch can make mirror routing support a readable second stage.
# It does not claim that deterministic completion is human evidence of fun.

const BeamSolver = preload("res://src/beam_solver.gd")
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
const LATCH := Color("79a8ff")
const DANGER := Color("ff6b6b")

var mode := "title"
var level_index := 0
var mirrors: Dictionary = {}
var latch_open := false
var beam_points: Array[Vector2] = []
var beam_hit := false
var beam_loop := false
var beam_termination := "untraced"
var hover_cell := Vector2i(-1, -1)
var focused_mirror := 0
var rotations := 0
var resets := 0
var player_actions := 0
var beam_recomputes := 0
var levels_completed := 0
var latch_activations := 0
var maximum_trace_passes := 0
var post_activation_rotations := 0
var open_but_incomplete_observed := false
var ordered_causal_levels := 0
var causal_activation_valid := true
var no_input_states_valid := true
var reset_fingerprint_match := true
var reset_fingerprint_checks := 0
var unique_mirrors_touched: Dictionary = {}
var initial_fingerprint := ""
var completion_delay := -1.0
var motion_reveal := 1.0
var last_event := "cold"
var level_activation_action := -1
var level_arrival_action := -1
var level_post_activation_rotations := 0
var factory_mode := false
var factory_step := 0
var capture_stage := -1

var levels := [
	{
		"name": "FIRST REFLECTION",
		"lesson": "Rotate the plate so the firefly reaches the receiver.",
		"source": Vector2i(0, 3), "direction": 0, "target": Vector2i(3, 0),
		"mirrors": {Vector2i(3, 3): 1},
		"witness": [{"type": "rotate", "cell": Vector2i(3, 3)}]
	},
	{
		"name": "WAKE THE WORKSHOP",
		"lesson": "Carry the beam through the ring; its linked shutter stays open.",
		"source": Vector2i(0, 4), "direction": 0, "target": Vector2i(2, 0),
		"mirrors": {Vector2i(2, 4): 1},
		"latch": {"sensor": Vector2i(2, 3), "shutter": Vector2i(2, 2)},
		"witness": [{"type": "rotate", "cell": Vector2i(2, 4)}]
	},
	{
		"name": "USE WHAT CHANGED",
		"lesson": "Open the passage, then turn the plate back while it remembers.",
		"source": Vector2i(0, 1), "direction": 0, "target": Vector2i(3, 4),
		"mirrors": {Vector2i(3, 1): 1},
		"latch": {"sensor": Vector2i(3, 0), "shutter": Vector2i(3, 3)},
		"witness": [
			{"type": "rotate", "cell": Vector2i(3, 1)},
			{"type": "reset"},
			{"type": "rotate", "cell": Vector2i(3, 1)},
			{"type": "rotate", "cell": Vector2i(3, 1)}
		]
	},
	{
		"name": "WAKE, ROUTE, RETURN",
		"lesson": "Open the linked passage, then choose a route through what changed.",
		"source": Vector2i(0, 2), "direction": 0, "target": Vector2i(6, 1),
		"mirrors": {
			Vector2i(2, 2): 1,
			Vector2i(2, 4): 0,
			Vector2i(6, 4): 1
		},
		"latch": {"sensor": Vector2i(2, 0), "shutter": Vector2i(2, 3)},
		"downstream_preparation": [Vector2i(2, 4), Vector2i(6, 4)],
		"witness": [
			{"type": "rotate", "cell": Vector2i(6, 4)},
			{"type": "rotate", "cell": Vector2i(2, 4)},
			{"type": "rotate", "cell": Vector2i(2, 2)},
			{"type": "rotate", "cell": Vector2i(2, 2)}
		],
		"wake_first_witness": [
			Vector2i(2, 2), Vector2i(2, 2),
			Vector2i(2, 4), Vector2i(6, 4)
		]
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
	return cell if BeamSolver.inside(cell, COLS, ROWS) else Vector2i(-1, -1)


func mirror_cells() -> Array:
	return mirrors.keys()


func focused_cell() -> Vector2i:
	var cells := mirror_cells()
	if cells.is_empty():
		return Vector2i(-1, -1)
	focused_mirror = posmod(focused_mirror, cells.size())
	return cells[focused_mirror]


func cycle_focus(offset: int) -> void:
	if mirrors.is_empty():
		return
	focused_mirror = posmod(focused_mirror + offset, mirrors.size())
	hover_cell = Vector2i(-1, -1)
	queue_redraw()


func load_level(index: int) -> void:
	level_index = clampi(index, 0, levels.size() - 1)
	mirrors = current_level().mirrors.duplicate(true)
	latch_open = false
	beam_hit = false
	beam_loop = false
	beam_termination = "untraced"
	completion_delay = -1.0
	motion_reveal = 1.0
	focused_mirror = 0
	level_activation_action = -1
	level_arrival_action = -1
	level_post_activation_rotations = 0
	last_event = "cold"
	recompute_beam()
	if beam_hit or latch_open:
		no_input_states_valid = false
	initial_fingerprint = gameplay_fingerprint()
	queue_redraw()


func start_game() -> void:
	mode = "play"
	level_index = 0
	levels_completed = 0
	rotations = 0
	resets = 0
	player_actions = 0
	beam_recomputes = 0
	latch_activations = 0
	maximum_trace_passes = 0
	post_activation_rotations = 0
	open_but_incomplete_observed = false
	ordered_causal_levels = 0
	causal_activation_valid = true
	no_input_states_valid = true
	reset_fingerprint_match = true
	reset_fingerprint_checks = 0
	unique_mirrors_touched.clear()
	factory_step = 0
	capture_stage = -1
	load_level(0)


func gameplay_fingerprint() -> String:
	var orientation_parts: Array[String] = []
	for cell in mirrors:
		orientation_parts.append("%d,%d=%d" % [cell.x, cell.y, int(mirrors[cell])])
	orientation_parts.sort()
	return "%d|%s|%d|%d|%d|%s" % [
		level_index,
		",".join(orientation_parts),
		int(latch_open),
		int(beam_hit),
		int(beam_loop),
		beam_termination
	]


func apply_action(action: Dictionary, count_input := true) -> void:
	var action_type: String = action.get("type", "")
	if action_type == "reset":
		var expected := initial_fingerprint
		if count_input:
			player_actions += 1
			resets += 1
		load_level(level_index)
		if count_input:
			reset_fingerprint_checks += 1
			reset_fingerprint_match = reset_fingerprint_match and gameplay_fingerprint() == expected
		last_event = "reset"
		return
	if action_type != "rotate":
		return
	var cell: Vector2i = action.get("cell", Vector2i(-1, -1))
	if not mirrors.has(cell):
		return
	var was_open := latch_open
	if count_input:
		player_actions += 1
		rotations += 1
		unique_mirrors_touched["%d:%d,%d" % [level_index, cell.x, cell.y]] = true
	mirrors[cell] = 1 - int(mirrors[cell])
	last_event = "mirror_rotated"
	recompute_beam()
	if count_input and was_open:
		post_activation_rotations += 1
		level_post_activation_rotations += 1
	if beam_hit:
		if level_arrival_action < 0:
			level_arrival_action = player_actions
		last_event = "receiver_arrived"
		request_completion()
	queue_redraw()


func recompute_beam() -> void:
	beam_recomputes += 1
	var level := current_level()
	var latch: Dictionary = level.get("latch", {})
	var pass_bound := 1 if latch.is_empty() else 2
	var trace: Dictionary = {}
	var passes := 0
	while passes < pass_bound:
		passes += 1
		trace = BeamSolver.trace(level, mirrors, latch_open, DIRS, COLS, ROWS)
		if not latch.is_empty() and not latch_open and trace.sensor_contacts.has(latch.sensor):
			causal_activation_valid = causal_activation_valid and trace.sensor_contacts.has(latch.sensor)
			latch_open = true
			latch_activations += 1
			if level_activation_action < 0:
				level_activation_action = player_actions
			last_event = "latch_opened"
			continue
		break
	maximum_trace_passes = maxi(maximum_trace_passes, passes)
	beam_points.clear()
	for path_cell in trace.get("cells", []):
		beam_points.append(cell_center(path_cell))
	beam_hit = bool(trace.get("hit", false))
	beam_loop = bool(trace.get("loop", false))
	beam_termination = str(trace.get("termination", "unknown"))
	if latch_open and not beam_hit:
		open_but_incomplete_observed = true
	queue_redraw()


func request_completion() -> void:
	if factory_mode:
		complete_level()
	elif capture_stage >= 0:
		# Captures hold on the solved board so their trace cannot advance offscreen.
		completion_delay = -1.0
	else:
		completion_delay = 0.55


func complete_level() -> void:
	if level_index >= 2 and not current_level().get("latch", {}).is_empty():
		if level_activation_action >= 0 and level_arrival_action > level_activation_action and level_post_activation_rotations > 0:
			ordered_causal_levels += 1
	levels_completed = maxi(levels_completed, level_index + 1)
	if level_index + 1 < levels.size():
		load_level(level_index + 1)
		factory_step = 0
	else:
		mode = "won"
		completion_delay = -1.0
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
		return
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT and event.pressed:
		if mode == "title" or mode == "won":
			start_game()
			return
		if completion_delay >= 0.0:
			return
		var cell := point_to_cell(event.position)
		if mirrors.has(cell):
			apply_action({"type": "rotate", "cell": cell})
		elif Rect2(924, 612, 150, 46).has_point(event.position):
			apply_action({"type": "reset"})
		return
	if not event is InputEventKey or not event.pressed or event.echo:
		return
	if mode == "title" or mode == "won":
		if event.keycode == KEY_ENTER or event.keycode == KEY_SPACE:
			start_game()
		return
	if completion_delay >= 0.0:
		return
	if event.keycode == KEY_R:
		apply_action({"type": "reset"})
	elif event.keycode == KEY_LEFT or event.keycode == KEY_UP or event.keycode == KEY_TAB:
		cycle_focus(-1)
	elif event.keycode == KEY_RIGHT or event.keycode == KEY_DOWN:
		cycle_focus(1)
	elif event.keycode == KEY_ENTER or event.keycode == KEY_SPACE:
		apply_action({"type": "rotate", "cell": focused_cell()})


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
	draw_text("GRAYBOX BUILD - GAMEPLAY BEFORE ART", Vector2(351, 301), 17, MUTED)
	draw_line(Vector2(332, 349), Vector2(820, 349), GRID, 2.0)
	draw_text("Turn plates. Wake one latch. Use what the workshop remembers.", Vector2(257, 398), 21, INK)
	draw_button(Rect2(439, 470, 274, 54), "BEGIN EXPERIMENT", true)


func draw_game() -> void:
	var level := current_level()
	var beam_visibly_arrived := beam_hit and motion_reveal >= 0.999
	draw_text("FIREFLY GLASSWORKS / GRAYBOX", Vector2(48, 48), 22)
	draw_text("%02d / %02d" % [level_index + 1, levels.size()], Vector2(1000, 48), 17, MUTED)
	draw_text(level.name, Vector2(48, 82), 32)
	draw_text(level.lesson, Vector2(48, 110), 16, MUTED)
	for y in range(ROWS):
		for x in range(COLS):
			var cell := Vector2i(x, y)
			var rect := Rect2(GRID_ORIGIN + Vector2(x, y) * CELL, Vector2(CELL, CELL))
			if mirrors.has(cell) and (cell == hover_cell or cell == focused_cell()):
				draw_rect(rect.grow(-4), Color(MIRROR, 0.10), true)
			draw_rect(rect, GRID, false, 1.0)
	if not level.get("latch", {}).is_empty():
		draw_latch_link(level.latch.sensor, level.latch.shutter)
	draw_source(level.source, int(level.direction))
	draw_target(level.target)
	for cell in mirrors:
		draw_mirror(cell, int(mirrors[cell]), cell == focused_cell())
	if not level.get("latch", {}).is_empty():
		draw_sensor(level.latch.sensor)
		draw_shutter(level.latch.shutter)
	draw_beam()
	draw_rect(Rect2(914, 126, 190, 438), PANEL, true)
	draw_rect(Rect2(914, 126, 190, 438), GRID, false, 2.0)
	draw_text("OBSERVATIONS", Vector2(934, 162), 16, MUTED)
	draw_text("Beam", Vector2(934, 203), 16, MUTED)
	var beam_label := "ARRIVED" if beam_visibly_arrived else ("IN TRANSIT" if beam_hit else "SEARCHING")
	draw_text(beam_label, Vector2(934, 230), 20, TARGET if beam_visibly_arrived else SOURCE)
	draw_text("Rotations", Vector2(934, 276), 16, MUTED)
	draw_text(str(rotations), Vector2(934, 309), 27)
	draw_text("Workshop latch", Vector2(934, 354), 16, MUTED)
	if level.get("latch", {}).is_empty():
		draw_text("NOT PRESENT", Vector2(934, 382), 18, MUTED)
	else:
		draw_text("OPEN" if latch_open else "CLOSED", Vector2(934, 382), 21, LATCH if latch_open else INK)
		draw_text("persists to reset", Vector2(934, 408), 14, MUTED)
	draw_text("One verb", Vector2(934, 453), 16, MUTED)
	draw_text("ROTATE", Vector2(934, 480), 18, MIRROR)
	if beam_loop:
		draw_text("LOOP DETECTED", Vector2(934, 521), 16, DANGER)
	draw_button(Rect2(924, 612, 150, 46), "RESET [R]")
	draw_text("Click a violet plate, or select with arrows and press Space.", Vector2(188, 602), 16, MUTED)
	draw_text("Ring -> linked barrier. A split barrier is physically open.", Vector2(188, 638), 15, MUTED)


func draw_source(cell: Vector2i, direction: int) -> void:
	var center := cell_center(cell)
	draw_circle(center, 17, SOURCE)
	draw_circle(center, 25, SOURCE, false, 3.0)
	draw_line(center, center + Vector2(DIRS[direction]) * 31.0, SOURCE, 5.0)


func draw_target(cell: Vector2i) -> void:
	var center := cell_center(cell)
	var visibly_arrived := beam_hit and motion_reveal >= 0.999
	draw_circle(center, 26, TARGET if visibly_arrived else Color(TARGET, 0.22))
	draw_circle(center, 26, TARGET, false, 4.0)
	draw_circle(center, 9, BG)


func draw_mirror(cell: Vector2i, orientation: int, focused: bool) -> void:
	var center := cell_center(cell)
	draw_circle(center, 34 if focused else 29, Color(MIRROR, 0.13))
	draw_circle(center, 34 if focused else 29, INK if focused else MIRROR, false, 2.0)
	var a := Vector2(-22, 22) if orientation == 0 else Vector2(-22, -22)
	var b := -a
	draw_line(center + a, center + b, MIRROR, 7.0)
	draw_circle(center, 5, INK)


func draw_latch_link(sensor: Vector2i, shutter: Vector2i) -> void:
	var start := cell_center(sensor) + Vector2(30, 0)
	var finish := cell_center(shutter) + Vector2(30, 0)
	var middle := Vector2(finish.x, start.y)
	draw_polyline(PackedVector2Array([start, middle, finish]), LATCH if latch_open else MUTED, 3.0)
	draw_circle(middle, 4, LATCH if latch_open else MUTED)


func draw_sensor(cell: Vector2i) -> void:
	var center := cell_center(cell)
	draw_circle(center, 24, Color(LATCH, 0.18))
	draw_circle(center, 24, LATCH, false, 5.0)
	draw_circle(center, 10 if latch_open else 5, LATCH if latch_open else INK, latch_open)
	for direction in DIRS:
		draw_line(center + Vector2(direction) * 27.0, center + Vector2(direction) * 34.0, LATCH, 4.0)


func draw_shutter(cell: Vector2i) -> void:
	var center := cell_center(cell)
	if latch_open:
		draw_rect(Rect2(center + Vector2(-36, -24), Vector2(20, 48)), LATCH, true)
		draw_rect(Rect2(center + Vector2(16, -24), Vector2(20, 48)), LATCH, true)
		draw_line(center + Vector2(-12, -25), center + Vector2(-12, 25), LATCH, 2.0)
		draw_line(center + Vector2(12, -25), center + Vector2(12, 25), LATCH, 2.0)
	else:
		draw_rect(Rect2(center + Vector2(-36, -14), Vector2(72, 28)), LATCH, true)
		draw_line(center + Vector2(-30, 0), center + Vector2(30, 0), INK, 4.0)


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
	draw_text("WORKSHOP SEQUENCE COMPLETE", Vector2(252, 290), 43, TARGET)
	draw_text("The beam opened a rule, then returned through what changed.", Vector2(285, 347), 20)
	draw_text("Deterministic proof of causality is not evidence that this is fun.", Vector2(297, 386), 17, MUTED)
	draw_button(Rect2(439, 456, 274, 54), "RUN AGAIN", true)


func capture_motion_frame(index: int) -> void:
	if capture_stage < 0:
		mode = "play"
		load_level(3)
		capture_stage = 0
	var capture_actions := {
		1: {"type": "rotate", "cell": Vector2i(6, 4)},
		2: {"type": "rotate", "cell": Vector2i(2, 4)},
		3: {"type": "rotate", "cell": Vector2i(2, 2)},
		5: {"type": "rotate", "cell": Vector2i(2, 2)}
	}
	while capture_stage < index:
		capture_stage += 1
		if capture_actions.has(capture_stage):
			# Scripted rotations use the same action path and remain visible in the
			# counter. They are deterministic capture evidence, not player input.
			apply_action(capture_actions[capture_stage], true)
	motion_reveal = [0.18, 0.36, 0.55, 0.78, 1.0, 0.62, 1.0][clampi(index, 0, 6)]
	queue_redraw()


func factory_setup(_parameters: Dictionary) -> void:
	factory_mode = true
	factory_step = 0
	start_game()


func factory_tick(tick: int) -> void:
	if mode == "won" or tick % 12 != 0:
		return
	var witness: Array = current_level().witness
	if factory_step >= witness.size():
		return
	var action: Dictionary = witness[factory_step]
	factory_step += 1
	apply_action(action, true)


func factory_sample() -> Dictionary:
	return {
		"level": level_index + 1,
		"levels_completed": levels_completed,
		"beam_hit": beam_hit,
		"beam_loop": beam_loop,
		"beam_termination": beam_termination,
		"latch_open": latch_open,
		"last_event": last_event,
		"actions": player_actions,
		"rotations": rotations,
		"resets": resets,
		"latch_activations": latch_activations,
		"activation_action_index": level_activation_action,
		"arrival_action_index": level_arrival_action,
		"post_activation_rotations": post_activation_rotations,
		"open_but_incomplete_observed": open_but_incomplete_observed,
		"reset_fingerprint_match": reset_fingerprint_match,
		"maximum_trace_passes": maximum_trace_passes,
		"beam_recomputes": beam_recomputes,
		"deterministic_finale_prepare_first_witness": "6,4>2,4>2,2>2,2",
		"deterministic_finale_wake_first_witness": "2,2>2,2>2,4>6,4",
		"finale_claim": "two_stage_stateful_routing; advance_preparation_not_required",
		"state": mode
	}


func finale_fails_frozen_closed() -> bool:
	var level: Dictionary = levels[3]
	var test_mirrors: Dictionary = level.mirrors.duplicate(true)
	var trace: Dictionary = {}
	for action in level.witness:
		var cell: Vector2i = action.cell
		test_mirrors[cell] = 1 - int(test_mirrors[cell])
		trace = BeamSolver.trace(level, test_mirrors, false, DIRS, COLS, ROWS)
		if bool(trace.hit):
			return false
	return not bool(trace.get("hit", false)) and trace.get("termination", "") == "closed_shutter"


func simulate_finale_sequence(sequence: Array) -> Dictionary:
	var level: Dictionary = levels[3]
	var test_mirrors: Dictionary = level.mirrors.duplicate(true)
	var latch: Dictionary = level.latch
	var is_open := false
	var activation_action := -1
	var arrival_action := -1
	var prepared_before_activation := false
	var touched: Dictionary = {}
	var trace: Dictionary = {}
	for action_index in range(sequence.size()):
		var cell: Vector2i = sequence[action_index]
		test_mirrors[cell] = 1 - int(test_mirrors[cell])
		touched[cell] = true
		trace = BeamSolver.trace(level, test_mirrors, is_open, DIRS, COLS, ROWS)
		if not is_open and trace.sensor_contacts.has(latch.sensor):
			is_open = true
			activation_action = action_index + 1
			prepared_before_activation = true
			for preparation_cell in level.downstream_preparation:
				prepared_before_activation = prepared_before_activation and touched.has(preparation_cell)
			trace = BeamSolver.trace(level, test_mirrors, true, DIRS, COLS, ROWS)
		if bool(trace.get("hit", false)):
			arrival_action = action_index + 1
			break
	return {
		"completed": arrival_action > 0,
		"activation_action": activation_action,
		"arrival_action": arrival_action,
		"prepared_before_activation": prepared_before_activation
	}


func append_action_sequences(cells: Array, length: int, prefix: Array, output: Array) -> void:
	if prefix.size() == length:
		output.append(prefix.duplicate())
		return
	for cell in cells:
		prefix.append(cell)
		append_action_sequences(cells, length, prefix, output)
		prefix.pop_back()


func audit_finale_solutions() -> Dictionary:
	var level: Dictionary = levels[3]
	var cells: Array = level.mirrors.keys()
	var shortest_rotations := -1
	var shortest_sequences: Array = []
	for length in range(1, 5):
		var sequences: Array = []
		append_action_sequences(cells, length, [], sequences)
		for sequence in sequences:
			if bool(simulate_finale_sequence(sequence).completed):
				shortest_sequences.append(sequence)
		if not shortest_sequences.is_empty():
			shortest_rotations = length
			break

	var wake_first_count := 0
	var prepared_first_count := 0
	for sequence in shortest_sequences:
		var result := simulate_finale_sequence(sequence)
		if int(result.activation_action) == 1:
			wake_first_count += 1
		if bool(result.prepared_before_activation):
			prepared_first_count += 1

	var prepare_result := simulate_finale_sequence([
		Vector2i(6, 4), Vector2i(2, 4),
		Vector2i(2, 2), Vector2i(2, 2)
	])
	var wake_result := simulate_finale_sequence(level.wake_first_witness)
	return {
		"shortest_rotations": shortest_rotations,
		"shortest_solution_count": shortest_sequences.size(),
		"wake_first_shortest_count": wake_first_count,
		"prepared_first_shortest_count": prepared_first_count,
		"prepare_first_witness_valid": bool(prepare_result.completed) and int(prepare_result.arrival_action) == shortest_rotations and bool(prepare_result.prepared_before_activation),
		"wake_first_witness_valid": bool(wake_result.completed) and int(wake_result.arrival_action) == shortest_rotations and int(wake_result.activation_action) == 1,
		"advance_preparation_required": not shortest_sequences.is_empty() and prepared_first_count == shortest_sequences.size()
	}


func factory_collect() -> Dictionary:
	var violations: Array = []
	var frozen_closed_failure := finale_fails_frozen_closed()
	var finale_audit := audit_finale_solutions()
	if levels_completed < levels.size() or mode != "won":
		violations.append({"code":"firefly.incomplete", "message":"The deterministic witness did not complete every authored puzzle.", "severity":"error"})
	if rotations <= 0 or unique_mirrors_touched.is_empty():
		violations.append({"code":"firefly.no-interaction", "message":"The witness did not exercise the shared mirror-rotation action.", "severity":"error"})
	if latch_activations < 3 or not causal_activation_valid:
		violations.append({"code":"firefly.latch-causality", "message":"A latch did not open from a traced sensor intersection.", "severity":"error"})
	if not open_but_incomplete_observed or ordered_causal_levels < 2 or post_activation_rotations < 2:
		violations.append({"code":"firefly.no-causal-order", "message":"Representative puzzles did not preserve an open-but-incomplete state followed by player rotation.", "severity":"error"})
	if reset_fingerprint_checks < 1 or not reset_fingerprint_match:
		violations.append({"code":"firefly.reset-integrity", "message":"Reset did not reproduce the authored gameplay-state fingerprint.", "severity":"error"})
	if not frozen_closed_failure:
		violations.append({"code":"firefly.shutter-unnecessary", "message":"The finale witness did not fail with its shutter frozen closed.", "severity":"error"})
	if maximum_trace_passes > 2:
		violations.append({"code":"firefly.trace-bound", "message":"Causal resolution exceeded latch count plus one trace pass.", "severity":"error"})
	if not no_input_states_valid:
		violations.append({"code":"firefly.no-input-transition", "message":"An authored level arrived or opened its latch without an action.", "severity":"error"})
	if int(finale_audit.shortest_rotations) != 4 or int(finale_audit.shortest_solution_count) != 12 or int(finale_audit.wake_first_shortest_count) != 6 or int(finale_audit.prepared_first_shortest_count) != 2:
		violations.append({"code":"firefly.finale-audit-changed", "message":"The finale no longer matches the audited four-action solution space.", "severity":"error"})
	if not bool(finale_audit.prepare_first_witness_valid) or not bool(finale_audit.wake_first_witness_valid) or bool(finale_audit.advance_preparation_required):
		violations.append({"code":"firefly.solution-language-overclaim", "message":"Telemetry must preserve both preparation-first and wake-first shortest witnesses without claiming preparation is required.", "severity":"error"})

	var completion_ratio := float(levels_completed) / float(levels.size())
	var contract_score := completion_ratio * 40.0
	contract_score += 10.0 if rotations > 0 and not unique_mirrors_touched.is_empty() else 0.0
	contract_score += 10.0 if latch_activations >= 3 and causal_activation_valid else 0.0
	contract_score += 10.0 if open_but_incomplete_observed else 0.0
	contract_score += 10.0 if ordered_causal_levels >= 2 and post_activation_rotations >= 2 else 0.0
	contract_score += 10.0 if reset_fingerprint_checks >= 1 and reset_fingerprint_match else 0.0
	contract_score += 10.0 if frozen_closed_failure else 0.0
	return {
		"metrics": {
			"gameplay_contract_score": contract_score,
			"levels_completed": levels_completed,
			"authored_levels": levels.size(),
			"rotations": rotations,
			"actions": player_actions,
			"resets": resets,
			"unique_mirrors_touched": unique_mirrors_touched.size(),
			"beam_recomputes": beam_recomputes,
			"latch_activations": latch_activations,
			"open_but_incomplete_observed": 1.0 if open_but_incomplete_observed else 0.0,
			"ordered_causal_levels": ordered_causal_levels,
			"post_activation_rotations": post_activation_rotations,
			"frozen_closed_failure": 1.0 if frozen_closed_failure else 0.0,
			"reset_fingerprint_match": 1.0 if reset_fingerprint_match and reset_fingerprint_checks > 0 else 0.0,
			"maximum_trace_passes": maximum_trace_passes,
			"no_input_states_valid": 1.0 if no_input_states_valid else 0.0,
			"finale_shortest_rotations": finale_audit.shortest_rotations,
			"finale_shortest_solutions": finale_audit.shortest_solution_count,
			"finale_wake_first_shortest_solutions": finale_audit.wake_first_shortest_count,
			"finale_prepared_first_shortest_solutions": finale_audit.prepared_first_shortest_count,
			"finale_prepare_first_witness_valid": 1.0 if finale_audit.prepare_first_witness_valid else 0.0,
			"finale_wake_first_witness_valid": 1.0 if finale_audit.wake_first_witness_valid else 0.0,
			"finale_advance_preparation_required": 1.0 if finale_audit.advance_preparation_required else 0.0,
			"completion": 1.0 if mode == "won" else 0.0
		},
		"violations": violations
	}
