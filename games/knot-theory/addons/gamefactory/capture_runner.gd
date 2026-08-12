extends SceneTree

func _initialize() -> void:
	call_deferred("capture")

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
	root.get_texture().get_image().save_png(output.path_join("title.png"))
	subject.call("_press", Vector2(576, 577))
	for frame in range(30): await process_frame
	root.get_texture().get_image().save_png(output.path_join("first-puzzle.png"))
	subject.set("level", 3)
	subject.call("_reset", false)
	for frame in range(30): await process_frame
	root.get_texture().get_image().save_png(output.path_join("finale.png"))
	quit(0)
