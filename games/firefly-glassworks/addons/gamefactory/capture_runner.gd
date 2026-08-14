extends SceneTree

func _initialize() -> void:
	call_deferred("capture")

func save_frame(path: String) -> bool:
	await process_frame
	await process_frame
	RenderingServer.force_sync()
	var image := root.get_texture().get_image()
	return image != null and image.save_png(path) == OK

func capture() -> void:
	var packed := load("res://main.tscn")
	if not packed is PackedScene:
		quit(1)
		return
	var subject: Node = packed.instantiate()
	root.add_child(subject)
	await process_frame
	await process_frame
	var output := ProjectSettings.globalize_path("res://.factory/previews")
	DirAccess.make_dir_recursive_absolute(output)
	if not await save_frame(output.path_join("title.png")):
		quit(2)
		return
	subject.start_game()
	if not await save_frame(output.path_join("first-puzzle.png")):
		quit(2)
		return
	var motion := []
	for index in range(7):
		subject.capture_motion_frame(index)
		var path := output.path_join("motion-%03d.png" % index)
		motion.append(path)
		if not await save_frame(path):
			quit(2)
			return
	if not await save_frame(output.path_join("solved.png")):
		quit(2)
		return
	var artifacts := [
		{"kind":"image", "path":".factory/previews/title.png", "mediaType":"image/png", "label":"Firefly Glassworks title"},
		{"kind":"image", "path":".factory/previews/first-puzzle.png", "mediaType":"image/png", "label":"Firefly Glassworks representative puzzle"},
		{"kind":"image", "path":".factory/previews/solved.png", "mediaType":"image/png", "label":"Firefly Glassworks solved beam state"}
	]
	for index in range(motion.size()):
		artifacts.append({"kind":"image", "path":".factory/previews/motion-%03d.png" % index, "mediaType":"image/png", "label":"Beam motion frame %d" % (index + 1)})
	print(JSON.stringify({"summary":"Captured title, representative puzzle, solved state, and seven-frame beam sequence", "outcome":"captured", "context":{"views":["title", "first-puzzle", "solved"], "sequences":["beam-route"]}, "artifacts":artifacts}))
	quit(0)
