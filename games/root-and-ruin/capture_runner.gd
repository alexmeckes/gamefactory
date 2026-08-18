extends SceneTree

func _initialize() -> void:
	call_deferred("_capture")

func _save(path: String) -> bool:
	await process_frame
	await process_frame
	RenderingServer.force_sync()
	var image := root.get_texture().get_image()
	return image != null and image.save_png(path) == OK

func _game(round_number: int, rotations: Array[int], simulate_seconds := 0.0) -> Node:
	var packed := load("res://main.tscn") as PackedScene
	var game := packed.instantiate()
	root.add_child(game)
	game.scenario_configure(round_number, rotations)
	if simulate_seconds > 0.0: game.scenario_run(simulate_seconds)
	return game

func _capture() -> void:
	var output := ProjectSettings.globalize_path("res://.factory/previews")
	DirAccess.make_dir_recursive_absolute(output)
	var planning := _game(2, [0, 0, 0])
	if not await _save(output.path_join("planning.png")): quit(2); return
	root.remove_child(planning); planning.free()
	var exposed := _game(2, [0, 0, 0], 4.2)
	if not await _save(output.path_join("blight-exposed.png")): quit(2); return
	root.remove_child(exposed); exposed.free()
	var contained := _game(2, [1, 0, 0], 4.2)
	if not await _save(output.path_join("blight-contained.png")): quit(2); return
	print(JSON.stringify({
		"summary":"Captured planning, exposed blight, and contained blight states",
		"outcome":"captured",
		"artifacts":[
			{"kind":"image", "path":".factory/previews/planning.png", "mediaType":"image/png", "label":"Root & Ruin planning state"},
			{"kind":"image", "path":".factory/previews/blight-exposed.png", "mediaType":"image/png", "label":"Blight spreading through exposed roots"},
			{"kind":"image", "path":".factory/previews/blight-contained.png", "mediaType":"image/png", "label":"Blight contained by a rotated branch"}
		]
	}))
	quit(0)
