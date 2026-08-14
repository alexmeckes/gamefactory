extends Node2D

# Production-slice presentation for the accepted graybox interaction. Decorative
# sprites sit below engine-authored orientation, state, and beam geometry. The
# deterministic contract remains evidence of stability, not human evidence of fun.

const BeamSolver = preload("res://src/beam_solver.gd")
const WORKBENCH_TEXTURE: Texture2D = preload("res://assets/illustrated/workbench-backdrop.png")
const INSTRUMENT_ATLAS: Texture2D = preload("res://assets/illustrated/instrument-atlas.png")
const VIEW := Vector2(1152, 720)
const GRID_ORIGIN := Vector2(188, 126)
const CELL := 88.0
const COLS := 8
const ROWS := 5
const DIRS := [Vector2i.RIGHT, Vector2i.DOWN, Vector2i.LEFT, Vector2i.UP]
const BOARD_RECT := Rect2(188, 126, 704, 440)
const RESET_RECT := Rect2(946, 590, 158, 54)
const ATLAS_QUAD := 627.0
const ATLAS_MOUNT := Rect2(0, 0, ATLAS_QUAD, ATLAS_QUAD)
const ATLAS_GLASS := Rect2(ATLAS_QUAD, 0, ATLAS_QUAD, ATLAS_QUAD)
const ATLAS_SOURCE := Rect2(0, ATLAS_QUAD, ATLAS_QUAD, ATLAS_QUAD)
const ATLAS_RECEIVER := Rect2(ATLAS_QUAD, ATLAS_QUAD, ATLAS_QUAD, ATLAS_QUAD)
const BG := Color("0b0d0f")
const PANEL := Color("171a1c")
const GRID := Color("665844")
const INK := Color("eee8da")
const MUTED := Color("aaa394")
const SOURCE := Color("ffb94f")
const SOURCE_HOT := Color("fff1b0")
const TARGET := Color("80d7d1")
const TARGET_HOT := Color("d4fffa")
const MIRROR := Color("9bbfc8")
const LATCH := Color("bd8c48")
const BRASS := Color("a7773f")
const BRASS_LIGHT := Color("d1a05c")
const DEEP_SHADOW := Color("060708")
const DANGER := Color("e07065")
const MIRROR_TURN_DURATION := 0.18
const BEAM_REVEAL_DURATION := 0.42
const RECEIVER_SETTLE_DURATION := 0.12
const CAPTURE_SAMPLE_DELAYS := [0.075, 0.151, 0.231, 0.280, 0.080, 0.260, 0.300]

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
var visual_latch_open := false
var pending_latch_reveal := false
var latch_reveal_threshold := 1.0
var receiver_settle := 0.0
var last_event := "cold"
var level_activation_action := -1
var level_arrival_action := -1
var level_post_activation_rotations := 0
var factory_mode := false
var factory_step := 0
var capture_stage := -1
var beam_clock := 0.0
var mirror_turns: Dictionary = {}

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
	focused_mirror = 0
	level_activation_action = -1
	level_arrival_action = -1
	level_post_activation_rotations = 0
	last_event = "cold"
	mirror_turns.clear()
	recompute_beam()
	begin_visual_recompute(false)
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
	mirror_turns[cell] = 1.0
	last_event = "mirror_rotated"
	recompute_beam()
	begin_visual_recompute(was_open)
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
		var point := cell_center(path_cell)
		if not BeamSolver.inside(path_cell, COLS, ROWS):
			point = Vector2(
				clampf(point.x, BOARD_RECT.position.x, BOARD_RECT.end.x),
				clampf(point.y, BOARD_RECT.position.y, BOARD_RECT.end.y)
			)
		beam_points.append(point)
	beam_hit = bool(trace.get("hit", false))
	beam_loop = bool(trace.get("loop", false))
	beam_termination = str(trace.get("termination", "unknown"))
	if latch_open and not beam_hit:
		open_but_incomplete_observed = true
	queue_redraw()


