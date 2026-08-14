extends SceneTree

# Bounded presentation contract for the production slice. These checks exercise
# the ordinary action/recompute seam and shared animation clock without treating
# deterministic output as human evidence of fun.

var failures: Array[String] = []


func _initialize() -> void:
	call_deferred("run_contract")


func require(condition: bool, message: String) -> void:
	if not condition:
		failures.append(message)


func run_contract() -> void:
	var packed := load("res://main.tscn")
	require(packed is PackedScene, "main.tscn must load")
	if not packed is PackedScene:
		finish()
		return
	var subject: Node = packed.instantiate()
	root.add_child(subject)
	await process_frame

	require(subject.mirror_base_angle(0) > 0.0, "orientation 0 must render as a forward slash")
	require(subject.mirror_base_angle(1) < 0.0, "orientation 1 must render as a backslash")

	subject.start_game()
	require(subject.motion_reveal < 0.01, "level load must begin the live visual reveal")
	subject.advance_presentation(subject.BEAM_REVEAL_DURATION)
	require(subject.motion_reveal >= 0.999, "the shared presentation clock must complete the reveal")

	subject.load_level(3)
	subject.apply_action({"type": "rotate", "cell": Vector2i(2, 2)})
	require(subject.latch_open, "sensor contact must update authoritative latch state immediately")
	require(not subject.visual_latch_open, "latch presentation must wait for the visible beam contact")
	var before_contact := maxf(0.0, subject.latch_reveal_threshold - 0.05)
	subject.advance_presentation(subject.BEAM_REVEAL_DURATION * before_contact)
	require(not subject.visual_latch_open, "latch presentation must remain closed before contact")
	subject.advance_presentation(subject.BEAM_REVEAL_DURATION * 0.10)
	require(subject.visual_latch_open, "latch presentation must open when the live reveal reaches the sensor")

	subject.load_level(3)
	for cell in [Vector2i(6, 4), Vector2i(2, 4), Vector2i(2, 2), Vector2i(2, 2)]:
		subject.apply_action({"type": "rotate", "cell": cell})
	require(subject.beam_hit, "accepted finale witness must still reach the receiver")
	require(subject.receiver_settle <= 0.001, "receiver presentation must not arrive before the beam")
	subject.advance_presentation(subject.BEAM_REVEAL_DURATION)
	require(subject.receiver_settle <= 0.001, "receiver settle must begin only after full beam travel")
	subject.advance_presentation(subject.RECEIVER_SETTLE_DURATION)
	require(subject.receiver_settle >= 0.999, "receiver must settle through the shared presentation clock")
	finish()


func finish() -> void:
	var outcome := "pass" if failures.is_empty() else "failed"
	print(JSON.stringify({
		"summary": "Production-slice presentation contract %s" % outcome,
		"outcome": outcome,
		"findings": {
			"mirror_semantics": failures.is_empty(),
			"live_beam_reveal": failures.is_empty(),
			"contact_coupling": failures.is_empty(),
			"receiver_settle": failures.is_empty(),
			"failures": failures
		}
	}))
	quit(0 if failures.is_empty() else 1)
