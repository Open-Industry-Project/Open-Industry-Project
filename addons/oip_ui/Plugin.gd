@tool
class_name OIPUIPlugin
extends EditorPlugin

const ICON: Texture2D = preload("res://assets/png/OIP-LOGO-RGB_ICON.svg")

var _editor_node: Node
var _create_root_vbox: VBoxContainer


func _enter_tree() -> void:
	_editor_node = get_tree().root.get_child(0)
	_editor_node.editor_layout_loaded.connect(_editor_layout_loaded)


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
		EditorInterface.mark_scene_as_saved()


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
	EditorInterface.remove_root_node()
