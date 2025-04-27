@tool
extends EditorPlugin

const CUSTOM_PROJECT_MENU: PackedScene = preload("res://addons/oip_ui/TopBar/CustomProject.tscn")
var _custom_project_menu: PopupMenu

const CUSTOM_HELP_MENU: PackedScene = preload("res://addons/oip_ui/TopBar/CustomHelp.tscn")
var _custom_help_menu: PopupMenu

const RUN_BAR: PackedScene = preload("res://addons/oip_ui/TopBar/RunBar.tscn")
var _run_bar: PanelContainer

const TOGGLE_VIEW: PackedScene = preload("res://addons/oip_ui/TopBar/ToggleView.tscn")
var _toggle_view: HBoxContainer

const ICON: Texture2D = preload("res://assets/png/OIP-LOGO-RGB_ICON.svg")

var _layout_loaded : bool = false

# Editor Node
var _editor_node: Node

# Editor Scene Tabs
var _editor_scene_tabs: Node

# Menu buttons: top-left
var _menu_bar: MenuBar
var _project_popup_menu: PopupMenu
var _editor_popup_menu: PopupMenu
var _help_popup_menu: PopupMenu

# Menu item IDs
const ID_TOGGLE_NATIVE_UI = 1234
# The IDs here must match those in the original Project menu (_project_popup_menu).
const ID_PROJECT_SETTINGS = 18
const ID_PACK_PROJECT_AS_ZIP = 21
const ID_OPEN_USER_DATA_FOLDER = 23
const ID_RELOAD_CURRENT_PROJECT = 24
const ID_QUIT_TO_PROJECT_LIST = 25
# This ID must match the ID for the "Search Help..." item in the original Help menu (_help_popup_menu).
const ID_SEARCH_HELP = 44

# Top bar content
var _title_bar: Node
var _center_buttons: HBoxContainer
var _editor_run_bar_container: Node
var _renderer_selection: HBoxContainer

var _empty_margin: Control = Control.new()

# Create Root Node
var _create_root_vbox: VBoxContainer
var _scene_tabs: TabBar

# Perspective Menu
var _perspective_menu: MenuButton

func _scene_changed(root : Node):
	if(!_layout_loaded):
		return

	if(root != null):
		_run_bar._enable_buttons()
	else:
		_run_bar._disable_buttons()

	if(root == null):
		return

	_run_bar.stop_simulation()
		

func _enter_tree() -> void:
	# Set minimum editor window size to 1075px width for the OIP plugin
	var editor_window = EditorInterface.get_base_control().get_window()
	var current_min_size = editor_window.get_min_size()
	editor_window.set_min_size(Vector2(1075, current_min_size.y))
	
	_editor_node = get_tree().root.get_child(0)

	if(EditorInterface.has_method("mark_scene_as_saved")):
		_editor_node.connect("editor_layout_loaded", _editor_layout_loaded)

func _on_id_pressed(id: int) -> void:
	if get_tree().edited_scene_root == null:
		return

	var building = get_tree().edited_scene_root.get_node_or_null("Building")
	if building == null:
		return

	var roof = building.get_child(2) as GridMap
	var index = _perspective_menu.get_popup().get_item_index(10)
	var is_perspective_checked = _perspective_menu.get_popup().is_item_checked(index)

	roof.visible = is_perspective_checked || (id > 0 && id < 8)

func _exit_tree() -> void:
	# Reset minimum window size when plugin is disabled
	var editor_window = EditorInterface.get_base_control().get_window()
	editor_window.set_min_size(Vector2(0, 0))
	
	_center_buttons.visible = true

	if _run_bar:
		_run_bar.queue_free()

	if _toggle_view:
		_toggle_view.queue_free()

	if _empty_margin:
		_empty_margin.queue_free()

	var item_index = _editor_popup_menu.get_item_index(ID_TOGGLE_NATIVE_UI)
	_editor_popup_menu.remove_item(item_index)
	_editor_popup_menu.remove_item(item_index - 1)

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

