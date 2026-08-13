extends SceneTree

# Engine-native visual QA helper. It preserves three representative runtime
# views under a mutable project path without changing gameplay state/resources.

func _initialize() -> void:
	call_deferred("capture_views")

func capture_views() -> void:
	var packed := load("res://main.tscn")
	if not packed is PackedScene:
		quit(1)
		return
	var subject: Node = packed.instantiate()
	root.add_child(subject)
	await process_frame
	await process_frame
	var output := ProjectSettings.globalize_path("res://assets/qa")
	DirAccess.make_dir_recursive_absolute(output)
	if root.get_texture().get_image().save_png(output.path_join("title.png")) != OK:
		quit(2)
		return
	subject.call("_press",Vector2(576,577))
	for frame in range(18):
		await process_frame
	if root.get_texture().get_image().save_png(output.path_join("first-puzzle.png")) != OK:
		quit(2)
		return
	# Paired manipulation evidence: hover -> grab -> reset -> dock/load.
	var end_position: Vector2 = subject.get("points")[-1]
	subject.set("mouse_position",end_position)
	subject.set("hover",33)
	await process_frame
	if root.get_texture().get_image().save_png(output.path_join("state-hover.png")) != OK:
		quit(2)
		return
	subject.call("_press",end_position)
	subject.call("_drag_to",end_position+Vector2(72,-86))
	await process_frame
	if root.get_texture().get_image().save_png(output.path_join("state-grab.png")) != OK:
		quit(2)
		return
	subject.call("_reset",false)
	await process_frame
	if root.get_texture().get_image().save_png(output.path_join("state-reset.png")) != OK:
		quit(2)
		return
	subject.call("_factory_begin_player_drag")
	for step in range(45):
		subject.call("_factory_step_player_drag",step)
	subject.call("_factory_release",subject.get("levels")[0].cleat)
	subject.call("_evaluate",1.0/60.0)
	await process_frame
	if root.get_texture().get_image().save_png(output.path_join("state-dock-load.png")) != OK:
		quit(2)
		return
	# Fixture-local contact and authored HOLD evidence.
	subject.set("level",1)
	subject.call("_reset",false)
	var eye: Vector2 = subject.call("_eye_position",0)
	subject.set("grabbed",33)
	var eye_points: Array = subject.get("points")
	eye_points[33] = eye-Vector2(42,0)
	subject.set("points",eye_points)
	subject.call("_drag_to",eye)
	subject.call("_drag_to",eye+Vector2(42,0))
	subject.set("grabbed",-1)
	await process_frame
	if root.get_texture().get_image().save_png(output.path_join("state-thread.png")) != OK:
		quit(2)
		return
	subject.set("level",2)
	subject.call("_reset",false)
	var socket: Vector2 = subject.get("levels")[2].socket
	var hold_index := 7
	subject.set("grabbed",hold_index)
	subject.call("_drag_to",socket)
	subject.set("grabbed",-1)
	subject.call("_toggle_socket",socket)
	await process_frame
	if root.get_texture().get_image().save_png(output.path_join("state-pin.png")) != OK:
		quit(2)
		return
	subject.call("_toggle_socket",Vector2(220,220))
	await process_frame
	if root.get_texture().get_image().save_png(output.path_join("state-rejection.png")) != OK:
		quit(2)
		return
	subject.call("_reset",false)
	var wrong_data: Dictionary = subject.get("levels")[2]
	var wrong_anchors: Array[Vector2] = [wrong_data.start]
	for step in range(19):
		wrong_anchors.append(wrong_data.cap+Vector2.from_angle(-2.4-float(step)*TAU/18.0)*82.0)
	wrong_anchors.append(wrong_data.cleat)
	subject.set("points",subject.call("_resample",wrong_anchors,34))
	subject.set("grabbed",33)
	subject.call("_evaluate",1.0/60.0)
	await process_frame
	if root.get_texture().get_image().save_png(output.path_join("state-wrong-direction.png")) != OK:
		quit(2)
		return
	subject.set("level",3)
	subject.call("_reset",false)
	for frame in range(18):
		await process_frame
	if root.get_texture().get_image().save_png(output.path_join("finale.png")) != OK:
		quit(2)
		return
	subject.call("_factory_begin_player_drag")
	for step in range(45):
		subject.call("_factory_step_player_drag",step)
	subject.call("_factory_release",subject.get("levels")[3].cleat)
	for frame in range(18):
		subject.call("_evaluate",1.0/60.0)
		await process_frame
	if root.get_texture().get_image().save_png(output.path_join("state-finale-load.png")) != OK:
		quit(2)
		return
	for frame in range(40):
		subject.call("_evaluate",1.0/60.0)
		await process_frame
	if root.get_texture().get_image().save_png(output.path_join("finale-solved.png")) != OK:
		quit(2)
		return
	print("Captured required views plus hover, grab, reset, dock/load, thread, pin, wrong-direction rejection, finale load, and success evidence to res://assets/qa")
	subject.queue_free()
	await process_frame
	await process_frame
	quit(0)
