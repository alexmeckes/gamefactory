extends SceneTree

var output_dir := ""

func _initialize() -> void:
	call_deferred("_run")

func _argument(name: String) -> String:
	var args := OS.get_cmdline_user_args()
	var index := args.find(name)
	return "" if index < 0 or index + 1 >= args.size() else args[index + 1]

func _write_json(path: String, value: Variant) -> void:
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file:
		file.store_string(JSON.stringify(value, "  ") + "\n")

func _fail(code: String, message: String) -> void:
	if not output_dir.is_empty():
		_write_json(output_dir.path_join("result.json"), {"status":"crash", "metrics":{}, "artifacts":[], "violations":[{"code":code, "message":message, "severity":"error"}]})
	push_error(message)
	quit(1)

func _run() -> void:
	var request_path := _argument("--request")
	output_dir = _argument("--output")
	if request_path.is_empty() or output_dir.is_empty():
		_fail("factory.arguments", "Expected --request and --output arguments.")
		return
	DirAccess.make_dir_recursive_absolute(output_dir)
	var request_file := FileAccess.open(request_path, FileAccess.READ)
	if not request_file:
		_fail("factory.request", "Cannot open scenario request.")
		return
	var request = JSON.parse_string(request_file.get_as_text())
	if not request is Dictionary:
		_fail("factory.request", "Scenario request is not an object.")
		return
	var packed = load(request.get("path", "res://main.tscn"))
	if not packed is PackedScene:
		_fail("factory.scene", "Cannot load scenario scene.")
		return
	var subject: Node = packed.instantiate()
	root.add_child(subject)
	var parameters: Dictionary = request.get("parameters", {})
	var ticks := maxi(1, int(parameters.get("ticks", 1140)))
	var physics_hz := maxi(1, int(parameters.get("physics_hz", 60)))
	seed(int(parameters.get("seed", 1)))
	Engine.physics_ticks_per_second = physics_hz
	if not subject.has_method("factory_setup") or not subject.has_method("factory_collect"):
		_fail("root-and-ruin.factory-hooks", "Scenario subject is missing required factory hooks.")
		return
	subject.call("factory_setup", parameters)
	var telemetry_path := output_dir.path_join("telemetry.jsonl")
	var telemetry := FileAccess.open(telemetry_path, FileAccess.WRITE)
	for tick in range(ticks):
		if subject.has_method("factory_tick"): subject.call("factory_tick", tick)
		var sample := {"tick":tick}
		if subject.has_method("factory_sample"):
			var custom = subject.call("factory_sample")
			if custom is Dictionary: sample.merge(custom, true)
		telemetry.store_line(JSON.stringify(sample))
	telemetry.close()
	var collected: Dictionary = subject.call("factory_collect")
	var violations: Array = collected.get("violations", [])
	var metrics := {"ticks_completed":ticks, "simulated_seconds":float(ticks) / physics_hz}
	metrics.merge(collected.get("metrics", {}), true)
	_write_json(output_dir.path_join("result.json"), {
		"status":"pass" if violations.is_empty() else "fail",
		"metrics":metrics,
		"violations":violations,
		"artifacts":[{"kind":"telemetry", "path":telemetry_path, "mediaType":"application/x-ndjson", "label":"Root & Ruin deterministic telemetry"}],
		"metadata":{"provider":request.get("provider", "godot.factory/v1"), "version":request.get("version", "1"), "physics_hz":physics_hz}
	})
	quit(0 if violations.is_empty() else 1)
