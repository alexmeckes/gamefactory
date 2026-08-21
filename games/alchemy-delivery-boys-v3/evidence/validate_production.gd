extends SceneTree

const TARGET_HASH := "98b9f68faf484f1d9a36eb471a840e653f30e6d088d7086e872e6248cd205377"

var checks: Array[Dictionary] = []
var violations: Array[Dictionary] = []


func _initialize() -> void:
	call_deferred("_run")


func _run() -> void:
	_validate_assets()
	await _validate_scene()
	_validate_captures()
	_validate_trace()
	_write_result()
	quit(0 if violations.is_empty() else 1)


func _validate_assets() -> void:
	var expected := {
		"game/assets/production/inkcap-conservatory/environment/conservatory-frame.png": Vector2i(480, 212),
		"game/assets/production/inkcap-conservatory/environment/workshop-environment.png": Vector2i(600, 212),
		"game/assets/production/inkcap-conservatory/environment/divider-environment.png": Vector2i(12, 212),
		"game/assets/production/inkcap-conservatory/environment/garden-environment.png": Vector2i(260, 212),
		"game/assets/production/inkcap-conservatory/characters/courier-actor.png": Vector2i(320, 28),
		"game/assets/production/inkcap-conservatory/characters/mira-actor.png": Vector2i(144, 32),
		"game/assets/production/inkcap-conservatory/interactables/warm-ingredient.png": Vector2i(120, 32),
		"game/assets/production/inkcap-conservatory/interactables/fizz-ingredient.png": Vector2i(120, 32),
		"game/assets/production/inkcap-conservatory/interactables/brew-station.png": Vector2i(288, 48),
		"game/assets/production/inkcap-conservatory/route-gates/cooling-gate.png": Vector2i(88, 40),
		"game/assets/production/inkcap-conservatory/route-gates/venting-gate.png": Vector2i(88, 40),
		"game/assets/production/inkcap-conservatory/props/carried-bottle.png": Vector2i(40, 12),
		"game/assets/production/inkcap-conservatory/interactables/follow-up-warm_cool.png": Vector2i(192, 24),
		"game/assets/production/inkcap-conservatory/interactables/follow-up-fizz_vent.png": Vector2i(192, 24),
		"game/assets/production/inkcap-conservatory/effects/brew-effects.png": Vector2i(180, 35),
		"game/assets/production/inkcap-conservatory/effects/route-effects.png": Vector2i(330, 45),
		"game/assets/production/inkcap-conservatory/effects/reaction-effects.png": Vector2i(215, 34),
		"game/assets/production/inkcap-conservatory/effects/selection-effects.png": Vector2i(160, 32),
		"game/assets/production/inkcap-conservatory/interface/ledger-panel.png": Vector2i(16, 16),
		"game/assets/production/inkcap-conservatory/interface/context-panel.png": Vector2i(16, 16),
		"game/assets/production/inkcap-conservatory/interface/world-cue-panel.png": Vector2i(16, 12)
	}
	var transparent_assets := [
		"characters/courier-actor.png", "characters/mira-actor.png",
		"interactables/warm-ingredient.png", "interactables/fizz-ingredient.png",
		"interactables/brew-station.png", "route-gates/cooling-gate.png",
		"route-gates/venting-gate.png", "props/carried-bottle.png",
		"interactables/follow-up-warm_cool.png", "interactables/follow-up-fizz_vent.png",
		"effects/brew-effects.png", "effects/route-effects.png",
		"effects/reaction-effects.png", "effects/selection-effects.png"
	]
	for path: String in expected:
		var absolute := ProjectSettings.globalize_path("res://%s" % path)
		if not FileAccess.file_exists(absolute):
			_fail("asset-exists", path, "Required runtime asset is missing.")
			continue
		var image := Image.load_from_file(absolute)
		_check("native-size", path, image.get_size() == expected[path], "%s expected %s" % [image.get_size(), expected[path]])
		var relative := path.trim_prefix("game/assets/production/inkcap-conservatory/")
		if relative in transparent_assets:
			var transparent_count := 0
			var opaque_count := 0
			for y in range(image.get_height()):
				for x in range(image.get_width()):
					if image.get_pixel(x, y).a == 0.0:
						transparent_count += 1
					else:
						opaque_count += 1
			_check("transparent-background", path, transparent_count > 0 and opaque_count > 0, "transparent=%d opaque=%d" % [transparent_count, opaque_count])
	var target_path := ProjectSettings.globalize_path("res://design/scene-targets/views/direction-b-inkcap-interaction.png")
	_check("approved-target-hash", "inkcap-interaction", FileAccess.get_sha256(target_path) == TARGET_HASH, FileAccess.get_sha256(target_path))
	for font_path in [
		"game/assets/production/inkcap-conservatory/interface/fonts/DejaVuSans.ttf",
		"game/assets/production/inkcap-conservatory/interface/fonts/DejaVuSans-Bold.ttf",
		"game/assets/production/inkcap-conservatory/interface/fonts/LICENSE_DEJAVU.txt"
	]:
		_check("bundled-font", font_path, FileAccess.file_exists(ProjectSettings.globalize_path("res://%s" % font_path)), "bundled interface typography dependency")


