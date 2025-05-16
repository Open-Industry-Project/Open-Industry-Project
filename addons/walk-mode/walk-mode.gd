@tool
extends EditorPlugin

var character_spawned := false
var preview_mode: CheckBox
var character: CharacterBody3D
var rotation_gizmo: Control
var menu: MenuButton
var right_navigation_gizmo: Control
var left_navigation_gizmo: Control
var focus_lost := false

func _enter_tree() -> void:
	var editor_settings := EditorInterface.get_editor_settings()
	
	if not editor_settings.get_shortcut("Open Industry Project/Spawn Character"):
		var spawn_shortcut := Shortcut.new()
		var key_stroke := InputEventKey.new()
		key_stroke.keycode = KEY_R
		key_stroke.shift_pressed = true
		spawn_shortcut.events.append(key_stroke)
		editor_settings.add_shortcut("Open Industry Project/Spawn Character", spawn_shortcut)
	
	if not ProjectSettings.get_setting("addons/walk_mode/character/path"):
		ProjectSettings.set_setting("addons/walk_mode/character/path", "res://addons/fpc/character.tscn")
	
	ProjectSettings.set_as_basic("addons/walk_mode/character/path", true)

	set_input_event_forwarding_always_enabled()
	
	get_viewport().connect("focus_entered", _on_window_focus_in)
	get_viewport().connect("focus_exited", _on_window_focus_out)

func _exit_tree() -> void:
	if get_viewport().is_connected("focus_entered", _on_window_focus_in):
		get_viewport().disconnect("focus_entered", _on_window_focus_in)
	if get_viewport().is_connected("focus_exited", _on_window_focus_out):
		get_viewport().disconnect("focus_exited", _on_window_focus_out)	

func _forward_3d_gui_input(_camera: Camera3D, event: InputEvent):
	var root := EditorInterface.get_edited_scene_root() as Node3D
	var key = event as InputEventKey

	if not root:
		return

	var canvas_viewport := root.get_viewport()
	var node3d_viewport := _camera.get_viewport()
	var editor_settings := EditorInterface.get_editor_settings()

	if event.is_pressed() and (editor_settings.is_shortcut("Open Industry Project/Spawn Character", event) or (key != null and key.keycode == KEY_ESCAPE)):
		var editor_ui = node3d_viewport.get_parent().get_parent().get_child(1)
		rotation_gizmo = editor_ui.get_child(8).get_child(0)
		menu = editor_ui.get_child(0).get_child(0)
		right_navigation_gizmo = editor_ui.get_child(6)
		left_navigation_gizmo = editor_ui.get_child(7)

		if Input.mouse_mode == Input.MOUSE_MODE_CAPTURED:
			if not character_spawned:
				return

			focus_lost = false

			character.release_held_box()
			var walk_camera: Camera3D = character.find_child("Camera", true, false)
			_camera.global_transform = walk_camera.global_transform
			canvas_viewport.gui_disable_input = true
			Input.mouse_mode = Input.MOUSE_MODE_VISIBLE

			get_tree().edited_scene_root.remove_child(character)
			character_spawned = false

			RenderingServer.viewport_attach_camera(node3d_viewport.get_viewport_rid(), _camera.get_camera_rid())

			rotation_gizmo.visible = true
			if editor_settings.get_setting("editors/3d/navigation/show_viewport_navigation_gizmo"):
				right_navigation_gizmo.visible = true
				left_navigation_gizmo.visible = true
			menu.visible = true

		elif key != null and key.keycode != KEY_ESCAPE:
			focus_lost = false
			canvas_viewport.gui_disable_input = false
			InputMap.load_from_project_settings()
			Input.mouse_mode = Input.MOUSE_MODE_CAPTURED

			character = load(ProjectSettings.get_setting("addons/walk_mode/character/path")).instantiate()
			var spawn_transform = _camera.global_transform
			spawn_transform.origin -= spawn_transform.basis.y * 1.5
			character.global_transform = spawn_transform

			get_tree().edited_scene_root.add_child(character)
			character_spawned = true

			RenderingServer.viewport_attach_camera(node3d_viewport.get_viewport_rid(),character.find_children("*", "Camera3D", true)[0].get_camera_rid())

			rotation_gizmo.visible = false
			right_navigation_gizmo.visible = false
			left_navigation_gizmo.visible = false
			menu.visible = false

	if canvas_viewport.gui_disable_input:
		return

	canvas_viewport.push_input(event)
	return AfterGUIInput.AFTER_GUI_INPUT_STOP
	
func _on_window_focus_out():
	if character_spawned:
		focus_lost = true

func _on_window_focus_in():
	if character_spawned:
		focus_lost = false
		delayed_recapture()
		
func delayed_recapture():
	await get_tree().create_timer(0.2).timeout
	_recapture()

func _recapture():
	if character_spawned:
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
		await get_tree().create_timer(0.1).timeout
		Input.mouse_mode = Input.MOUSE_MODE_CAPTURED

func _input(event):
	if focus_lost and character_spawned:
		if event is InputEventMouseButton and not event.pressed:
			focus_lost = false
			call_deferred("_recapture")
		elif event is InputEventMouseMotion:
			call_deferred("_recapture")
			focus_lost = false
