extends SceneTree

func _initialize() -> void:
	call_deferred("capture")

func save_frame(path: String) -> bool:
	await process_frame
	await process_frame
	RenderingServer.force_sync()
	var texture := root.get_texture()
	if texture == null:
		push_error("Factory capture has no viewport texture")
		return false
	var image := texture.get_image()
	if image == null or image.save_png(path) != OK:
		push_error("Factory capture failed to save %s" % path)
		return false
	return true

func settle_effects(subject: Node, delta: float) -> void:
	for tower in subject.towers:
		tower.recoil = maxf(0.0, float(tower.recoil) - delta * 8.0)
		tower.pulse = maxf(0.0, float(tower.pulse) - delta * 5.0)
	subject.update_bolts(delta)
	for beat in subject.beats:
		beat.life = maxf(0.0, float(beat.life) - delta)
	subject.queue_redraw()

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
	if not await save_frame(captures[0].path):
		quit(2)
		return
	subject.call("factory_setup", {"capture":true})
	for frame in range(25):
		await process_frame
	if not await save_frame(captures[1].path):
		quit(2)
		return
	for frame in range(210):
		subject.call("factory_tick", frame)
		await process_frame
	if not await save_frame(captures[2].path):
		quit(2)
		return
	var motion := []
	for index in range(7):
		motion.append(output.path_join("motion-%03d.png" % index))
	subject.setup_capture_wave_fixture()
	if not await save_frame(motion[0]): quit(2); return
	subject.fire_tower(subject.towers[0], 1)
	if not await save_frame(motion[1]): quit(2); return
	settle_effects(subject, 0.09)
	if not await save_frame(motion[2]): quit(2); return
	var warden: Dictionary = subject.enemies[2]
	warden.clamp_state = "closed"
	warden.hp = 232.0
	subject.fire_tower(subject.towers[1], 2)
	if not await save_frame(motion[3]): quit(2); return
	settle_effects(subject, 0.12)
	if not await save_frame(motion[4]): quit(2); return
	subject.fire_tower(subject.towers[2], 2)
	if not await save_frame(motion[5]): quit(2); return
	settle_effects(subject, 0.14)
	if not await save_frame(motion[6]): quit(2); return
	var artifacts := [
		{"kind":"image", "path":".factory/previews/title.png", "mediaType":"image/png", "label":"Emberline title view"},
		{"kind":"image", "path":".factory/previews/board.png", "mediaType":"image/png", "label":"Emberline tactical board view"},
		{"kind":"image", "path":".factory/previews/wave.png", "mediaType":"image/png", "label":"Emberline live wave view"}
	]
	for index in range(motion.size()):
		artifacts.append({"kind":"image", "path":".factory/previews/motion-%03d.png" % index, "mediaType":"image/png", "label":"Emberline motion frame %d" % (index + 1)})
	subject.queue_free()
	await process_frame
	await process_frame
	print(JSON.stringify({
		"summary":"Captured Emberline title, tactical board, live wave, and a seven-frame runtime motion sequence",
		"outcome":"captured",
		"context":{"views":captures.map(func(item): return item.id), "sequences":["tower-fire"]},
		"artifacts":artifacts
	}))
	quit(0)
