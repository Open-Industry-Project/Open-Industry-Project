@tool
extends Button

const TIME_SCALE_KEY: String = "application/run/scene_time_scale"

var last_known_scale: float = 1.0

func _ready() -> void:
	toggle_mode = true
	tooltip_text = "Change speed (1x, 2x, 4x)"
	
	icon = get_theme_icon("Time", "EditorIcons")
	
	# Initialize or validate existing setting
	last_known_scale = _get_valid_time_scale()
	Engine.time_scale = last_known_scale
	_update_button_text()

	toggled.connect(_on_toggled)
	ProjectSettings.settings_changed.connect(_on_settings_changed)

func _on_toggled(_pressed: bool) -> void:
	var new_scale: float
	if last_known_scale < 1.0:
		new_scale = 1.0
	elif last_known_scale < 2.0:
		new_scale = 2.0
	elif last_known_scale < 4.0:
		new_scale = 4.0
	else:
		new_scale = 1.0

	_set_time_scale(new_scale)

func _on_settings_changed() -> void:
	var current_scale: Variant = ProjectSettings.get_setting(TIME_SCALE_KEY, 1.0)
	if current_scale <= 0:
		printerr("Unsupported time scale (<= 0). Reverting to last known scale: %.2f" % last_known_scale)
		_set_time_scale(last_known_scale)
		return

	if current_scale != last_known_scale:
		last_known_scale = current_scale
		Engine.time_scale = current_scale
		_update_button_text()

func _set_time_scale(value: float) -> void:
	last_known_scale = value
	ProjectSettings.set_setting(TIME_SCALE_KEY, value)
	ProjectSettings.save()
	Engine.time_scale = value
	_update_button_text()

func _get_valid_time_scale() -> float:
	if ProjectSettings.has_setting(TIME_SCALE_KEY):
		var saved_scale: Variant = ProjectSettings.get_setting(TIME_SCALE_KEY)
		if saved_scale > 0:
			return saved_scale
		printerr("Unsupported time scale (<= 0). Reverting to default 1.0.")

	# Set default
	ProjectSettings.set_setting(TIME_SCALE_KEY, 1.0)
	ProjectSettings.save()
	return 1.0

func _update_button_text() -> void:
	text = "%.2fx" % last_known_scale
	queue_redraw()