func beam_reveal_fraction_at(cell: Vector2i) -> float:
	if beam_points.size() < 2:
		return 1.0
	var wanted := cell_center(cell)
	for index in range(beam_points.size()):
		if beam_points[index].distance_squared_to(wanted) < 0.25:
			return clampf(float(index) / float(beam_points.size() - 1), 0.0, 1.0)
	return 1.0


func begin_visual_recompute(previous_latch_open: bool) -> void:
	receiver_settle = 0.0
	pending_latch_reveal = false
	if factory_mode:
		motion_reveal = 1.0
		visual_latch_open = latch_open
		receiver_settle = 1.0 if beam_hit else 0.0
		return
	motion_reveal = 0.0
	if not latch_open:
		visual_latch_open = false
	elif previous_latch_open:
		visual_latch_open = true
	else:
		# Simulation opens the latch immediately; its presentation changes only
		# when the same live beam reveal reaches the contacted sensor.
		visual_latch_open = false
		pending_latch_reveal = true
		latch_reveal_threshold = beam_reveal_fraction_at(current_level().latch.sensor)


func advance_presentation(elapsed: float) -> bool:
	if elapsed <= 0.0:
		return false
	if not factory_mode:
		beam_clock += elapsed
	var changed := false
	for cell in mirror_turns.keys():
		var amount := maxf(0.0, float(mirror_turns[cell]) - elapsed / MIRROR_TURN_DURATION)
		if amount <= 0.0:
			mirror_turns.erase(cell)
		else:
			mirror_turns[cell] = amount
		changed = true

	var remaining := elapsed
	if motion_reveal < 1.0:
		var reveal_time_left := (1.0 - motion_reveal) * BEAM_REVEAL_DURATION
		var reveal_elapsed := minf(remaining, reveal_time_left)
		motion_reveal = minf(1.0, motion_reveal + reveal_elapsed / BEAM_REVEAL_DURATION)
		remaining -= reveal_elapsed
		changed = true
	if pending_latch_reveal and motion_reveal + 0.0001 >= latch_reveal_threshold:
		visual_latch_open = true
		pending_latch_reveal = false
		changed = true
	if beam_hit and motion_reveal >= 0.9999 and receiver_settle < 1.0 and remaining > 0.0:
		receiver_settle = minf(1.0, receiver_settle + remaining / RECEIVER_SETTLE_DURATION)
		changed = true
	return changed


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
	var presentation_changed := advance_presentation(delta)
	if presentation_changed or (mode == "play" and not factory_mode):
		queue_redraw()
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
		elif RESET_RECT.has_point(event.position):
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


func draw_text_centered(text: String, rect: Rect2, size: int, color := INK) -> void:
	var measured := ThemeDB.fallback_font.get_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, -1, size)
	var baseline := rect.position + Vector2((rect.size.x - measured.x) * 0.5, (rect.size.y + measured.y) * 0.5 - 2.0)
	draw_text(text, baseline, size, color)


func draw_button(rect: Rect2, label: String, active := false) -> void:
	draw_rect(Rect2(rect.position + Vector2(4, 5), rect.size), Color(DEEP_SHADOW, 0.82), true)
	draw_rect(rect, Color("28231c") if not active else Color("bd7c32"), true)
	draw_rect(rect.grow(-2), Color("0c0e0f") if not active else Color("442a12"), true)
	draw_rect(rect, BRASS_LIGHT if not active else SOURCE_HOT, false, 2.0)
	draw_line(rect.position + Vector2(10, 8), rect.position + Vector2(rect.size.x - 10, 8), Color(BRASS_LIGHT, 0.52), 1.0)
	draw_text_centered(label, rect, 17, SOURCE_HOT if active else INK)


func is_production_slice() -> bool:
	return level_index == 0 or level_index == 3


