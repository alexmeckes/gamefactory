extends SceneTree

const SHIPPING_SIZE := Vector2i(1440, 810)
const ROOT_DIR := "res://evidence"

var _main: Node
var _world: Node
var _player: Node2D
var _capture_index: int = 0
var _samples: Array[Dictionary] = []


func _initialize() -> void:
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path("%s/captures" % ROOT_DIR))
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path("%s/motion" % ROOT_DIR))
	call_deferred("_run")


func _run() -> void:
	root.size = SHIPPING_SIZE
	_main = load("res://game/main.tscn").instantiate()
	root.add_child(_main)
	_world = _main.get_node("World")
	_player = _main.get_node("World/Player")
	await _wait_frames(6)
	await _capture("captures/planning.png", "planning")
	await _capture_motion("initial-world")

	await _hold("move_right", 120)
	await _hold("move_down", 90)
	await _capture_motion("cauldron-focus")
	_send_action("interact", true)
	await _wait_frames(1)
	await _capture("captures/action.png", "brew-action")
	await _capture_motion("brew-impact")
	await _wait_frames(1)
	_send_action("interact", false)
	await _wait_frames(12)
	await _capture_motion("bottle-settled")

	await _hold("move_up", 20)
	_send_action("move_right", true)
	var route_captured := false
	for frame in range(90):
		await physics_frame
		if not route_captured and not String(_player.get("route_effect")).is_empty():
			route_captured = true
			await _capture_motion("route-consequence")
	_send_action("move_right", false)
	await _wait_frames(1)
	await _hold("move_up", 20)

	_send_action("interact", true)
	await _wait_frames(2)
	_send_action("interact", false)
	await _wait_frames(16)
	await _capture_motion("mira-reaction")
	await _wait_frames(42)
	await _capture("captures/result.png", "delivery-result")

	await _hold("move_down", 60)
	_send_action("interact", true)
	await _wait_frames(2)
	_send_action("interact", false)
	await _wait_frames(8)
	await _capture_motion("follow-up-commit")
	await _wait_frames(6)
	await _capture_motion("resolved-hold")
	_write_trace()
	print("PRODUCTION_CAPTURE_COMPLETE")
	quit(0)


func _hold(action: String, frames: int) -> void:
	_send_action(action, true)
	await _wait_frames(frames)
	_send_action(action, false)
	await _wait_frames(1)


func _send_action(action: String, pressed: bool) -> void:
	var event := InputEventAction.new()
	event.action = action
	event.pressed = pressed
	event.strength = 1.0 if pressed else 0.0
	Input.parse_input_event(event)


func _wait_frames(count: int) -> void:
	for frame in range(count):
		await physics_frame


func _capture_motion(label: String) -> void:
	var path := "motion/frame-%03d.png" % _capture_index
	await _capture(path, label)
	_capture_index += 1


func _capture(relative_path: String, label: String) -> void:
	await RenderingServer.frame_post_draw
	var image := root.get_texture().get_image()
	var absolute_path := ProjectSettings.globalize_path("%s/%s" % [ROOT_DIR, relative_path])
	var error := image.save_png(absolute_path)
	if error != OK:
		push_error("Could not save %s (%s)" % [relative_path, error])
	_samples.append({
		"label": label,
		"path": "evidence/%s" % relative_path,
		"playerPosition": {"x": snappedf(_player.position.x, 0.01), "y": snappedf(_player.position.y, 0.01)},
		"carrying": _player.get("carrying"),
		"routeEffect": _player.get("route_effect"),
		"deliveryComplete": _world.get("delivery_complete"),
		"reaction": _world.get("last_reaction"),
		"followUpChoice": _world.get("follow_up_choice")
	})


func _write_trace() -> void:
	var payload := {
		"apiVersion": "gamefactory.candidate-capture-trace/v1",
		"producer": "candidate-authored-godot-capture",
		"trustBoundary": "Diagnostic implementation evidence only; the downstream factory-owned Godot node must establish trusted causal evidence.",
		"shippingViewport": {"width": SHIPPING_SIZE.x, "height": SHIPPING_SIZE.y},
		"inputDelivery": "Godot InputEventAction through the shipping InputMap",
		"samples": _samples
	}
	var file := FileAccess.open(ProjectSettings.globalize_path("%s/candidate-capture-trace.json" % ROOT_DIR), FileAccess.WRITE)
	if file != null:
		file.store_string(JSON.stringify(payload, "  "))
