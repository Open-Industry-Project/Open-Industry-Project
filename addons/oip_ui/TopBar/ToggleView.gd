@tool
extends HBoxContainer

@export var texture_3d: Texture
@export var texture_script: Texture

@onready var _button: Button = $Button

func _ready() -> void:
	_button.pressed.connect(self._button_pressed)

func _button_pressed():
	var window = _get_visible_window()
	
	if window.contains("WindowWrapper"):
		_button.icon = texture_3d
		_button.text = "3D"
		EditorInterface.set_main_screen_editor("3D")
	else:
		_button.icon = texture_script
		_button.text = "Script"
		EditorInterface.set_main_screen_editor("Script")

func _get_visible_window() -> String:
	for window in EditorInterface.get_editor_main_screen().get_children():
		if window.visible == true:
			return window.name
	return ""
