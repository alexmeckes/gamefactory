extends SceneTree

var output_dir := ""

func _initialize() -> void:
	call_deferred("run_scenario")

func argument(name: String) -> String:
	var args := OS.get_cmdline_user_args()
	var index := args.find(name)
	return "" if index < 0 or index + 1 >= args.size() else args[index + 1]

func write_json(path: String, value: Variant) -> void:
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file:
		file.store_string(JSON.stringify(value, "  ") + "\n")

func fail(code: String, message: String) -> void:
	if not output_dir.is_empty():
		write_json(output_dir.path_join("result.json"), {
			"status": "crash", "metrics": {}, "artifacts": [],
			"violations": [{"code": code, "message": message, "severity": "error"}]
		})
	push_error(message)
	quit(1)

func run_scenario() -> void:
	var request_path := argument("--request")
	output_dir = argument("--output")
	if request_path.is_empty() or output_dir.is_empty():
		fail("factory.arguments", "Expected --request and --output arguments.")
		return
	DirAccess.make_dir_recursive_absolute(output_dir)
	var request_file := FileAccess.open(request_path, FileAccess.READ)
	if not request_file:
		fail("factory.request", "Cannot open the scenario request.")
		return
	var request = JSON.parse_string(request_file.get_as_text())
	if not request is Dictionary:
		fail("factory.request", "Scenario request is not an object.")
		return
	var packed = load(request.get("path", "res://main.tscn"))
	if not packed is PackedScene:
		fail("factory.scene", "Cannot load scenario scene.")
		return
	var subject: Node = packed.instantiate()
	root.add_child(subject)
	var parameters: Dictionary = request.get("parameters", {})
	var ticks: int = maxi(1, int(parameters.get("ticks", 120)))
	var physics_hz: int = maxi(1, int(parameters.get("physics_hz", 60)))
	var seed_value: int = int(parameters.get("seed", 1))
	seed(seed_value)
	Engine.physics_ticks_per_second = physics_hz
	var telemetry_path := output_dir.path_join("telemetry.jsonl")
	var telemetry := FileAccess.open(telemetry_path, FileAccess.WRITE)
	if subject.has_method("factory_setup"):
		subject.call("factory_setup", parameters)
	for tick in range(ticks):
		if subject.has_method("factory_tick"):
			subject.call("factory_tick", tick)
		await physics_frame
		var sample := {"tick": tick}
		if subject.has_method("factory_sample"):
			var custom = subject.call("factory_sample")
			if custom is Dictionary:
				sample.merge(custom, true)
		telemetry.store_line(JSON.stringify(sample))
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
	else:
		violations.append({"code": "knot-theory.factory-hooks", "message": "Missing factory_collect.", "severity": "error"})
	var artifacts: Array = [{
		"kind": "telemetry",
		"path": telemetry_path,
		"mediaType": "application/x-ndjson",
		"label": "Knot Theory deterministic telemetry"
	}]
	write_json(output_dir.path_join("result.json"), {
		"status": "pass" if violations.is_empty() else "fail",
		"metrics": metrics,
		"violations": violations,
		"artifacts": artifacts,
		"metadata": {"provider": request.get("provider", "godot.factory/v1"), "version": request.get("version", "1"), "seed": seed_value, "physics_hz": physics_hz}
	})
	quit(0 if violations.is_empty() else 1)
