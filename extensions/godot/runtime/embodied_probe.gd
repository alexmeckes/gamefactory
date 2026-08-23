extends SceneTree

const TRACE_PROTOCOL := "gamefactory.embodied-trace/v1"
const PRODUCER := "factory-owned-godot-probe"

var _output_dir := ""
var _samples: Array = []
var _artifacts: Array = []
var _violations: Array = []
var _captured_frames := 0
var _max_state_latency_frames := 0

func _initialize() -> void:
	call_deferred("_run")

func _argument(name: String) -> String:
	var args := OS.get_cmdline_user_args()
	var index := args.find(name)
	if index < 0 or index + 1 >= args.size():
		return ""
	return args[index + 1]

func _write_json(path: String, value: Variant) -> bool:
	var file := FileAccess.open(path, FileAccess.WRITE)
	if not file:
		return false
	file.store_string(JSON.stringify(value, "  "))
	file.store_string("\n")
	return true

func _finish_failure(code: String, message: String) -> void:
	_violations.append({"code": code, "message": message, "severity": "error"})
	if not _output_dir.is_empty():
		_write_json(_output_dir.path_join("result.json"), {
			"status": "fail",
			"metrics": {"embodied_probe_completed": 0},
			"artifacts": _artifacts,
			"violations": _violations,
			"metadata": {"producer": PRODUCER}
		})
	push_error(message)
	quit(1)

func _node_position(node: Node) -> Variant:
	if node is Node2D:
		return (node as Node2D).global_position
	if node is Control:
		return (node as Control).global_position
	return null

func _node_visible(node: Node) -> bool:
	return node is CanvasItem and (node as CanvasItem).is_visible_in_tree()

func _point(value: Vector2) -> Dictionary:
	return {"x": value.x, "y": value.y}

func _observe(subject: Node, definitions: Array) -> Dictionary:
	var observed := {}
	for raw_definition in definitions:
		if not raw_definition is Dictionary:
			continue
		var definition: Dictionary = raw_definition
		var node_path := String(definition.get("nodePath", ""))
		var property_name := String(definition.get("property", ""))
		if node_path.is_empty() or property_name.is_empty():
			continue
		var node := subject.get_node_or_null(NodePath(node_path))
		if node == null:
			continue
		var id := String(definition.get("id", node_path + "." + property_name))
		observed[id] = node.get(property_name)
	return observed

func _state_changed(before_state: Dictionary, after_state: Dictionary, definitions: Array) -> bool:
	for raw_definition in definitions:
		if not raw_definition is Dictionary:
			continue
		var definition: Dictionary = raw_definition
		var observation_id := String(definition.get("id", String(definition.get("nodePath", "")) + "." + String(definition.get("property", ""))))
		if before_state.has(observation_id) and after_state.has(observation_id) and before_state[observation_id] != after_state[observation_id]:
			return true
	return false

func _capture(frame_index: int) -> void:
	await RenderingServer.frame_post_draw
	var image := root.get_texture().get_image()
	if image == null or image.is_empty():
		return
	var filename := "embodied-frame-%06d.png" % frame_index
	var path := _output_dir.path_join(filename)
	if image.save_png(path) == OK:
		_captured_frames += 1
		_artifacts.append({
			"kind": "image",
			"path": path,
			"mediaType": "image/png",
			"label": "Factory-owned continuous gameplay frame %d" % frame_index,
			"metadata": {"evidenceRole": "continuous-frame", "producer": PRODUCER, "frame": frame_index}
		})

func _inject_action(action: String, pressed: bool, strength: float) -> void:
	var event := InputEventAction.new()
	event.action = StringName(action)
	event.pressed = pressed
	event.strength = strength if pressed else 0.0
	Input.parse_input_event(event)