func draw_workbench_base() -> void:
	draw_rect(Rect2(Vector2.ZERO, VIEW), BG, true)
	draw_texture_rect(WORKBENCH_TEXTURE, Rect2(Vector2.ZERO, VIEW), false, Color(0.78, 0.76, 0.72, 1.0))
	draw_rect(Rect2(Vector2.ZERO, VIEW), Color(0.015, 0.019, 0.021, 0.20), true)
	draw_line(Vector2(24, 24), Vector2(1128, 24), Color(BRASS_LIGHT, 0.16), 1.0)
	draw_line(Vector2(24, 696), Vector2(1128, 696), Color(DEEP_SHADOW, 0.75), 2.0)


func _draw() -> void:
	draw_workbench_base()
	if mode == "title":
		draw_title()
	elif mode == "won":
		draw_won()
	else:
		draw_game()


func draw_title() -> void:
	draw_text("A QUIET GLASSWORK", Vector2(461, 185), 14, MUTED)
	draw_text("FIREFLY", Vector2(431, 274), 30, SOURCE)
	draw_text("GLASSWORKS", Vector2(314, 342), 66, INK)
	draw_line(Vector2(368, 380), Vector2(784, 380), Color(BRASS_LIGHT, 0.58), 2.0)
	draw_text("Turn the glass. Wake the bench. Guide one living light.", Vector2(326, 423), 18, MUTED)
	draw_button(Rect2(452, 482, 248, 56), "ENTER WORKSHOP", true)


func draw_game() -> void:
	var level := current_level()
	draw_text("FIREFLY GLASSWORKS", Vector2(48, 43), 14, Color(SOURCE, 0.88))
	draw_text("%02d  /  %02d" % [level_index + 1, levels.size()], Vector2(1018, 43), 14, MUTED)
	draw_text(level.name, Vector2(48, 82), 31, INK)
	draw_text(level.lesson, Vector2(48, 109), 16, MUTED)
	draw_board()
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
	draw_control_surface()


func draw_board() -> void:
	draw_rect(BOARD_RECT.grow(13), Color(DEEP_SHADOW, 0.78), true)
	draw_rect(BOARD_RECT.grow(10), Color("2b261f"), true)
	draw_rect(BOARD_RECT.grow(10), Color(BRASS, 0.48), false, 2.0)
	draw_rect(BOARD_RECT, Color(Color("080b0d"), 0.67), true)
	draw_rect(BOARD_RECT.grow(-2), Color(Color("8e7a5e"), 0.24), false, 1.0)
	for y in range(ROWS):
		for x in range(COLS):
			var cell := Vector2i(x, y)
			var rect := Rect2(GRID_ORIGIN + Vector2(x, y) * CELL, Vector2(CELL, CELL))
			if mirrors.has(cell) and (cell == hover_cell or cell == focused_cell()):
				draw_rect(rect.grow(-6), Color(INK, 0.055), true)
				draw_rect(rect.grow(-7), Color(INK, 0.46), false, 1.0)
			draw_rect(rect, Color(GRID, 0.29), false, 1.0)
	for corner in [BOARD_RECT.position, BOARD_RECT.position + Vector2(BOARD_RECT.size.x, 0), BOARD_RECT.end, BOARD_RECT.position + Vector2(0, BOARD_RECT.size.y)]:
		draw_circle(corner, 4.5, Color(DEEP_SHADOW, 0.9))
		draw_circle(corner, 2.5, BRASS)


