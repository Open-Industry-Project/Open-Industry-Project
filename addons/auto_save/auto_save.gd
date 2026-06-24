@tool
extends EditorPlugin

var autosave_enabled := false
var is_saving := false  # Flag to track if a save is in progress
var last_save_time := Time.get_unix_time_from_system()

# Settings keys
const SETTINGS_KEY_ENABLED := "run/auto_save/auto_save_enabled"
const SETTINGS_KEY_INTERVAL_ENABLED := "run/auto_save/interval_enabled"
const SETTINGS_KEY_INTERVAL := "run/auto_save/save_interval"
const SETTINGS_KEY_FOCUS_LOST := "run/auto_save/save_on_focus_lost"
const SETTINGS_KEY_ON_CHANGES := "run/auto_save/save_on_changes"

# Default values
const DEFAULT_INTERVAL := 60.0

func _enter_tree():
	var editor_settings = EditorInterface.get_editor_settings()

	# Master toggle
	if not editor_settings.has_setting(SETTINGS_KEY_ENABLED):
		editor_settings.set_setting(SETTINGS_KEY_ENABLED, false)
	editor_settings.add_property_info({
		"name": SETTINGS_KEY_ENABLED,
		"type": TYPE_BOOL,
	})

	# Save on Interval
	if not editor_settings.has_setting(SETTINGS_KEY_INTERVAL_ENABLED):
		editor_settings.set_setting(SETTINGS_KEY_INTERVAL_ENABLED, false)
	editor_settings.add_property_info({
		"name": SETTINGS_KEY_INTERVAL_ENABLED,
		"type": TYPE_BOOL,
	})

	# Save Interval
	if not editor_settings.has_setting(SETTINGS_KEY_INTERVAL):
		editor_settings.set_setting(SETTINGS_KEY_INTERVAL, DEFAULT_INTERVAL)
	editor_settings.add_property_info({
		"name": SETTINGS_KEY_INTERVAL,
		"type": TYPE_FLOAT,
		"hint": PROPERTY_HINT_RANGE,
		"hint_string": "5,600,5",
	})

	# Save on Focus Lost
	if not editor_settings.has_setting(SETTINGS_KEY_FOCUS_LOST):
		editor_settings.set_setting(SETTINGS_KEY_FOCUS_LOST, false)
	editor_settings.add_property_info({
		"name": SETTINGS_KEY_FOCUS_LOST,
		"type": TYPE_BOOL,
	})

	# Save on Changes
	if not editor_settings.has_setting(SETTINGS_KEY_ON_CHANGES):
		editor_settings.set_setting(SETTINGS_KEY_ON_CHANGES, false)
	editor_settings.add_property_info({
		"name": SETTINGS_KEY_ON_CHANGES,
		"type": TYPE_BOOL,
	})

	# Watch for editor setting changes
	if not editor_settings.is_connected("settings_changed", Callable(self, "_on_editor_settings_changed")):
		editor_settings.connect("settings_changed", Callable(self, "_on_editor_settings_changed"))

	# Read current config
	_update_config()

	# Focus lost handling
	var main_window = EditorInterface.get_base_control()
	if is_instance_valid(main_window):
		if not main_window.get_viewport().is_connected("focus_exited", Callable(self, "_on_editor_focus_lost")):
			main_window.get_viewport().connect("focus_exited", Callable(self, "_on_editor_focus_lost"))

	# Save on Changes
	if editor_settings.get_setting(SETTINGS_KEY_ON_CHANGES):
		_connect_save_on_change()

func _exit_tree():
	# Disconnect signals
	var main_window = EditorInterface.get_base_control()
	if is_instance_valid(main_window):
		if main_window.get_viewport().is_connected("focus_exited", Callable(self, "_on_editor_focus_lost")):
			main_window.get_viewport().disconnect("focus_exited", Callable(self, "_on_editor_focus_lost"))

	_disconnect_save_on_change()

	if EditorInterface.get_editor_settings().is_connected("settings_changed", Callable(self, "_on_editor_settings_changed")):
		EditorInterface.get_editor_settings().disconnect("settings_changed", Callable(self, "_on_editor_settings_changed"))

#Process is needed to check the interval in real-time
func _process(_delta):
	if not autosave_enabled:
		return
	if not EditorInterface.get_editor_settings().get_setting(SETTINGS_KEY_INTERVAL_ENABLED):
		return

	var interval = EditorInterface.get_editor_settings().get_setting(SETTINGS_KEY_INTERVAL)
	var now = Time.get_unix_time_from_system()
	if now - last_save_time >= interval:
		last_save_time = now
		_trigger_save()

func _on_editor_settings_changed():
	_update_config()

func _update_config():
	var editor_settings = EditorInterface.get_editor_settings()
	autosave_enabled = editor_settings.get_setting(SETTINGS_KEY_ENABLED)
	last_save_time = Time.get_unix_time_from_system()

	if autosave_enabled and editor_settings.get_setting(SETTINGS_KEY_ON_CHANGES):
		_connect_save_on_change()
	else:
		_disconnect_save_on_change()

func _connect_save_on_change():
	if not EditorInterface.is_connected("scene_modification_state_changed", Callable(self, "_on_scene_modification_changed")):
		EditorInterface.connect("scene_modification_state_changed", Callable(self, "_on_scene_modification_changed"))
		_force_check_scene_modification_state()

func _disconnect_save_on_change():
	if EditorInterface.is_connected("scene_modification_state_changed", Callable(self, "_on_scene_modification_changed")):
		EditorInterface.disconnect("scene_modification_state_changed", Callable(self, "_on_scene_modification_changed"))

func _force_check_scene_modification_state():
	if EditorInterface.is_scene_modified():
		_trigger_save()

func _on_editor_focus_lost():
	if autosave_enabled and EditorInterface.get_editor_settings().get_setting(SETTINGS_KEY_FOCUS_LOST):
		_trigger_save()

func _on_scene_modification_changed(modified: bool):
	if modified:
		_trigger_save()

func _trigger_save():
	if is_saving:
		return
	if not EditorInterface.is_scene_modified():
		return

	is_saving = true
	var scene_root = EditorInterface.get_edited_scene_root()
	if scene_root:
		var scene_path = scene_root.get_scene_file_path()
		if scene_path != "":
			EditorInterface.save_scene_as(scene_path, false)
		else:
			EditorInterface.save_scene_as("res://new_scene.tscn")
	is_saving = false
