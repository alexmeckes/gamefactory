extends SceneTree

# Deterministic engine-frame evidence for contact and settle timing. These are
# controlled runtime fixtures, not human playtest evidence or proof of fun.

const MAIN_SCENE := preload("res://main.tscn")
const OUTPUT_ROOT := "res://levels/evidence/final/motion"

func _initialize() -> void:
	call_deferred("capture_sequence")

func capture_sequence() -> void:
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(OUTPUT_ROOT))
	var scene := MAIN_SCENE.instantiate()
	root.add_child(scene)
	scene.factory_setup({"capture": true})
	scene.setup_capture_wave_fixture()
	await save_frame(scene, "00_warden_read")

	# Spark contacts the prepared Rivet Carrier and exercises the real
	# FLASHBOIL branch, including recoil, bolt, state transition, and beat.
	scene.fire_tower(scene.towers[0], 1)
	await save_frame(scene, "01_spark_contact")
	advance_effects(scene, 0.09)
	await save_frame(scene, "02_spark_settle")

	# Reset the Warden to a closed clamp, then invoke the actual Bell -> Striker
	# response functions used during wave four.
	var warden: Dictionary = scene.enemies[2]
	warden.clamp_state = "closed"
	warden.hp = 232.0
	scene.fire_tower(scene.towers[1], 2)
	await save_frame(scene, "03_bell_contact")
	advance_effects(scene, 0.12)
	await save_frame(scene, "04_bell_settle")
	scene.fire_tower(scene.towers[2], 2)
	await save_frame(scene, "05_striker_contact")
	advance_effects(scene, 0.14)
	await save_frame(scene, "06_striker_settle")

	scene.queue_free()
	await process_frame
	await process_frame
	quit()

func advance_effects(scene: Node, delta: float) -> void:
	for tower in scene.towers:
		tower.recoil = maxf(0.0, float(tower.recoil) - delta * 8.0)
		tower.pulse = maxf(0.0, float(tower.pulse) - delta * 5.0)
	scene.update_bolts(delta)
	for beat in scene.beats:
		beat.life = maxf(0.0, float(beat.life) - delta)
	scene.queue_redraw()

func save_frame(scene: Node, frame_name: String) -> void:
	scene.queue_redraw()
	await process_frame
	await process_frame
	RenderingServer.force_sync()
	var image := root.get_texture().get_image()
	var result := image.save_png("%s/%s.png" % [OUTPUT_ROOT, frame_name])
	if result != OK:
		push_error("Failed to save motion frame %s: %s" % [frame_name, error_string(result)])