func draw_control_surface() -> void:
	draw_line(Vector2(922, 126), Vector2(922, 560), Color(BRASS_LIGHT, 0.28), 1.0)
	draw_line(Vector2(928, 126), Vector2(928, 560), Color(DEEP_SHADOW, 0.72), 2.0)
	draw_text("BENCH CONTROL", Vector2(946, 155), 13, MUTED)
	draw_line(Vector2(946, 169), Vector2(1092, 169), Color(BRASS_LIGHT, 0.26), 1.0)
	draw_text("TURN", Vector2(946, 217), 14, INK)
	draw_text("CLICK  /  SPACE", Vector2(946, 241), 13, MUTED)
	draw_circle(Vector2(1082, 213), 11, Color(DEEP_SHADOW, 0.9))
	draw_line(Vector2(1075, 220), Vector2(1089, 206), MIRROR, 3.0)
	draw_text("FOCUS", Vector2(946, 292), 14, INK)
	draw_text("ARROWS  /  TAB", Vector2(946, 316), 13, MUTED)
	if beam_loop:
		draw_text("LOOP", Vector2(946, 370), 14, DANGER)
		draw_rect(Rect2(946, 381, 74, 2), DANGER, true)
	draw_button(RESET_RECT, "RESET  [R]")
	draw_text("STATE RESTORES AT ONCE", Vector2(946, 666), 11, Color(MUTED, 0.68))


func draw_atlas_region(center: Vector2, size: Vector2, region: Rect2, modulate := Color.WHITE) -> void:
	draw_texture_rect_region(INSTRUMENT_ATLAS, Rect2(center - size * 0.5, size), region, modulate)


func draw_source(cell: Vector2i, direction: int) -> void:
	var center := cell_center(cell)
	draw_circle(center + Vector2(2, 4), 31, Color(DEEP_SHADOW, 0.62))
	if is_production_slice():
		draw_atlas_region(center, Vector2(78, 78), ATLAS_SOURCE, Color(0.82, 0.78, 0.70, 1.0))
	else:
		draw_circle(center, 26, Color(BRASS, 0.72))
		draw_circle(center, 19, PANEL)
	draw_circle(center, 12, Color(SOURCE, 0.44))
	draw_circle(center, 7, SOURCE)
	draw_circle(center - Vector2(2, 2), 2.4, SOURCE_HOT)
	var heading := Vector2(DIRS[direction])
	draw_line(center + heading * 18.0, center + heading * 34.0, DEEP_SHADOW, 8.0)
	draw_line(center + heading * 18.0, center + heading * 34.0, BRASS_LIGHT, 5.0)
	draw_line(center + heading * 22.0, center + heading * 38.0, SOURCE_HOT, 1.5)


func draw_target(cell: Vector2i) -> void:
	var center := cell_center(cell)
	var settle := receiver_settle if beam_hit else 0.0
	var visibly_arrived := settle > 0.0
	var eased_settle := settle * settle * (3.0 - 2.0 * settle)
	draw_circle(center + Vector2(2, 4), 32, Color(DEEP_SHADOW, 0.68))
	if is_production_slice():
		draw_atlas_region(center, Vector2(79, 79), ATLAS_RECEIVER, Color(0.74, 0.78, 0.80, 1.0))
	else:
		draw_circle(center, 27, Color(BRASS, 0.58))
		draw_circle(center, 21, PANEL)
	draw_circle(center, 19, Color(TARGET, lerpf(0.24, 0.68, eased_settle)))
	draw_circle(center, 19, Color(TARGET, lerpf(0.76, 1.0, eased_settle)), false, 2.5)
	draw_circle(center, lerpf(10.0, 11.5, eased_settle), DEEP_SHADOW if not visibly_arrived else Color(TARGET, eased_settle))
	if visibly_arrived:
		draw_circle(center, lerpf(2.0, 5.0, eased_settle), Color(TARGET_HOT, eased_settle))
		for direction in DIRS:
			draw_line(center + Vector2(direction) * 23.0, center + Vector2(direction) * lerpf(24.0, 29.0, eased_settle), Color(TARGET_HOT, eased_settle), 2.0)
	else:
		draw_circle(center, 4, Color(INK, 0.28), false, 1.0)


func mirror_base_angle(orientation: int) -> float:
	# The solver contract defines 0 as '/' and 1 as '\\'. A vertical atlas
	# blade therefore rotates +45 degrees for 0 in screen coordinates.
	return PI * 0.25 if orientation == 0 else -PI * 0.25


