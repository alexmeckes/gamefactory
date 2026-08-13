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
	var captures := [
		{"id": "title", "path": output.path_join("title.png")},
		{"id": "first-puzzle", "path": output.path_join("first-puzzle.png")},
		{"id": "finale", "path": output.path_join("finale.png")}
	]
	if root.get_texture().get_image().save_png(captures[0].path) != OK:
		quit(2)
		return
	subject.call("_press", Vector2(576, 577))
	for frame in range(30): await process_frame
	if root.get_texture().get_image().save_png(captures[1].path) != OK:
		quit(2)
		return
	subject.set("level", 3)
	subject.call("_reset", false)
	for frame in range(30): await process_frame
	if root.get_texture().get_image().save_png(captures[2].path) != OK:
		quit(2)
		return
	print(JSON.stringify({
		"summary": "Captured title, teaching puzzle, and finale views from the running Godot project",
		"outcome": "captured",
		"context": {"views": captures.map(func(item): return item.id)},
		"artifacts": [
			{"kind": "image", "path": ".factory/previews/title.png", "mediaType": "image/png", "label": "Knot Theory title view"},
			{"kind": "image", "path": ".factory/previews/first-puzzle.png", "mediaType": "image/png", "label": "Knot Theory first puzzle view"},
			{"kind": "image", "path": ".factory/previews/finale.png", "mediaType": "image/png", "label": "Knot Theory finale view"}
		]
	}))
	quit(0)
