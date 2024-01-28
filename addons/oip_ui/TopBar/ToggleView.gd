@tool
extends HBoxContainer

@export var texture_3d: Texture
@export var texture_script: Texture

@onready var _button: Button = $Button


func _ready() -> void:
	_button.toggled.connect(func (toggled_on: bool) -> void:
		if toggled_on:
			_button.icon = texture_script
			_button.text = "Script"
			EditorInterface.set_main_screen_editor("Script")
		else:
			_button.icon = texture_3d
			_button.text = "3D"
			EditorInterface.set_main_screen_editor("3D")
	)
	
	_button.button_pressed = false
