@tool
extends EditorPlugin

var character = preload("res://addons/fpc/character.tscn").instantiate()
var key_held: bool

func _enter_tree() -> void:
	set_input_event_forwarding_always_enabled() 

func _forward_3d_gui_input(_viewport_camera: Camera3D, event: InputEvent):
	if event is InputEventMouseMotion:
		SimulationEvents.mouseInput.x += event.relative.x
		SimulationEvents.mouseInput.y += event.relative.y
	elif event is InputEventKey:
		if (event.keycode != KEY_R && !event.shift_pressed):
			key_held = false
			return
		if(event.keycode == KEY_R and event.shift_pressed):
			if(!key_held):
				key_held = true
				if Input.mouse_mode == Input.MOUSE_MODE_CAPTURED:
					Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
					get_tree().edited_scene_root.remove_child(character)
				else:
					Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
					get_tree().edited_scene_root.add_child(character)
	return EditorPlugin.AFTER_GUI_INPUT_PASS
