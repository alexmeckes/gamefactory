extends SceneTree

# Fast deterministic contract smoke for constrained/headless hosts. The factory
# runner remains authoritative; this helper deliberately drives the same public
# hooks without presenting the result as human play evidence.

func _initialize() -> void:
	var packed := load("res://main.tscn")
	if not packed is PackedScene:
		quit(1)
		return
	var subject: Node = packed.instantiate()
	root.add_child(subject)
	subject.call("factory_setup",{"seed":314159,"ticks":480,"physics_hz":60})
	print("QA_VALIDATE setup")
	for tick in range(480):
		subject.call("factory_tick",tick)
		subject.call("_process",1.0/60.0)
		if tick % 120 == 95:
			print("QA_VALIDATE sample ",JSON.stringify(subject.call("factory_sample")))
		if tick % 120 == 119:
			print("QA_VALIDATE tick ",tick+1)
	var collected: Dictionary = subject.call("factory_collect")
	print("QA_VALIDATE ",JSON.stringify(collected))
	subject.queue_free()
	quit(0 if collected.get("violations",[]).is_empty() else 1)
