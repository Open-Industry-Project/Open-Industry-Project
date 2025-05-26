@tool
extends EditorPlugin

var character_spawned := false
var preview_mode: CheckBox
var character: CharacterBody3D
var rotation_gizmo: Control
var menu: MenuButton
var right_navigation_gizmo: Control
var left_navigation_gizmo: Control
var was_in_walk_mode := false
var editor_ui: Control

var overlay: Control

const CHARACTER_Y_OFFSET = 1.5
const FOCUS_RETURN_DELAY = 0.05

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
	
	overlay = Control.new()
	overlay.name = "FullscreenOverlay"
	overlay.anchor_left = 0
	overlay.anchor_right = 1
	overlay.anchor_top = 0
	overlay.anchor_bottom = 1
	overlay.mouse_filter = Control.MOUSE_FILTER_STOP
	overlay.draw.connect(_on_overlay_draw)
	
func _on_overlay_draw():
	var window_size = get_window().get_size() 
	overlay.draw_rect(Rect2(0, 0, window_size.x, window_size.y), Color(0, 0, 0, 0.1)) 

func _exit_tree():
	if is_instance_valid(overlay):
		overlay.queue_free()

func _notification(what: int) -> void:
	if what == NOTIFICATION_APPLICATION_FOCUS_OUT:
		handle_focus_lost()
	elif what == NOTIFICATION_APPLICATION_FOCUS_IN:
		handle_focus_gained()

func handle_focus_lost() -> void:
	if character_spawned and Input.mouse_mode == Input.MOUSE_MODE_CAPTURED:
		was_in_walk_mode = true
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
		var main_window = EditorInterface.get_base_control()
		if is_instance_valid(main_window):
			main_window.add_child(overlay)
			overlay.visible = true
			overlay.queue_redraw()

func handle_focus_gained() -> void:
	if was_in_walk_mode and character_spawned:
		await get_tree().process_frame
		
		var center = Vector2.ZERO
		var viewport = get_viewport()
		if viewport:
			center = viewport.get_visible_rect().size / 2
			viewport.warp_mouse(center)
		
		var click_event = InputEventMouseButton.new()
		click_event.button_index = MOUSE_BUTTON_LEFT
		click_event.pressed = true
		click_event.position = center
		Input.parse_input_event(click_event)
		
		click_event.pressed = false
		Input.parse_input_event(click_event)
		
		await get_tree().create_timer(FOCUS_RETURN_DELAY).timeout
			
		Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
		
		reset_camera_input()
		was_in_walk_mode = false
		
		var main_window = EditorInterface.get_base_control()
		if is_instance_valid(overlay):
			main_window.remove_child(overlay)
			overlay.visible = false
		

func reset_camera_input() -> void:
	if not character:
		return
		
	# Reset mouse input by manipulating the InputEventMouseMotion buffer
	# This is a more universal way to clear any pending mouse motion
	var event = InputEventMouseMotion.new()
	event.relative = Vector2.ZERO
	Input.parse_input_event(event)

func _forward_3d_gui_input(_camera: Camera3D, event: InputEvent):
	var root := EditorInterface.get_edited_scene_root() as Node3D
	if not root:
		return

	var canvas_viewport := root.get_viewport()
	var node3d_viewport := _camera.get_viewport()
	
	var key = event as InputEventKey
	var editor_settings := EditorInterface.get_editor_settings()
	
	if event.is_pressed() and (editor_settings.is_shortcut("Open Industry Project/Spawn Character", event) or (key != null and key.keycode == KEY_ESCAPE)):
		if not editor_ui:
			editor_ui = node3d_viewport.get_parent().get_parent().get_child(1)
			rotation_gizmo = editor_ui.get_child(8).get_child(0)
			menu = editor_ui.get_child(0).get_child(0)
			right_navigation_gizmo = editor_ui.get_child(6)
			left_navigation_gizmo = editor_ui.get_child(7)

		if Input.mouse_mode == Input.MOUSE_MODE_CAPTURED:
			exit_walk_mode(_camera, canvas_viewport, node3d_viewport)
		elif key != null and key.keycode != KEY_ESCAPE:
			enter_walk_mode(_camera, canvas_viewport, node3d_viewport)

	if canvas_viewport.gui_disable_input == true:
		return

	canvas_viewport.push_input(event)
	return AfterGUIInput.AFTER_GUI_INPUT_STOP

func exit_walk_mode(_camera: Camera3D, canvas_viewport: Viewport, node3d_viewport: Viewport) -> void:
	if not character_spawned:
		return

	character.release_held_box()
	var walk_camera: Camera3D = character.find_child("Camera", true, false)
	_camera.global_transform = walk_camera.global_transform
	canvas_viewport.gui_disable_input = true
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	get_tree().edited_scene_root.remove_child(character)
	character_spawned = false
	was_in_walk_mode = false
	RenderingServer.viewport_attach_camera(node3d_viewport.get_viewport_rid(), _camera.get_camera_rid())
	rotation_gizmo.visible = true
	
	if EditorInterface.get_editor_settings().get_setting("editors/3d/navigation/show_viewport_navigation_gizmo"):
		right_navigation_gizmo.visible = true
		left_navigation_gizmo.visible = true
	
	menu.visible = true

func enter_walk_mode(_camera: Camera3D, canvas_viewport: Viewport, node3d_viewport: Viewport) -> void:
	canvas_viewport.gui_disable_input = false
	InputMap.load_from_project_settings()
	Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
	
	var character_path = ProjectSettings.get_setting("addons/walk_mode/character/path")
	character = load(character_path).instantiate()
	
	var spawn_transform = _camera.global_transform
	spawn_transform.origin -= spawn_transform.basis.y * CHARACTER_Y_OFFSET
	character.global_transform = spawn_transform
	
	get_tree().edited_scene_root.add_child(character)
	character_spawned = true
	
	var camera = character.find_children("*", "Camera3D", true)
	if camera.size() > 0:
		RenderingServer.viewport_attach_camera(node3d_viewport.get_viewport_rid(), camera[0].get_camera_rid())
	
	rotation_gizmo.visible = false
	right_navigation_gizmo.visible = false
	left_navigation_gizmo.visible = false
	menu.visible = false
