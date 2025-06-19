@tool
extends EditorPlugin

const ConveyorGizmoPlugin = preload("res://addons/conveyor_gizmo/conveyor_gizmo_plugin.gd")

var gizmo_plugin

func _enter_tree():
	gizmo_plugin = ConveyorGizmoPlugin.new()
	add_node_3d_gizmo_plugin(gizmo_plugin)

func _exit_tree():
	remove_node_3d_gizmo_plugin(gizmo_plugin) 