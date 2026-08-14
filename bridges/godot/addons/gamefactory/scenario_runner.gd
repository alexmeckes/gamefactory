extends SceneTree

var _output_dir := ""

func _initialize() -> void:
	call_deferred("_run")

func _argument(name: String) -> String:
	var args := OS.get_cmdline_user_args()
	var index := args.find(name)
	if index < 0 or index + 1 >= args.size():
		return ""
	return args[index + 1]

func _write_json(path: String, value: Variant) -> void:
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file:
		file.store_string(JSON.stringify(value, "  "))
		file.store_string("\n")

func _append_telemetry(file: FileAccess, value: Dictionary) -> void:
	file.store_line(JSON.stringify(value))

func _fail(code: String, message: String, exit_code := 1) -> void:
	if not _output_dir.is_empty():
		_write_json(_output_dir.path_join("result.json"), {
			"status": "crash",
			"metrics": {},
			"artifacts": [],
			"violations": [{"code": code, "message": message, "severity": "error"}]
		})
	push_error(message)
	quit(exit_code)

func _run() -> void:
	var request_path := _argument("--request")
	_output_dir = _argument("--output")
	if request_path.is_empty() or _output_dir.is_empty():
		_fail("factory.arguments", "Expected --request and --output arguments.")
		return
	DirAccess.make_dir_recursive_absolute(_output_dir)
	var request_file := FileAccess.open(request_path, FileAccess.READ)
	if not request_file:
		_fail("factory.request", "Cannot open scenario request: " + request_path)
		return
	var request = JSON.parse_string(request_file.get_as_text())
	if not request is Dictionary:
		_fail("factory.request", "Scenario request is not a JSON object.")
		return
	var scene_path: String = request.get("path", "res://main.tscn")
	var parameters: Dictionary = request.get("parameters", {})
	var packed = load(scene_path)
	if not packed is PackedScene:
		_fail("factory.scene", "Cannot load PackedScene: " + scene_path)
		return
	var subject: Node = packed.instantiate()
	root.add_child(subject)
	var seed_value: int = int(parameters.get("seed", 1))
	seed(seed_value)
	var ticks: int = maxi(1, int(parameters.get("ticks", 120)))
	var physics_hz: int = maxi(1, int(parameters.get("physics_hz", 60)))
	Engine.physics_ticks_per_second = physics_hz
	var requested_capture_ticks: Array = parameters.get("capture_ticks", [])
	var capture_ticks: Array[int] = []
	for capture_tick in requested_capture_ticks:
		capture_ticks.append(int(capture_tick))
	var captured_ticks: Array[int] = []
	var telemetry_path := _output_dir.path_join("telemetry.jsonl")
	var telemetry := FileAccess.open(telemetry_path, FileAccess.WRITE)
	if subject.has_method("factory_setup"):
		subject.call("factory_setup", parameters)
	for tick in range(ticks):
		if subject.has_method("factory_tick"):
			subject.call("factory_tick", tick)
		await physics_frame
		var sample := {"tick": tick}
		if subject.has_method("factory_sample"):
			var custom_sample = subject.call("factory_sample")
			if custom_sample is Dictionary:
				sample.merge(custom_sample, true)
		_append_telemetry(telemetry, sample)
		if capture_ticks.has(tick):
			await RenderingServer.frame_post_draw
			var image := root.get_texture().get_image()
			if image and image.save_png(_output_dir.path_join("frame-%06d.png" % tick)) == OK:
				captured_ticks.append(tick)
	var metrics := {
		"ticks_completed": ticks,
		"completion": 1.0,
		"simulated_seconds": float(ticks) / float(physics_hz)
	}
	var violations: Array = []
	if subject.has_method("factory_collect"):
		var collected = subject.call("factory_collect")
		if collected is Dictionary:
			metrics.merge(collected.get("metrics", {}), true)
			violations.append_array(collected.get("violations", []))
	var artifacts: Array = [{
		"kind": "telemetry",
		"path": telemetry_path,
		"mediaType": "application/x-ndjson",
		"label": "Deterministic scenario telemetry"
	}]
	for capture_tick in captured_ticks:
		artifacts.append({
			"kind": "image",
			"path": _output_dir.path_join("frame-%06d.png" % int(capture_tick)),
			"mediaType": "image/png",
			"label": "Scenario frame %s" % capture_tick
		})
	_write_json(_output_dir.path_join("result.json"), {
		"status": "pass" if violations.is_empty() else "fail",
		"metrics": metrics,
		"artifacts": artifacts,
		"violations": violations,
		"metadata": {
			"provider": request.get("provider", "godot.factory/v1"),
			"version": request.get("version", "1"),
			"seed": seed_value,
			"physics_hz": physics_hz,
			"requested_capture_ticks": requested_capture_ticks,
			"captured_ticks": captured_ticks
		}
	})
	quit(0 if violations.is_empty() else 1)
