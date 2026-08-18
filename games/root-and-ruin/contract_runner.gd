extends SceneTree

func _initialize() -> void:
	call_deferred("_run")

func _simulate(round_number: int, rotations: Array[int]) -> Dictionary:
	var packed := load("res://main.tscn") as PackedScene
	var game := packed.instantiate()
	root.add_child(game)
	game.scenario_configure(round_number, rotations)
	var result: Dictionary = game.scenario_run(18.2)
	root.remove_child(game)
	game.free()
	return result

func _run() -> void:
	var lesson := _simulate(1, [0, 0, 0])
	var exposed := _simulate(2, [0, 0, 0])
	var contained := _simulate(2, [1, 0, 0])
	var checks := {
		"lesson_connected_and_won": lesson.phase == "won" and lesson.hydrated.size() == 4,
		"blight_crosses_open_roots": exposed.infected.size() >= 3,
		"isolated_branch_contains_blight": contained.infected.size() == 1,
		"containment_preserves_spring": float(contained.plant_hp[3]) > float(exposed.plant_hp[3]),
		"containment_wins_authored_encounter": contained.phase == "won"
	}
	var passed := checks.values().all(func(value: bool) -> bool: return value)
	var report := {
		"apiVersion":"root-and-ruin.contract/v1",
		"status":"pass" if passed else "fail",
		"gameplay_contract_score": checks.values().filter(func(value: bool) -> bool: return value).size() * 20,
		"checks":checks,
		"scenarios":{"lesson":lesson, "exposed":exposed, "contained":contained}
	}
	var directory := ProjectSettings.globalize_path("res://.factory")
	DirAccess.make_dir_recursive_absolute(directory)
	var output_path := directory.path_join("root-and-ruin-contract.json")
	var file := FileAccess.open(output_path, FileAccess.WRITE)
	file.store_string(JSON.stringify(report, "  ") + "\n")
	file.close()
	print("GAMEFACTORY_RESULT ", JSON.stringify({"status":report.status, "gameplay_contract_score":report.gameplay_contract_score, "report":output_path}))
	quit(0 if passed else 1)
