extends SceneTree

# A fast, deterministic pre-polish contract. It proves the project loads and the
# real fixture/fire path executes; the full scenario evaluator remains the final
# systems authority.

func _initialize() -> void:
	call_deferred("run_contract")

func fail(message: String) -> void:
	push_error(message)
	print(JSON.stringify({"summary":message, "outcome":"failed", "findings":{"contract":"emberline-runtime"}}))
	quit(1)

func run_contract() -> void:
	var packed := load("res://main.tscn")
	if not packed is PackedScene:
		fail("main.tscn did not load")
		return
	var subject: Node = packed.instantiate()
	root.add_child(subject)
	await process_frame
	for method in ["factory_setup", "setup_capture_wave_fixture", "fire_tower", "factory_sample", "factory_collect"]:
		if not subject.has_method(method):
			fail("Missing required runtime hook: %s" % method)
			return
	subject.factory_setup({"capture":true})
	subject.setup_capture_wave_fixture()
	if subject.towers.size() < 3 or subject.enemies.size() < 3:
		fail("The deterministic combat fixture is incomplete")
		return
	subject.fire_tower(subject.towers[0], 1)
	for frame in range(8):
		await process_frame
	var sample = subject.factory_sample()
	if not sample is Dictionary or not sample.has("reactions") or not sample.has("core_health"):
		fail("Runtime telemetry contract is incomplete")
		return
	var tower_count: int = subject.towers.size()
	var enemy_count: int = subject.enemies.size()
	subject.queue_free()
	await process_frame
	await process_frame
	print(JSON.stringify({
		"summary":"Emberline loaded and executed its real fixture, fire, and telemetry path",
		"outcome":"pass",
		"findings":{"contract":"emberline-runtime", "towerCount":tower_count, "enemyCount":enemy_count}
	}))
	quit(0)
