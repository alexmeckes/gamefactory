extends Node2D

const VIEW_SIZE := Vector2(1152.0, 720.0)
const POINT_COUNT := 24
const ROPE_COLOR := Color("eac37b")

var points: Array[Vector2] = []
var grabbed := -1
var pinned: Dictionary = {}
var factory_mode := false
var factory_ticks := 0
var title := Label.new()
var subtitle := Label.new()

func _ready() -> void:
	_build_interface()
	_reset_rope()

func _build_interface() -> void:
	title.position = Vector2(36.0, 24.0)
	title.text = "KNOT THEORY"
	title.add_theme_font_size_override("font_size", 32)
	title.add_theme_color_override("font_color", Color("f2e7d5"))
	add_child(title)
	subtitle.position = Vector2(38.0, 68.0)
	subtitle.text = "Prototype loom — drag the string  •  P pins a point  •  R resets"
	subtitle.add_theme_font_size_override("font_size", 16)
	subtitle.add_theme_color_override("font_color", Color("91a3a8"))
	add_child(subtitle)

func _reset_rope() -> void:
	points.clear()
	pinned.clear()
	for index in range(POINT_COUNT):
		var t := float(index) / float(POINT_COUNT - 1)
		points.append(Vector2(150.0 + t * 850.0, 360.0 + sin(t * TAU * 1.5) * 80.0))
	queue_redraw()

func _unhandled_input(event: InputEvent) -> void:
	if factory_mode:
		return
	if event is InputEventKey and event.pressed:
		if event.keycode == KEY_R:
			_reset_rope()
		elif event.keycode == KEY_P and grabbed >= 0:
			if pinned.has(grabbed):
				pinned.erase(grabbed)
			else:
				pinned[grabbed] = points[grabbed]
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT:
		if event.pressed:
			grabbed = _nearest_point(event.position, 42.0)
		else:
			grabbed = -1
	if event is InputEventMouseMotion and grabbed >= 0 and not pinned.has(grabbed):
		points[grabbed] = event.position
		_relax_rope(10)
		queue_redraw()

func _nearest_point(position: Vector2, radius: float) -> int:
	var best := -1
	var best_distance := radius
	for index in range(points.size()):
		var distance := points[index].distance_to(position)
		if distance < best_distance:
			best = index
			best_distance = distance
	return best

func _relax_rope(iterations: int) -> void:
	var target_length := 38.0
	for iteration in range(iterations):
		for index in range(points.size() - 1):
			var delta := points[index + 1] - points[index]
			var distance := maxf(delta.length(), 0.001)
			var correction := delta * ((distance - target_length) / distance) * 0.5
			if not pinned.has(index) and index != grabbed:
				points[index] += correction
			if not pinned.has(index + 1) and index + 1 != grabbed:
				points[index + 1] -= correction

func _draw() -> void:
	draw_rect(Rect2(Vector2.ZERO, VIEW_SIZE), Color("10191c"))
	for x in range(0, int(VIEW_SIZE.x), 48):
		draw_line(Vector2(x, 108.0), Vector2(x, VIEW_SIZE.y), Color(0.18, 0.25, 0.26, 0.25), 1.0)
	for y in range(108, int(VIEW_SIZE.y), 48):
		draw_line(Vector2(0.0, y), Vector2(VIEW_SIZE.x, y), Color(0.18, 0.25, 0.26, 0.25), 1.0)
	if points.size() > 1:
		draw_polyline(PackedVector2Array(points), Color("3b2418"), 13.0, true)
		draw_polyline(PackedVector2Array(points), ROPE_COLOR, 7.0, true)
	for index in range(points.size()):
		if pinned.has(index):
			draw_circle(points[index], 12.0, Color("d8644d"))
			draw_circle(points[index], 5.0, Color("fff1dd"))
	for endpoint in [0, points.size() - 1]:
		draw_circle(points[endpoint], 10.0, Color("f7ead0"))

func factory_setup(parameters: Dictionary) -> void:
	factory_mode = true
	factory_ticks = 0
	_reset_rope()

func factory_tick(tick: int) -> void:
	factory_ticks = tick + 1
	if points.is_empty():
		return
	var phase := float(tick) / 45.0
	points[points.size() - 1] = Vector2(760.0 + cos(phase) * 120.0, 360.0 + sin(phase) * 140.0)
	grabbed = points.size() - 1
	_relax_rope(4)
	grabbed = -1
	queue_redraw()

func factory_sample() -> Dictionary:
	return {
		"rope_points": points.size(),
		"pinned_points": pinned.size(),
		"factory_ticks": factory_ticks
	}

func factory_collect() -> Dictionary:
	return {
		"metrics": {
			"scenario_score": 0.05,
			"rope_points": points.size(),
			"levels_playable": 0,
			"goals_detected": 0,
			"interaction_modes": 1
		},
		"violations": []
	}
