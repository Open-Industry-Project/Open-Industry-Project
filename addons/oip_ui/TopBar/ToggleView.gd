@tool
extends HBoxContainer

@export var icon_3d_view: Texture2D
@export var icon_script_view: Texture2D

@onready var _screen_button: Button = $ScreenButton

func _ready() -> void:
	_screen_button.pressed.connect(self._screen_button_pressed)

func _screen_button_pressed() -> void:
	var window = _get_visible_window()

	if window.contains("WindowWrapper"):
		_screen_button.icon = icon_3d_view
		EditorInterface.set_main_screen_editor("3D")
	else:
		_screen_button.icon = icon_script_view
		EditorInterface.set_main_screen_editor("Script")

func _get_visible_window() -> String:
	for window in EditorInterface.get_editor_main_screen().get_children():
		if window.visible == true:
			return window.name
	return ""
