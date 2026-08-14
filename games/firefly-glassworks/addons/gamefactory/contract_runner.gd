extends SceneTree

func _initialize() -> void:
	call_deferred("run_contract")

func fail(message: String) -> void:
	push_error(message)
	print(JSON.stringify({"summary":message, "outcome":"failed", "findings":{"contract":"firefly-graybox"}}))
	quit(1)

func run_contract() -> void:
	var packed := load("res://main.tscn")
	if not packed is PackedScene:
		fail("main.tscn did not load")
		return
	var subject: Node = packed.instantiate()
	root.add_child(subject)
	await process_frame
	for method in ["factory_setup", "factory_tick", "factory_sample", "factory_collect", "capture_motion_frame"]:
		if not subject.has_method(method):
			fail("Missing required hook: %s" % method)
			return
	subject.factory_setup({"capture":true})
	for tick in range(360):
		subject.factory_tick(tick)
		await process_frame
	var sample = subject.factory_sample()
	var collected = subject.factory_collect()
	if sample.get("state", "") != "won" or int(collected.get("metrics", {}).get("levels_completed", 0)) < 2:
		fail("The deterministic graybox did not complete its authored loop")
		return
	if not collected.get("violations", []).is_empty():
		fail("The deterministic graybox reported contract violations")
		return
	print(JSON.stringify({"summary":"Firefly Glassworks loaded and completed its real graybox route", "outcome":"pass", "findings":{"contract":"firefly-graybox", "metrics":collected.metrics}}))
	quit(0)