func draw_mirror(cell: Vector2i, orientation: int, focused: bool) -> void:
	var center := cell_center(cell)
	draw_set_transform(center + Vector2(2, 5), 0.0, Vector2(1.0, 0.40))
	draw_circle(Vector2.ZERO, 34, Color(DEEP_SHADOW, 0.64))
	draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)
	if is_production_slice():
		draw_atlas_region(center, Vector2(76, 76), ATLAS_MOUNT, Color(0.78, 0.74, 0.66, 1.0))
	else:
		draw_circle(center, 29, Color(BRASS, 0.54))
		draw_circle(center, 23, PANEL)
	var base_angle := mirror_base_angle(orientation)
	var turn := float(mirror_turns.get(cell, 0.0))
	var eased_turn := turn * turn * (3.0 - 2.0 * turn)
	var angle := base_angle - eased_turn * PI * 0.5
	if is_production_slice():
		draw_set_transform(center, angle, Vector2.ONE)
		draw_texture_rect_region(INSTRUMENT_ATLAS, Rect2(-43, -43, 86, 86), ATLAS_GLASS, Color(0.82, 0.89, 0.92, 1.0))
		draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)
	var axis := Vector2(0, -28).rotated(angle)
	draw_line(center - axis, center + axis, Color(DEEP_SHADOW, 0.84), 8.0)
	draw_line(center - axis, center + axis, MIRROR, 4.0)
	draw_line(center - axis * 0.86, center + axis * 0.86, Color(INK, 0.88), 1.4)
	draw_circle(center, 4.5, BRASS_LIGHT)
	draw_circle(center, 2.0, INK)
	if focused:
		draw_circle(center, 39, Color(INK, 0.92), false, 1.5)
		for direction in DIRS:
			var normal := Vector2(direction)
			draw_line(center + normal * 35.0, center + normal * 41.0, SOURCE_HOT, 2.0)


func draw_latch_link(sensor: Vector2i, shutter: Vector2i) -> void:
	var start := cell_center(sensor) + Vector2(30, 0)
	var finish := cell_center(shutter) + Vector2(30, 0)
	var middle := Vector2(finish.x, start.y)
	var route := PackedVector2Array([start, middle, finish])
	draw_polyline(route, Color(DEEP_SHADOW, 0.88), 8.0)
	draw_polyline(route, BRASS if not visual_latch_open else BRASS_LIGHT, 4.0)
	draw_polyline(route, Color(INK, 0.26) if not visual_latch_open else Color(SOURCE_HOT, 0.54), 1.0)
	draw_circle(middle, 6, DEEP_SHADOW)
	draw_circle(middle, 3.5, BRASS_LIGHT if visual_latch_open else BRASS)


func draw_sensor(cell: Vector2i) -> void:
	var center := cell_center(cell)
	draw_circle(center + Vector2(2, 4), 31, Color(DEEP_SHADOW, 0.62))
	if is_production_slice():
		draw_atlas_region(center, Vector2(72, 72), ATLAS_MOUNT, Color(0.75, 0.72, 0.66, 1.0))
	else:
		draw_circle(center, 27, Color(BRASS, 0.62))
	draw_circle(center, 18, PANEL if not visual_latch_open else Color(SOURCE, 0.34))
	draw_circle(center, 18, BRASS_LIGHT, false, 2.5)
	draw_circle(center, 5 if not visual_latch_open else 11, Color(INK, 0.72) if not visual_latch_open else SOURCE_HOT, visual_latch_open)
	if visual_latch_open:
		draw_rect(Rect2(center - Vector2(6, 6), Vector2(12, 12)), Color(SOURCE, 0.66), false, 2.0)
	else:
		draw_circle(center, 8, Color(DEEP_SHADOW, 0.96), false, 2.0)
	for direction in DIRS:
		draw_line(center + Vector2(direction) * 29.0, center + Vector2(direction) * 35.0, BRASS_LIGHT, 3.0)


