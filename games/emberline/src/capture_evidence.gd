extends SceneTree

# Engine-native evidence capture for the three required visual states.
# These are deterministic running-project frames, not human playtest evidence.

const MAIN_SCENE := preload("res://main.tscn")
const OUTPUT_ROOT := "res://levels/evidence/final/captures"

func _initialize() -> void:
	call_deferred("capture_all")

func capture_all() -> void:
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(OUTPUT_ROOT))
	await capture_state("title")
	await capture_state("board")
	await capture_state("wave")
	quit()

func capture_state(state_name: String) -> void:
	var scene := MAIN_SCENE.instantiate()
	root.add_child(scene)
	if state_name == "board":
		scene.factory_setup({"capture":true})
	elif state_name == "wave":
		scene.factory_setup({"capture":true})
		scene.setup_capture_wave_fixture()
	scene.queue_redraw()
	await process_frame
	await process_frame
	RenderingServer.force_sync()
	var image := root.get_texture().get_image()
	var result := image.save_png("%s/%s.png" % [OUTPUT_ROOT, state_name])
	if result != OK:
		push_error("Failed to save %s capture: %s" % [state_name, error_string(result)])
	scene.queue_free()
	await process_frame
