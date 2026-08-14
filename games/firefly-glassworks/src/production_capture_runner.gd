extends SceneTree

# Writes only into the request's mutable design/** surface. These are running
# Godot captures at the configured shipping viewport, not concept renders.

func _initialize() -> void:
	call_deferred("capture")


func frame_image() -> Image:
	await process_frame
	await process_frame
	RenderingServer.force_sync()
	return root.get_texture().get_image()


func save_image(image: Image, path: String) -> bool:
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
	var capture_dir := ProjectSettings.globalize_path("res://design/captures")
	var reference_dir := ProjectSettings.globalize_path("res://design/references")
	DirAccess.make_dir_recursive_absolute(capture_dir)
	DirAccess.make_dir_recursive_absolute(reference_dir)

	subject.start_game()
	var first := await frame_image()
	if not save_image(first, capture_dir.path_join("first-puzzle.png")):
		quit(2)
		return

	for index in range(7):
		subject.capture_motion_frame(index)
		var motion := await frame_image()
		if not save_image(motion, capture_dir.path_join("motion-%03d.png" % index)):
			quit(2)
			return

	var solved := await frame_image()
	if not save_image(solved, capture_dir.path_join("solved.png")):
		quit(2)
		return
	if not save_image(solved, reference_dir.path_join("firefly-production-slice.png")):
		quit(2)
		return

	print(JSON.stringify({
		"summary": "Captured production slice from the running Godot project at 1152x720",
		"outcome": "captured",
		"artifacts": [
			"design/captures/first-puzzle.png",
			"design/captures/motion-000.png",
			"design/captures/motion-001.png",
			"design/captures/motion-002.png",
			"design/captures/motion-003.png",
			"design/captures/motion-004.png",
			"design/captures/motion-005.png",
			"design/captures/motion-006.png",
			"design/captures/solved.png",
			"design/references/firefly-production-slice.png"
		]
	}))
	quit(0)
