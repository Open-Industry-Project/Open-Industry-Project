@tool
extends EditorPlugin

var key_held = false
var preview_mode : CheckBox
var character : CharacterBody3D
var camera : Camera3D
var gizmo: Control
var menu: MenuButton
var gizmo1: Control
var gizmo2: Control

func _enter_tree() -> void:
	var editor_settings := EditorInterface.get_editor_settings()
	
	if not editor_settings.get_shortcut("Open Industry Project/Spawn Character"):
		var spawn_shortcut := Shortcut.new()
		var key_stroke := InputEventKey.new()
		key_stroke.keycode = KEY_R
		key_stroke.shift_pressed = true
		spawn_shortcut.events.append(key_stroke)
		editor_settings.add_shortcut("Open Industry Project/Spawn Character", spawn_shortcut)
		print(key_stroke)
		
	ProjectSettings.set_setting("addons/walk_mode/character/path", "res://addons/fpc/character.tscn")
	set_input_event_forwarding_always_enabled() 
	camera = EditorInterface.get_editor_viewport_3d(0).get_camera_3d()
	gizmo = get_tree().root.get_child(0).get_child(4).get_child(0).get_child(1).get_child(1).get_child(1).get_child(0).get_child(0).get_child(0).get_child(0).get_child(1).get_child(0).get_child(1).get_child(1).get_child(0).get_child(0).get_child(0).get_child(0).get_child(1).get_child(8).get_child(0)
	menu = get_tree().root.get_child(0).get_child(4).get_child(0).get_child(1).get_child(1).get_child(1).get_child(0).get_child(0).get_child(0).get_child(0).get_child(1).get_child(0).get_child(1).get_child(1).get_child(0).get_child(0).get_child(0).get_child(0).get_child(1).get_child(0).get_child(0)
	gizmo1 = get_tree().root.get_child(0).get_child(4).get_child(0).get_child(1).get_child(1).get_child(1).get_child(0).get_child(0).get_child(0).get_child(0).get_child(1).get_child(0).get_child(1).get_child(1).get_child(0).get_child(0).get_child(0).get_child(0).get_child(1).get_child(6)
	gizmo2 = get_tree().root.get_child(0).get_child(4).get_child(0).get_child(1).get_child(1).get_child(1).get_child(0).get_child(0).get_child(0).get_child(0).get_child(1).get_child(0).get_child(1).get_child(1).get_child(0).get_child(0).get_child(0).get_child(0).get_child(1).get_child(7)

func _forward_3d_gui_input(_camera: Camera3D, event: InputEvent):	
	var root := EditorInterface.get_edited_scene_root() as Node3D
	
	if(!root):
		return
		
	var viewport := root.get_viewport()
	var viewport2 := _camera.get_viewport()
	camera = _camera
	
	var editor_settings := EditorInterface.get_editor_settings()
	if editor_settings.is_shortcut("Open Industry Project/Spawn Character", event) and event.is_pressed():
		if Input.mouse_mode == Input.MOUSE_MODE_CAPTURED:
			viewport.gui_disable_input = true
			Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
			get_tree().edited_scene_root.remove_child(character)
			RenderingServer.viewport_attach_camera(EditorInterface.get_editor_viewport_3d(0).get_viewport_rid(),camera.get_camera_rid())
			InputMap.load_default()
			
			gizmo.visible = true
			if(EditorInterface.get_editor_settings().get_setting("editors/3d/navigation/show_viewport_navigation_gizmo")):
				gizmo1.visible = true
				gizmo2.visible = true
			menu.visible = true
		else:
			viewport.gui_disable_input = false
			InputMap.load_from_project_settings()
			Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
			character = load(ProjectSettings.get_setting("addons/walk_mode/character/path")).instantiate()
			get_tree().edited_scene_root.add_child(character)
			RenderingServer.viewport_attach_camera(viewport2.get_viewport_rid(),character.find_children("*","Camera3D",true)[0].get_camera_rid())
			gizmo.visible = false
			gizmo1.visible = false
			gizmo2.visible = false
			menu.visible = false
					
	if(viewport.gui_disable_input == true):
		return

	viewport.push_input(event)
	# If any node calls `set_input_as_handled()`, the event is not passed on to other editor gizmos / plugins.
	return AfterGUIInput.AFTER_GUI_INPUT_STOP
	
