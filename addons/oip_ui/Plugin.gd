@tool
extends EditorPlugin

const CUSTOM_PROJECT_MENU: PackedScene = preload("res://addons/oip_ui/TopBar/CustomProject.tscn")
var _custom_project_menu: PopupMenu

const CUSTOM_HELP_MENU: PackedScene = preload("res://addons/oip_ui/TopBar/CustomHelp.tscn")
var _custom_help_menu: PopupMenu

const RUN_BAR: PackedScene = preload("res://addons/oip_ui/TopBar/RunBar.tscn")
var _run_bar: PanelContainer

# Menu buttons: top-left
var _menu_bar: MenuBar
var _project_popup_menu: PopupMenu
var _editor_popup_menu: PopupMenu
var _help_popup_menu: PopupMenu

# Top bar content
var _title_bar: Node
var _center_buttons: HBoxContainer
var _editor_run_bar_container: Node
var _renderer_selection: HBoxContainer

var _empty_margin: Control = Control.new()

# 3D Editor view
var _separator: VSeparator
var _camera_button: Button

# Bottom dock
var _debugger_button: Button
var _audio_button: Button
var _animation_button: Button
var _godot_version: VBoxContainer

var callable: Callable

func build() -> void:
	callable.call()

func _process(delta):
	var root = get_tree().edited_scene_root
	
	if(root != null && root.has_signal("SimulationStarted")):
		_run_bar._enable_buttons()
	else:
		_run_bar._disable_buttons()
	
func _enter_tree() -> void:
	
	_menu_bar = get_tree().root.get_child(0).get_child(4).get_child(0).get_child(0).get_child(0)
	_project_popup_menu = get_tree().root.get_child(0).get_child(4).get_child(0).get_child(0).get_child(0).get_child(1)
	_editor_popup_menu = get_tree().root.get_child(0).get_child(4).get_child(0).get_child(0).get_child(0).get_child(3)
	_help_popup_menu = get_tree().root.get_child(0).get_child(4).get_child(0).get_child(0).get_child(0).get_child(4)
	
	_title_bar = get_tree().root.get_child(0).get_child(4).get_child(0).get_child(0)
	_center_buttons = get_tree().root.get_child(0).get_child(4).get_child(0).get_child(0).get_child(2)
	_editor_run_bar_container = get_tree().root.get_child(0).get_child(4).get_child(0).get_child(0).get_child(4)
	_renderer_selection = get_tree().root.get_child(0).get_child(4).get_child(0).get_child(0).get_child(5)
	
	_separator = get_tree().root.get_child(0).get_child(4).get_child(0).get_child(1).get_child(1).get_child(1).get_child(0).get_child(0).get_child(0).get_child(0).get_child(1).get_child(0).get_child(1).get_child(0).get_child(0).get_child(0).get_child(14)
	_camera_button = get_tree().root.get_child(0).get_child(4).get_child(0).get_child(1).get_child(1).get_child(1).get_child(0).get_child(0).get_child(0).get_child(0).get_child(1).get_child(0).get_child(1).get_child(0).get_child(0).get_child(0).get_child(15)
	
	_debugger_button = get_tree().root.get_child(0).get_child(4).get_child(0).get_child(1).get_child(1).get_child(1).get_child(0).get_child(0).get_child(1).get_child(0).get_child(15).get_child(0).get_child(1)
	_audio_button = get_tree().root.get_child(0).get_child(4).get_child(0).get_child(1).get_child(1).get_child(1).get_child(0).get_child(0).get_child(1).get_child(0).get_child(15).get_child(0).get_child(3)
	_animation_button = get_tree().root.get_child(0).get_child(4).get_child(0).get_child(1).get_child(1).get_child(1).get_child(0).get_child(0).get_child(1).get_child(0).get_child(15).get_child(0).get_child(4)
	
	_custom_project_menu = _instantiate_custom_menu(CUSTOM_PROJECT_MENU, 2, "Project")
	_custom_help_menu = _instantiate_custom_menu(CUSTOM_HELP_MENU, 6, "Help")
	
	if(!FileAccess.file_exists("res://addons/oip_ui/build.txt")):
		var msBuildPanel = find_build_panel(get_parent())
		callable = Callable(msBuildPanel,"BuildProject")
		get_tree().root.connect("ready",Callable(self,"build"))
		var file = FileAccess.open("res://addons/oip_ui/build.txt",FileAccess.WRITE)
		file.store_string("This file was automatically generated. Do not delete")
		
	
	_toggle_native_mode(false)
	
	_run_bar = RUN_BAR.instantiate()
	_title_bar.add_child(_run_bar)
	_title_bar.move_child(_run_bar, 2)
	
	_title_bar.add_child(_empty_margin)
	_title_bar.move_child(_empty_margin, 4)
	_empty_margin.custom_minimum_size = Vector2(240, 0)
	
	_editor_popup_menu.add_separator()
	_editor_popup_menu.add_check_item("Toggle Godot Native UI")
	_editor_popup_menu.id_pressed.connect(_on_editor_popup_id_pressed)
	
	_custom_project_menu.id_pressed.connect(_on_custom_project_menu_id_pressed)
	_custom_help_menu.id_pressed.connect(_on_custom_help_menu_id_pressed)
	
	EditorInterface.get_editor_settings().set_setting("interface/editor/update_continuously",true)
	