func _run() -> void:
	var request_path := _argument("--request")
	_output_dir = _argument("--output")
	if request_path.is_empty() or _output_dir.is_empty():
		_finish_failure("godot.embodied.arguments", "Expected --request and --output arguments.")
		return
	DirAccess.make_dir_recursive_absolute(_output_dir)
	var request_file := FileAccess.open(request_path, FileAccess.READ)
	if not request_file:
		_finish_failure("godot.embodied.request", "Cannot open scenario request: " + request_path)
		return
	var request = JSON.parse_string(request_file.get_as_text())
	if not request is Dictionary:
		_finish_failure("godot.embodied.request", "Scenario request is not a JSON object.")
		return
	var parameters = request.get("parameters", {})
	if not parameters is Dictionary:
		_finish_failure("godot.embodied.parameters", "Scenario parameters must be an object.")
		return
	var probe = parameters.get("embodiedProbe", {})
	if not probe is Dictionary:
		_finish_failure("godot.embodied.probe-config", "parameters.embodiedProbe must be an object.")
		return
	var actor_path := String(probe.get("actorPath", ""))
	var steps = probe.get("steps", [])
	var observations = probe.get("stateObservations", [])
	if actor_path.is_empty() or not steps is Array or steps.is_empty():
		_finish_failure("godot.embodied.probe-config", "embodiedProbe requires actorPath and at least one input step.")
		return
	if not observations is Array or observations.is_empty():
		_finish_failure("godot.embodied.probe-config", "embodiedProbe requires at least one state observation.")
		return
	var scene_path := String(request.get("path", "res://main.tscn"))
	var packed = load(scene_path)
	if not packed is PackedScene:
		_finish_failure("godot.embodied.scene", "Cannot load PackedScene: " + scene_path)
		return
	var subject: Node = packed.instantiate()
	root.add_child(subject)
	var actor := subject.get_node_or_null(NodePath(actor_path))
	if actor == null or _node_position(actor) == null:
		_finish_failure("godot.embodied.actor", "actorPath must resolve to a Node2D or Control: " + actor_path)
		return
	var default_target_path := String(probe.get("targetPath", ""))
	var interaction_action := String(probe.get("interactionAction", "interact"))
	var interaction_range := float(probe.get("interactionRange", 64.0))
	var physics_hz := maxi(1, int(parameters.get("physics_hz", 60)))
	Engine.physics_ticks_per_second = physics_hz
	var capture_every := maxi(1, int(probe.get("captureEveryFrames", 8)))
	var default_settle_frames := clampi(int(probe.get("settleFrames", 0)), 0, 60)
	var quiescence_frames := clampi(int(probe.get("quiescenceFrames", 3)), 1, 60)
	var quiescence_position_tolerance := maxf(float(probe.get("quiescencePositionTolerance", 0.001)), 0.0)
	var frame_index := 0
	await physics_frame
	var before_state := _observe(subject, observations)
	var before_position: Vector2 = _node_position(actor)
	_samples.append({
		"time": 0.0,
		"input": {"delivery": "godot-input-event", "kind": "initial", "action": ""},
		"actor": {"id": actor_path, "visible": _node_visible(actor), "position": _point(_node_position(actor))},
		"events": []
	})
	await _capture(frame_index)
	for ignored_frame in range(quiescence_frames):
		await physics_frame
		frame_index += 1
		if frame_index % capture_every == 0:
			await _capture(frame_index)
	var quiescent_state := _observe(subject, observations)
	var quiescent_position: Vector2 = _node_position(actor)
	if _state_changed(before_state, quiescent_state, observations):
		_violations.append({"code": "godot.embodied.counterfactual-state-change", "message": "Observed runtime state changed before any player input was delivered.", "severity": "error"})
	if before_position.distance_to(quiescent_position) > quiescence_position_tolerance:
		_violations.append({"code": "godot.embodied.counterfactual-motion", "message": "The actor moved before any player input was delivered.", "severity": "error"})
	_samples.append({
		"time": float(frame_index) / float(physics_hz),
		"input": {"delivery": "none", "kind": "counterfactual", "action": ""},
		"actor": {"id": actor_path, "visible": _node_visible(actor), "position": _point(quiescent_position)},
		"events": []
	})
	before_state = quiescent_state
	for raw_step in steps:
		if not raw_step is Dictionary:
			_finish_failure("godot.embodied.step", "Every embodiedProbe step must be an object.")
			return
		var step: Dictionary = raw_step
		var action := String(step.get("action", ""))
		var pressed := bool(step.get("pressed", true))
		var strength := clampf(float(step.get("strength", 1.0)), 0.0, 1.0)
		var frames := maxi(1, int(step.get("frames", 1)))
		var kind := String(step.get("kind", "action"))
		# A player-complete loop can interact with several world entities. Let each
		# shipping-input step identify the entity whose in-range causal interaction
		# it is proving, while retaining the top-level targetPath as a default.
		var target_path := String(step.get("targetPath", default_target_path))
		var target := subject.get_node_or_null(NodePath(target_path)) if not target_path.is_empty() else null
		if action.is_empty() or not InputMap.has_action(StringName(action)):
			_finish_failure("godot.embodied.input-map", "Probe action is absent from the shipping InputMap: " + action)
			return
		_inject_action(action, pressed, strength)
		for ignored_frame in range(frames):
			await physics_frame
			frame_index += 1
			if frame_index % capture_every == 0:
				await _capture(frame_index)
		var after_state := _observe(subject, observations)
		var latency_frames := 0
		# Shipping actions can commit their visible consequence on the following
		# physics tick. Observe a small, declared settle window so that consequence
		# remains attributable to the input that caused it. This does not hide
		# responsiveness: the measured latency is retained in the trace and metrics.
		var settle_frames := clampi(int(step.get("settleFrames", default_settle_frames)), 0, 60) if kind == "action" and pressed else 0
		while latency_frames < settle_frames and not _state_changed(before_state, after_state, observations):
			await physics_frame
			latency_frames += 1
			frame_index += 1
			if frame_index % capture_every == 0:
				await _capture(frame_index)
			after_state = _observe(subject, observations)
		_max_state_latency_frames = maxi(_max_state_latency_frames, latency_frames if _state_changed(before_state, after_state, observations) else 0)
		var events: Array = []
		var changed := false
		for raw_definition in observations:
			var definition: Dictionary = raw_definition
			var observation_id := String(definition.get("id", String(definition.get("nodePath", "")) + "." + String(definition.get("property", ""))))
			if before_state.has(observation_id) and after_state.has(observation_id) and before_state[observation_id] != after_state[observation_id]:
				changed = true
				events.append({
					"kind": "state-change",
					"cause": "player-input",
					"state": String(definition.get("state", observation_id)),
					"before": before_state[observation_id],
					"after": after_state[observation_id],
					"latencyFrames": latency_frames
				})
		if action == interaction_action and pressed and target != null:
			var actor_position: Vector2 = _node_position(actor)
			var target_position = _node_position(target)
			if target_position != null:
				var distance := actor_position.distance_to(target_position)
				events.append({
					"kind": "spatial-interaction",
					"targetId": target_path,
					"distance": distance,
					"range": interaction_range,
					"outcome": "applied" if distance <= interaction_range and changed else "not-applied"
				})
		_samples.append({
			"time": float(frame_index) / float(physics_hz),
			"input": {"delivery": "godot-input-event", "kind": kind, "action": action, "pressed": pressed, "strength": strength},
			"actor": {"id": actor_path, "visible": _node_visible(actor), "position": _point(_node_position(actor))},
			"events": events
		})
		before_state = after_state
	if _artifacts.is_empty() or int((_artifacts.back() as Dictionary).get("metadata", {}).get("frame", -1)) != frame_index:
		await _capture(frame_index)
	for raw_step in steps:
		if raw_step is Dictionary:
			var action := String((raw_step as Dictionary).get("action", ""))
			if not action.is_empty():
				_inject_action(action, false, 0.0)
	var trace_path := _output_dir.path_join("embodied-trace.json")
	if not _write_json(trace_path, {
		"apiVersion": TRACE_PROTOCOL,
		"producer": PRODUCER,
		"scene": scene_path,
		"actorPath": actor_path,
		"samples": _samples
	}):
		_finish_failure("godot.embodied.trace-write", "Could not write the embodied gameplay trace.")
		return
	_artifacts.push_front({
		"kind": "replay",
		"path": trace_path,
		"mediaType": "application/json",
		"label": "Factory-owned embodied gameplay trace",
		"metadata": {"protocol": TRACE_PROTOCOL, "producer": PRODUCER}
	})
	if _captured_frames < 2:
		_violations.append({"code": "godot.embodied.capture", "message": "Factory probe captured fewer than two engine frames.", "severity": "error"})
	_write_json(_output_dir.path_join("result.json"), {
		"status": "pass" if _violations.is_empty() else "fail",
		"metrics": {
			"embodied_probe_completed": 1,
			"embodied_probe_input_events": steps.size(),
			"embodied_probe_frames": _captured_frames,
			"embodied_probe_quiescence_frames": quiescence_frames,
			"embodied_probe_max_consequence_latency_frames": _max_state_latency_frames,
			"embodied_probe_seconds": float(frame_index) / float(physics_hz)
		},
		"artifacts": _artifacts,
		"violations": _violations,
		"metadata": {"producer": PRODUCER, "factoryOwned": true}
	})
	quit(0 if _violations.is_empty() else 1)
