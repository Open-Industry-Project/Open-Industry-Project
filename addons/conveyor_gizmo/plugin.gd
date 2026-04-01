@tool
extends EditorPlugin

const ConveyorGizmoPlugin = preload("res://addons/conveyor_gizmo/conveyor_gizmo_plugin.gd")

var gizmo_plugin: ConveyorGizmoPlugin
var _toggle_button: Button

func _enter_tree():
	gizmo_plugin = ConveyorGizmoPlugin.new()
	add_node_3d_gizmo_plugin(gizmo_plugin)

	_toggle_button = CheckButton.new()
	_toggle_button.text = "Sideguards"
	_toggle_button.tooltip_text = "Toggle sideguard editing handles"
	_toggle_button.toggled.connect(_on_sideguard_toggle)
	add_control_to_container(CONTAINER_SPATIAL_EDITOR_MENU, _toggle_button)

func _exit_tree():
	remove_node_3d_gizmo_plugin(gizmo_plugin)
	if _toggle_button:
		remove_control_from_container(CONTAINER_SPATIAL_EDITOR_MENU, _toggle_button)
		_toggle_button.queue_free()

func _on_sideguard_toggle(pressed: bool) -> void:
	gizmo_plugin.sideguard_mode = pressed
	# Force redraw on all gizmos so handles update immediately.
	var selection := EditorInterface.get_selection().get_selected_nodes()
	for node in selection:
		if node is Node3D:
			node.update_gizmos()