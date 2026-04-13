@tool
class_name OIPUIPlugin
extends EditorPlugin

const ICON: Texture2D = preload("res://assets/png/OIP-LOGO-RGB_ICON.svg")

var _editor_node: Node
var _create_root_vbox: VBoxContainer
var _selected_nodes: Array[Node]


func _enter_tree() -> void:
	_editor_node = get_tree().root.get_child(0)
	call_deferred("_editor_layout_loaded")

	var editor_settings := EditorInterface.get_editor_settings()
	var use_shortcut := Shortcut.new()
	var key_stroke := InputEventKey.new()
	key_stroke.keycode = KEY_C
	use_shortcut.events.append(key_stroke)
	editor_settings.add_shortcut("Open Industry Project/Use", use_shortcut)

	EditorInterface.get_selection().selection_changed.connect(_on_selection_changed)


func _editor_layout_loaded() -> void:
	_create_root_vbox = _editor_node.find_child("BeginnerNodeShortcuts", true, false)

	if _create_root_vbox:
		var button := Button.new()
		button.text = "New Simulation"
		button.icon = ICON
		button.pressed.connect(self._new_simulation_btn_pressed)
		_create_root_vbox.add_child(button)
		_create_root_vbox.move_child(button, 0)
		_create_root_vbox.move_child(_create_root_vbox.get_child(1), 2)

	if get_tree().edited_scene_root == null:
		_create_new_simulation()


func _process(_delta: float) -> void:
	for node: Node in _selected_nodes:
		if not node:
			return
		if node.has_method("selected"):
			node.call("selected")


func _shortcut_input(event: InputEvent) -> void:
	var editor_settings := EditorInterface.get_editor_settings()
	if editor_settings.is_shortcut("Open Industry Project/Use", event) and event.is_pressed() and not event.is_echo():
		for node: Node in EditorInterface.get_selection().get_selected_nodes():
			if node.has_method("use"):
				node.call("use")


func _on_selection_changed() -> void:
	_selected_nodes = EditorInterface.get_selection().get_selected_nodes()


func _new_simulation_btn_pressed() -> void:
	get_undo_redo().create_action("Create New Simulation")
	get_undo_redo().add_do_method(self, "_create_new_simulation")
	get_undo_redo().add_undo_method(self, "_remove_new_simulation")
	get_undo_redo().commit_action()


func _create_new_simulation() -> void:
	var scene := Node3D.new()
	scene.name = "Simulation"
	var building: Node3D = load("res://parts/Building.tscn").instantiate()
	EditorInterface.add_root_node(scene)
	get_tree().edited_scene_root.add_child(building)
	building.owner = scene


func _remove_new_simulation() -> void:
	var root := get_tree().edited_scene_root
	if root:
		root.free()