func draw_shutter(cell: Vector2i) -> void:
	var center := cell_center(cell)
	draw_line(center + Vector2(-38, -27), center + Vector2(38, -27), Color(DEEP_SHADOW, 0.88), 7.0)
	draw_line(center + Vector2(-38, 27), center + Vector2(38, 27), Color(DEEP_SHADOW, 0.88), 7.0)
	draw_line(center + Vector2(-38, -27), center + Vector2(38, -27), BRASS, 3.0)
	draw_line(center + Vector2(-38, 27), center + Vector2(38, 27), BRASS, 3.0)
	if visual_latch_open:
		draw_rect(Rect2(center + Vector2(-38, -23), Vector2(19, 46)), Color("6d573b"), true)
		draw_rect(Rect2(center + Vector2(19, -23), Vector2(19, 46)), Color("6d573b"), true)
		draw_rect(Rect2(center + Vector2(-35, -20), Vector2(12, 40)), BRASS_LIGHT, false, 2.0)
		draw_rect(Rect2(center + Vector2(23, -20), Vector2(12, 40)), BRASS_LIGHT, false, 2.0)
		draw_line(center + Vector2(-15, -22), center + Vector2(-15, 22), SOURCE_HOT, 2.0)
		draw_line(center + Vector2(15, -22), center + Vector2(15, 22), SOURCE_HOT, 2.0)
	else:
		draw_rect(Rect2(center + Vector2(-38, -16), Vector2(76, 32)), Color(DEEP_SHADOW, 0.86), true)
		draw_rect(Rect2(center + Vector2(-35, -13), Vector2(70, 26)), Color("6d573b"), true)
		draw_rect(Rect2(center + Vector2(-32, -10), Vector2(64, 20)), Color("332e28"), true)
		draw_line(center + Vector2(-30, -7), center + Vector2(30, -7), BRASS_LIGHT, 2.0)
		draw_line(center + Vector2(-30, 7), center + Vector2(30, 7), Color(DEEP_SHADOW, 0.92), 2.0)
		draw_line(center + Vector2(-26, 0), center + Vector2(26, 0), INK, 2.5)


func draw_beam() -> void:
	if beam_points.size() < 2:
		return
	var total_segments := beam_points.size() - 1
	var visible := clampf(motion_reveal, 0.0, 1.0) * float(total_segments)
	var leading_point := beam_points[0]
	for index in range(total_segments):
		var amount := clampf(visible - float(index), 0.0, 1.0)
		if amount <= 0.0:
			break
		var start := beam_points[index]
		var finish := start.lerp(beam_points[index + 1], amount)
		leading_point = finish
		draw_line(start, finish, Color(DEEP_SHADOW, 0.92), 13.0)
		draw_line(start, finish, Color(SOURCE, 0.22), 9.0)
		draw_line(start, finish, SOURCE, 3.5)
		draw_line(start, finish, Color(SOURCE_HOT, 0.92), 1.1)
		if index > 0 and amount >= 0.999:
			draw_circle(start, 6.5, Color(DEEP_SHADOW, 0.82))
			draw_circle(start, 3.2, SOURCE_HOT)
	var pulse := 0.5 + 0.5 * sin(beam_clock * 7.0)
	draw_circle(leading_point, 7.0 + pulse * 2.0, Color(SOURCE, 0.12))
	draw_circle(leading_point, 3.4, SOURCE_HOT)
	draw_circle(leading_point, 1.5, Color.WHITE)


func draw_won() -> void:
	draw_text("RECEIVER LIT", Vector2(454, 250), 15, TARGET)
	draw_text("THE WORKSHOP REMEMBERS", Vector2(250, 329), 45, INK)
	draw_text("One route opened another. The glass is ready to turn again.", Vector2(328, 380), 18, MUTED)
	draw_button(Rect2(452, 458, 248, 56), "RUN AGAIN", true)


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
	# Deterministic stills sample elapsed time through the exact update used by
	# _process. No capture-only reveal, contact, or arrival state is assigned.
	advance_presentation(CAPTURE_SAMPLE_DELAYS[clampi(index, 0, 6)])
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