func _validate_scene() -> void:
	var packed := load("res://game/main.tscn") as PackedScene
	_check("scene-load", "game/main.tscn", packed != null, "PackedScene loads")
	if packed == null:
		return
	var main := packed.instantiate()
	root.add_child(main)
	await process_frame
	var anchors := {
		"World/Player": Vector2(80, 50),
		"World/WarmIngredient": Vector2(140, 220),
		"World/FizzIngredient": Vector2(205, 220),
		"World/BrewStation": Vector2(260, 185),
		"World/CoolingLane": Vector2(324, 103),
		"World/VentingLane": Vector2(324, 165),
		"World/Villager": Vector2(414, 126),
		"World/FollowWarmCooling": Vector2(372, 218),
		"World/FollowFizzVenting": Vector2(438, 218)
	}
	for node_path: String in anchors:
		var node := main.get_node_or_null(node_path) as Node2D
		_check("anchor", node_path, node != null and node.position == anchors[node_path], "expected %s" % anchors[node_path])
	for consumer_path in [
		"World/ConservatoryFrame", "World/WorkshopEnvironment", "World/DividerEnvironment",
		"World/GardenEnvironment", "World/Player/Visual", "World/Player/Bottle",
		"World/BrewStation/Visual", "World/BrewStation/Effect", "World/CoolingLane/Visual",
		"World/CoolingLane/Effect", "World/VentingLane/Visual", "World/VentingLane/Effect",
		"World/Villager/Visual", "World/Villager/Effect", "World/FollowWarmCooling/Visual",
		"World/FollowWarmCooling/Effect", "World/FollowFizzVenting/Visual", "World/FollowFizzVenting/Effect"
	]:
		var consumer := main.get_node_or_null(consumer_path) as Sprite2D
		_check("runtime-consumer", consumer_path, consumer != null and consumer.texture != null, "independent textured Sprite2D")
	for action in ["move_left", "move_right", "move_up", "move_down", "interact"]:
		_check("shipping-input", action, InputMap.has_action(action), "shipping InputMap action remains present")
	main.queue_free()


func _validate_captures() -> void:
	var capture_paths := [
		"evidence/captures/planning.png", "evidence/captures/action.png", "evidence/captures/result.png",
		"evidence/motion/frame-000.png", "evidence/motion/frame-001.png", "evidence/motion/frame-002.png",
		"evidence/motion/frame-003.png", "evidence/motion/frame-004.png", "evidence/motion/frame-005.png",
		"evidence/motion/frame-006.png"
	]
	var hashes: Dictionary = {}
	for path: String in capture_paths:
		var absolute := ProjectSettings.globalize_path("res://%s" % path)
		if not FileAccess.file_exists(absolute):
			_fail("capture-exists", path, "Configured candidate capture is missing.")
			continue
		var image := Image.load_from_file(absolute)
		_check("shipping-capture-size", path, image.get_size() == Vector2i(1440, 810), "%s" % image.get_size())
		hashes[FileAccess.get_sha256(absolute)] = true
	_check("motion-distinct", "evidence/motion", hashes.size() >= 7, "%d distinct hashes across configured captures" % hashes.size())


func _validate_trace() -> void:
	var path := ProjectSettings.globalize_path("res://evidence/candidate-capture-trace.json")
	if not FileAccess.file_exists(path):
		_fail("candidate-trace", "evidence/candidate-capture-trace.json", "Candidate-authored trace is missing.")
		return
	var parsed = JSON.parse_string(FileAccess.get_file_as_string(path))
	var samples: Array = parsed.get("samples", []) if parsed is Dictionary else []
	var final_sample: Dictionary = samples.back() if not samples.is_empty() else {}
	_check("candidate-causal-chain", "candidate-capture-trace", final_sample.get("deliveryComplete", false) and final_sample.get("reaction", "") == "balanced relief" and final_sample.get("followUpChoice", "") == "warm_cooling", JSON.stringify(final_sample))
	_check("candidate-trust-boundary", "candidate-capture-trace", parsed.get("producer", "") == "candidate-authored-godot-capture", "not factory-trusted evidence")


func _check(id: String, subject: String, passed: bool, detail: String) -> void:
	checks.append({"id": id, "subject": subject, "passed": passed, "detail": detail})
	if not passed:
		violations.append({"code": id, "subject": subject, "message": detail})


func _fail(id: String, subject: String, detail: String) -> void:
	_check(id, subject, false, detail)


func _write_result() -> void:
	var payload := {
		"apiVersion": "gamefactory.production-validation/v1",
		"specRevision": 1,
		"sliceId": "production-encounter",
		"targetHash": TARGET_HASH,
		"outcome": "pass" if violations.is_empty() else "fail",
		"checks": checks,
		"violations": violations,
		"trustBoundary": "Static and candidate-authored runtime validation; downstream factory-owned evidence remains authoritative."
	}
	var file := FileAccess.open(ProjectSettings.globalize_path("res://evidence/production-validation.json"), FileAccess.WRITE)
	if file != null:
		file.store_string(JSON.stringify(payload, "  "))
	print("PRODUCTION_VALIDATION_%s" % payload.outcome.to_upper())
