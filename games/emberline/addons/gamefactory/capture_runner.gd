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
		{"id":"title", "path":output.path_join("title.png")},
		{"id":"board", "path":output.path_join("board.png")},
		{"id":"wave", "path":output.path_join("wave.png")}
	]
	if root.get_texture().get_image().save_png(captures[0].path) != OK:
		quit(2)
		return
	subject.call("factory_setup", {"capture":true})
	for frame in range(25):
		await process_frame
	if root.get_texture().get_image().save_png(captures[1].path) != OK:
		quit(2)
		return
	for frame in range(210):
		subject.call("factory_tick", frame)
		await process_frame
	if root.get_texture().get_image().save_png(captures[2].path) != OK:
		quit(2)
		return
	print(JSON.stringify({
		"summary":"Captured Emberline title, tactical board, and live wave from the running Godot project",
		"outcome":"captured",
		"context":{"views":captures.map(func(item): return item.id)},
		"artifacts":[
			{"kind":"image", "path":".factory/previews/title.png", "mediaType":"image/png", "label":"Emberline title view"},
			{"kind":"image", "path":".factory/previews/board.png", "mediaType":"image/png", "label":"Emberline tactical board view"},
			{"kind":"image", "path":".factory/previews/wave.png", "mediaType":"image/png", "label":"Emberline live wave view"}
		]
	}))
	quit(0)
