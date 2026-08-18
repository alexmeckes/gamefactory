extends SceneTree

func _initialize() -> void:
	call_deferred("capture")

func save_frame(path: String) -> bool:
	await process_frame
	await process_frame
	RenderingServer.force_sync()
	var image := root.get_texture().get_image()
	if image == null or image.save_png(path) != OK:
		push_error("Could not save capture %s" % path)
		return false
	return true

func capture() -> void:
	var packed := load("res://main.tscn")
	if not packed is PackedScene:
		quit(1)
		return
	var subject: Node = packed.instantiate()
	root.add_child(subject)
	await process_frame
	var output := ProjectSettings.globalize_path("res://evidence/captures")
	DirAccess.make_dir_recursive_absolute(output)
	var planning := output.path_join("planning.png")
	var selected := output.path_join("selected.png")
	var battle := output.path_join("battle.png")
	var result := output.path_join("result.png")
	if not await save_frame(planning): quit(2); return
	subject.selected_slot = 1
	subject.banner = "Now choose where RED WARDEN should move."
	subject.queue_redraw()
	if not await save_frame(selected): quit(2); return
	subject.factory_setup({"id":"capture"})
	for frame in range(55):
		subject.factory_tick(0.04)
		subject._process(0.0)
		await process_frame
	if not await save_frame(battle): quit(2); return
	for frame in range(600):
		if subject.phase != "battle": break
		subject.factory_tick(0.05)
		subject._process(0.0)
	# Let the staged result reveal reach its readable held pose. A capture taken
	# on the resolution frame would only prove the pre-animation battlefield.
	for frame in range(36):
		await process_frame
	if not await save_frame(result): quit(2); return
	print(JSON.stringify({
		"summary":"Captured Wickward planning, live battle, and resolved result from Godot",
		"outcome":"captured",
		"context":{"engine":"Godot 4.7.1", "views":["planning", "selected", "battle", "result"]},
		"artifacts":[
			{"kind":"image", "path":"evidence/captures/planning.png", "mediaType":"image/png", "label":"Wickward planning state"},
			{"kind":"image", "path":"evidence/captures/selected.png", "mediaType":"image/png", "label":"Wickward selected formation state"},
			{"kind":"image", "path":"evidence/captures/battle.png", "mediaType":"image/png", "label":"Wickward live autobattle"},
			{"kind":"image", "path":"evidence/captures/result.png", "mediaType":"image/png", "label":"Wickward resolved result"}
		]
	}))
	quit(0)