func _editor_layout_loaded():
	_layout_loaded = true

	_menu_bar = _editor_node.get_child(4).get_child(0).get_child(0).get_child(0)
	_project_popup_menu = _editor_node.get_child(4).get_child(0).get_child(0).get_child(0).get_child(1)
	_editor_popup_menu = _editor_node.get_child(4).get_child(0).get_child(0).get_child(0).get_child(3)
	_help_popup_menu = _editor_node.get_child(4).get_child(0).get_child(0).get_child(0).get_child(4)

	_title_bar = _editor_node.get_child(4).get_child(0).get_child(0)
	_center_buttons = _editor_node.get_child(4).get_child(0).get_child(0).get_child(2)
	_editor_run_bar_container = _editor_node.get_child(4).get_child(0).get_child(0).get_child(4)
	_renderer_selection = _editor_node.get_child(4).get_child(0).get_child(0).get_child(5)

	_create_root_vbox = _editor_node.find_children("Scene","SceneTreeDock",true,false)[0].get_child(2).get_child(1).get_child(0).get_child(0)
	_scene_tabs = _editor_node.get_child(4).get_child(0).get_child(1).get_child(1).get_child(1).get_child(0).get_child(0).get_child(0).get_child(0).get_child(0).get_child(0).get_child(0).get_child(0)
	_perspective_menu = _editor_node.get_child(4).get_child(0).get_child(1).get_child(1).get_child(1).get_child(0).get_child(0).get_child(0).get_child(0).get_child(1).get_child(0).get_child(1).get_child(1).get_child(0).get_child(0).get_child(0).get_child(0).get_child(1).get_child(0).get_child(0)

	_custom_project_menu = _instantiate_custom_menu(CUSTOM_PROJECT_MENU, 2, "Project")
	_custom_help_menu = _instantiate_custom_menu(CUSTOM_HELP_MENU, 6, "Help")

	_editor_scene_tabs = _editor_node.get_child(4).get_child(0).get_child(1).get_child(1).get_child(1).get_child(0).get_child(0).get_child(0).get_child(0).get_child(0)
	_toggle_native_mode(false)

	_run_bar = RUN_BAR.instantiate()
	_title_bar.add_child(_run_bar)
	_title_bar.move_child(_run_bar, 2)

	_title_bar.add_child(_empty_margin)
	_title_bar.move_child(_empty_margin, 4)

	_toggle_view = TOGGLE_VIEW.instantiate()
	_title_bar.add_child(_toggle_view)
	
	# Set fixed size for empty margin to ensure buttons are properly spaced
	_empty_margin.custom_minimum_size = Vector2(20, 0)

	_editor_popup_menu.add_separator()
	_editor_popup_menu.add_check_item("Toggle Godot Native UI",ID_TOGGLE_NATIVE_UI)
	_editor_popup_menu.id_pressed.connect(_on_editor_popup_id_pressed)

	_custom_project_menu.id_pressed.connect(_on_custom_project_menu_id_pressed)
	_custom_help_menu.id_pressed.connect(_on_custom_help_menu_id_pressed)

	if(EditorInterface.has_method("set_simulation_started")):
		var button = Button.new()
		button.text = "New Simulation"
		button.icon = ICON
		button.pressed.connect(self._new_simulation_btn_pressed)
		_create_root_vbox.add_child(button)
		_create_root_vbox.move_child(button,0)
		_create_root_vbox.move_child(_create_root_vbox.get_child(1),2)

	EditorInterface.get_editor_settings().set_setting("interface/editor/update_continuously",true)

	_perspective_menu.get_popup().id_pressed.connect(_on_id_pressed)
	scene_changed.connect(_scene_changed)

	var root = get_tree().edited_scene_root

	_run_bar._enable_buttons()

	if EditorInterface.get_open_scenes().size() == 0:
		_create_new_simulation()
		EditorInterface.call("mark_scene_as_saved")

func _new_simulation_btn_pressed():
		get_undo_redo().create_action("Create New Simulation")
		get_undo_redo().add_do_method(self,"_create_new_simulation")
		get_undo_redo().add_undo_method(self,"_remove_new_simulation")
		get_undo_redo().commit_action()

func _create_new_simulation():
	var script = EditorScript.new()
	var scene = Node3D.new()
	scene.name = "Simulation"
	var building : Node3D = load("res://parts/Building.tscn").instantiate()
	script.add_root_node(scene)
	get_tree().edited_scene_root.add_child(building)
	building.owner = scene
	if(_run_bar != null):
		_run_bar._enable_buttons()

func _remove_new_simulation():
	var script = EditorScript.new()
	script.call("remove_root_node")

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
	if _toggle_view:
		_toggle_view.visible = !native_mode
	_center_buttons.visible = native_mode

	_editor_run_bar_container.visible = native_mode
	_renderer_selection.visible = native_mode

	_set_original_popup_menu(native_mode, _project_popup_menu, _custom_project_menu, "Project")
	_set_original_popup_menu(native_mode, _help_popup_menu, _custom_help_menu, "Help")

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
	if id == ID_TOGGLE_NATIVE_UI:
		var index = _editor_popup_menu.get_item_index(ID_TOGGLE_NATIVE_UI)
		_editor_popup_menu.set_item_checked(index, !_editor_popup_menu.is_item_checked(index))
		_toggle_native_mode(_editor_popup_menu.is_item_checked(index))


func _on_custom_project_menu_id_pressed(id: int) -> void:
	# Piggyback off the original project menu by emitting its events.
	var native_item_id
	match id:
		0:
			native_item_id = ID_PROJECT_SETTINGS
		1:
			native_item_id = ID_PACK_PROJECT_AS_ZIP
		2:
			native_item_id = ID_OPEN_USER_DATA_FOLDER
		3:
			native_item_id = ID_RELOAD_CURRENT_PROJECT
		4:
			native_item_id = ID_QUIT_TO_PROJECT_LIST
		_:
			native_item_id = null
	# Check if the ID still exists in the original menu.
	# If not, the menu ID constants need to be updated.
	if native_item_id == null or -1 == _project_popup_menu.get_item_index(native_item_id):
		print("Menu item broken! OIP maintainers should fix it with the info below.")
		print("Valid 'Project' menu item IDs:")
		_print_menu_ids(_project_popup_menu)
		return
	_project_popup_menu.id_pressed.emit(native_item_id)


func _on_custom_help_menu_id_pressed(id: int) -> void:
	if id == 0:
		# Piggyback off the original help menu by emitting its event.
		var native_item_id = ID_SEARCH_HELP
		# Check if the ID still exists in the original menu.
		# If not, the menu ID constants need to be updated.
		if native_item_id == null or -1 == _help_popup_menu.get_item_index(native_item_id):
			print("Menu item broken! OIP maintainers should fix it with the info below.")
			print("Valid 'Help' menu item IDs:")
			_print_menu_ids(_help_popup_menu)
			return
		_help_popup_menu.id_pressed.emit(native_item_id)
	if id == 2:
		OS.shell_open("https://github.com/Open-Industry-Project/Open-Industry-Project")

static func _print_menu_ids(menu: PopupMenu) -> void:
	for item_index in range(menu.item_count):
		var item_id = menu.get_item_id(item_index)
		var item_text = menu.get_item_text(item_index)
		print("* " + str(item_id) + ": " + item_text)
