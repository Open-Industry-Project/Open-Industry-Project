@tool
extends Button

var time_scale_options := [1.0, 2.0, 4.0]
var last_known_scale := 1.0

func _ready():
	toggle_mode = true
	tooltip_text = "Change speed (1x, 2x, 4x)"

	last_known_scale = ProjectSettings.get_setting("application/run/scene_time_scale", 1.0)
	if last_known_scale < 0:
		last_known_scale = 0.1
		ProjectSettings.set_setting("application/run/scene_time_scale", last_known_scale)
		ProjectSettings.save()

	Engine.time_scale = last_known_scale
	_update_button_text()

	toggled.connect(_on_toggled)
	set_process(true)

func _on_toggled(_pressed: bool):
	var new_scale: float
	if last_known_scale < 1.0:
		new_scale = 1.0
	elif last_known_scale < 2.0:
		new_scale = 2.0
	elif last_known_scale < 4.0:
		new_scale = 4.0
	else:
		new_scale = 1.0

	ProjectSettings.set_setting("application/run/scene_time_scale", new_scale)
	ProjectSettings.save()
	Engine.time_scale = new_scale
	last_known_scale = new_scale
	_update_button_text()

func _process(_delta: float) -> void:
	var current_scale = ProjectSettings.get_setting("application/run/scene_time_scale", 1.0)

	if current_scale <= 0:
		current_scale = 0.1
		ProjectSettings.set_setting("application/run/scene_time_scale", current_scale)
		ProjectSettings.save()
		print("Time scale was zero or negative, set to 0.1")

	if current_scale != last_known_scale:
		last_known_scale = current_scale
		Engine.time_scale = current_scale
		_update_button_text()


func _update_button_text():
	text = str("%.2f" % last_known_scale) + "x"
	queue_redraw()
