@tool
extends HBoxContainer

@export var texture_3d: Texture
@export var texture_script: Texture

@onready var _screen_button: Button = $ScreenButton

func _ready() -> void:
	_screen_button.pressed.connect(self._screen_button_pressed)

func _screen_button_pressed():
	var window = _get_visible_window()
	
	if window.contains("WindowWrapper"):
		_screen_button.icon = texture_3d
		EditorInterface.set_main_screen_editor("3D")
	else:
		_screen_button.icon = texture_script
		EditorInterface.set_main_screen_editor("Script")

func _get_visible_window() -> String:
	for window in EditorInterface.get_editor_main_screen().get_children():
		if window.visible == true:
			return window.name
	return ""