func _exit_tree() -> void:
	_center_buttons.visible = true
	
	if _run_bar:
		_run_bar.queue_free()
	
	if _empty_margin:
		_empty_margin.queue_free()
	
	_editor_popup_menu.remove_item(13)
	_editor_popup_menu.remove_item(13)
	
	if _editor_popup_menu.id_pressed.is_connected(_on_editor_popup_id_pressed):
		_editor_popup_menu.id_pressed.disconnect(_on_editor_popup_id_pressed)
	
	if _custom_project_menu.id_pressed.is_connected(_on_custom_project_menu_id_pressed):
		_custom_project_menu.id_pressed.disconnect(_on_custom_project_menu_id_pressed)
	
	if _custom_help_menu.id_pressed.is_connected(_on_custom_help_menu_id_pressed):
		_custom_help_menu.id_pressed.disconnect(_on_custom_help_menu_id_pressed)
	
	if _custom_project_menu:
		_custom_project_menu.queue_free()
	
	if _custom_help_menu:
		_custom_help_menu.queue_free()
	
	_toggle_native_mode(true)


func _toggle_native_mode(native_mode: bool) -> void:	
	if !native_mode and get_node_or_null("/root/SimulationEvents"):
		EditorInterface.set_main_screen_editor("3D")
	
	if _custom_project_menu and _custom_help_menu:
		_menu_bar.set_menu_hidden(1, !native_mode)
		_menu_bar.set_menu_hidden(2, native_mode)
		_menu_bar.set_menu_hidden(3, !native_mode)
		_menu_bar.set_menu_hidden(5, !native_mode)
		_menu_bar.set_menu_hidden(6, native_mode)
	else:
		for menu in _menu_bar.get_children():
			_menu_bar.set_menu_hidden(menu.get_index(), false)
	
	if _run_bar:
		_run_bar.visible = !native_mode
	_center_buttons.visible = native_mode
	
	_editor_run_bar_container.visible = native_mode
	_renderer_selection.visible = native_mode
	
	_debugger_button.visible = native_mode
	_audio_button.visible = native_mode
	_animation_button.visible = native_mode
	
	_set_original_popup_menu(native_mode, _project_popup_menu, _custom_project_menu, "Project")
	_set_original_popup_menu(native_mode, _help_popup_menu, _custom_help_menu, "Help")
	
	_separator.visible = native_mode
	_camera_button.visible = native_mode
	
	_empty_margin.visible = !native_mode


func _instantiate_custom_menu(CUSTOM_MENU: PackedScene, index: int, node_name: String) -> PopupMenu:
	var custom_menu: PopupMenu = CUSTOM_MENU.instantiate()
	_menu_bar.add_child(custom_menu)
	_menu_bar.move_child(custom_menu, index)
	custom_menu.name = node_name
	custom_menu.visible = false
	return custom_menu


func _set_original_popup_menu(value: bool, original: PopupMenu, custom: PopupMenu, node_name: String) -> void:
	if value:
		if custom:
			custom.name = node_name + "Hidden"
		original.name = node_name
	else:
		original.name = node_name + "Hidden"
		if custom:
			custom.name = node_name


func _on_editor_popup_id_pressed(id: int) -> void:
	if id == 14:
		_editor_popup_menu.set_item_checked(id, !_editor_popup_menu.is_item_checked(id))
		_toggle_native_mode(_editor_popup_menu.is_item_checked(id))


func _on_custom_project_menu_id_pressed(id: int) -> void:
	if id in [36, 37, 38, 39]:
		_project_popup_menu.id_pressed.emit(id)


func _on_custom_help_menu_id_pressed(id: int) -> void:
	if id == 0:
		_help_popup_menu.id_pressed.emit(64)
	if id == 2:
		OS.shell_open("https://github.com/Automation-Standard/Open-Industry-Project")

func find_build_panel(node):
	# Iterate through each child of the current node
	for child in node.get_children():
		# Check if the child has the 'BuildProject' method
		if child.has_method("BuildProject"):
			return child  # Return the child if it has the method
		else:
			var found_child = find_build_panel(child)
			if found_child != null:
				return found_child  # Return the found child up the call stack
	return null  # Return None if no child with the method is found
