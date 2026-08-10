extends Node

var tuning := 0.5
var samples := 0

func factory_setup(_parameters: Dictionary) -> void:
	if FileAccess.file_exists("res://tuning.json"):
		var parsed = JSON.parse_string(FileAccess.get_file_as_string("res://tuning.json"))
		if parsed is Dictionary:
			tuning = float(parsed.get("fun_score", tuning))

func factory_tick(_tick: int) -> void:
	samples += 1

func factory_sample() -> Dictionary:
	return {"fun_score": tuning, "samples": samples}

func factory_collect() -> Dictionary:
	return {
		"metrics": {"fun_score": tuning, "samples": samples},
		"violations": [] if samples > 0 else [{
			"code": "example.no_samples",
			"message": "The simulation did not advance.",
			"severity": "error"
		}]
	}
