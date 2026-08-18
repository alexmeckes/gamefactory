extends SceneTree

# A deterministic, real-time showcase for the shipping scene. Run this with
# Godot's MovieWriter so motion evidence is captured from the same Node2D and
# state transitions as play, not reconstructed in an external renderer.

func _initialize() -> void:
	call_deferred("record_motion")

func record_motion() -> void:
	var packed := load("res://main.tscn")
	if not packed is PackedScene:
		push_error("main.tscn did not load")
		quit(1)
		return
	var subject: Node = packed.instantiate()
	root.add_child(subject)
	for frame in range(24): await process_frame
	subject.factory_setup({"id":"motion-evidence"})
	while subject.phase == "battle": await process_frame
	for frame in range(90): await process_frame
	quit(0)
