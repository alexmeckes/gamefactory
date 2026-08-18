extends SceneTree

func _initialize() -> void:
	call_deferred("run_contract")

func fail(message: String) -> void:
	push_error(message)
	print(JSON.stringify({"summary":message, "outcome":"failed", "findings":{"contract":"wickward-runtime"}}))
	quit(1)

func run_contract() -> void:
	var packed := load("res://main.tscn")
	if not packed is PackedScene:
		fail("main.tscn did not load")
		return
	var subject: Node = packed.instantiate()
	root.add_child(subject)
	await process_frame
	for method in ["factory_setup", "factory_tick", "factory_sample", "factory_collect"]:
		if not subject.has_method(method):
			fail("Missing runtime hook: %s" % method)
			return
	subject.factory_setup({"id":"optimal-formation"})
	var samples := []
	for frame in range(600):
		subject.factory_tick(0.05)
		if frame % 40 == 0: samples.append(subject.factory_sample())
		if subject.phase != "battle": break
	var result: Dictionary = subject.factory_collect()
	if result.phase != "won":
		fail("The one-swap formation did not resolve as a win")
		return
	if result.order != ["seer", "chime", "warden"]:
		fail("The tested formation order changed unexpectedly")
		return
	if samples.size() < 2:
		fail("The encounter did not expose enough state samples")
		return
	print(JSON.stringify({
		"summary":"Wickward loaded and the one-swap formation resolved through real combat",
		"outcome":"pass",
		"findings":{"contract":"wickward-runtime", "duration":result.duration, "order":result.order, "samples":samples.size()}
	}))
	quit(0)
