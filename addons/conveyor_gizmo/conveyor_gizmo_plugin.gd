@tool
extends EditorNode3DGizmoPlugin

const HANDLE_SIZE = 0.1
const HANDLE_COLOR = Color(1, 0.5, 0, 1)
const HANDLE_COLOR_HOVER = Color(1, 0.8, 0, 1)

var _initial_state = {}

func _get_gizmo_name():
	return "ConveyorGizmo"

func _has_gizmo(node):
	if not node is ResizableNode3D:
		return false
	
	var node_script = node.get_script()
	if node_script == null:
		return false
		
	var script_path = node_script.resource_path
	var valid_scripts = [
		"res://src/Conveyor/belt_conveyor.gd",
		"res://src/Conveyor/curved_belt_conveyor.gd",
		"res://src/RollerConveyor/roller_conveyor.gd",
		"res://parts/curved_roller_conveyor.gd",
		"res://src/ConveyorAssembly/belt_conveyor_assembly.gd",
		"res://src/ConveyorAssembly/roller_conveyor_assembly.gd",
		"res://src/ConveyorAssembly/spur_conveyor_assembly.gd"
	]
	
	return script_path in valid_scripts

func _init():
	create_material("handles", HANDLE_COLOR)
	create_material("handles_hover", HANDLE_COLOR_HOVER)
	create_handle_material("handles", false)
	
	var handle_mat = get_material("handles", null)
	if handle_mat:
		handle_mat.vertex_color_use_as_albedo = true
		handle_mat.albedo_color = HANDLE_COLOR

func _redraw(gizmo: EditorNode3DGizmo):
	gizmo.clear()
	
	var node = gizmo.get_node_3d()
	if not node is ResizableNode3D:
		return
	
	var resizable_node = node as ResizableNode3D
	var size = resizable_node.size
	
	var handles = PackedVector3Array()
	var handle_ids = PackedInt32Array()
	
	var all_handles = [
		Vector3(size.x/2, 0, 0),
		Vector3(-size.x/2, 0, 0),
		Vector3(0, size.y/2, 0),
		Vector3(0, -size.y/2, 0),
		Vector3(0, 0, size.z/2),
		Vector3(0, 0, -size.z/2)
	]
	
	for i in range(all_handles.size()):
		handles.append(all_handles[i])
		handle_ids.append(i)
	
	if handles.size() > 0:
		gizmo.add_handles(handles, get_material("handles", gizmo), handle_ids)

func _get_handle_name(gizmo: EditorNode3DGizmo, handle_id: int, secondary: bool):
	var names = ["Size +X", "Size -X", "Size +Y", "Size -Y", "Size +Z", "Size -Z"]
	if handle_id >= 0 and handle_id < names.size():
		return names[handle_id]
	return ""

func _begin_handle_action(gizmo: EditorNode3DGizmo, handle_id: int, secondary: bool):
	var node = gizmo.get_node_3d()
	if not node is ResizableNode3D:
		return
	
	var resizable_node = node as ResizableNode3D
	
	_initial_state = {
		"size": resizable_node.size,
		"position": node.position,
		"transform": node.transform
	}

func _get_handle_value(gizmo: EditorNode3DGizmo, handle_id: int, secondary: bool):
	var node = gizmo.get_node_3d()
	if not node is ResizableNode3D:
		return 0.0
	
	var resizable_node = node as ResizableNode3D
	var axis_index = int(handle_id / 2)
	
	return resizable_node.size[axis_index]

func _set_handle(gizmo: EditorNode3DGizmo, handle_id: int, secondary: bool, camera: Camera3D, point: Vector2):
	var node = gizmo.get_node_3d()
	if not node is ResizableNode3D:
		return
	
	var resizable_node = node as ResizableNode3D
	
	var axis_index = int(handle_id / 2)
	var is_positive = (handle_id % 2) == 0
	
	var parent_transform = node.get_parent_node_3d().global_transform if node.get_parent_node_3d() else Transform3D.IDENTITY
	var initial_global_transform = parent_transform * _initial_state["transform"]
	var initial_size = _initial_state["size"]
	
	# Calculate the fixed edge (the one that shouldn't move)
	var fixed_edge_local = Vector3.ZERO
	fixed_edge_local[axis_index] = initial_size[axis_index] / 2.0 * (-1 if is_positive else 1)
	var fixed_edge_global = initial_global_transform * fixed_edge_local
	
	var axis_local = Vector3.ZERO
	axis_local[axis_index] = 1.0
	var axis_global = (initial_global_transform.basis * axis_local).normalized()
	
	var ray_from = camera.project_ray_origin(point)
	var ray_dir = camera.project_ray_normal(point)
	
	# Find closest point between mouse ray and resize axis
	var v1 = axis_global
	var v2 = ray_dir
	var v3 = fixed_edge_global - ray_from
	
	var dot11 = v1.dot(v1)
	var dot12 = v1.dot(v2)
	var dot13 = v1.dot(v3)
	var dot22 = v2.dot(v2)
	var dot23 = v2.dot(v3)
	
	var denom = dot11 * dot22 - dot12 * dot12
	if abs(denom) < 0.0001:
		return
	
	var t1 = (dot12 * dot23 - dot22 * dot13) / denom
	var distance_along_axis = t1
	
	var new_size = initial_size
	new_size[axis_index] = abs(distance_along_axis)
	
	new_size[axis_index] = max(new_size[axis_index], resizable_node.size_min[axis_index])
	
	var actual_distance = new_size[axis_index] * (1 if distance_along_axis >= 0 else -1)
	var center_global = fixed_edge_global + axis_global * (actual_distance / 2.0)
	var new_position = parent_transform.affine_inverse() * center_global
	
	node.position = new_position
	resizable_node.size = new_size

func _commit_handle(gizmo: EditorNode3DGizmo, handle_id: int, secondary: bool, restore, cancel: bool):
	var node = gizmo.get_node_3d()
	if not node is ResizableNode3D:
		return
	
	var resizable_node = node as ResizableNode3D
	
	if cancel:
		resizable_node.size = _initial_state["size"]
		node.position = _initial_state["position"]
	else:
		var undo_redo = EditorInterface.get_editor_undo_redo()
		undo_redo.create_action("Resize Conveyor")
		undo_redo.add_do_property(resizable_node, "size", resizable_node.size)
		undo_redo.add_do_property(node, "position", node.position)
		undo_redo.add_undo_property(resizable_node, "size", _initial_state["size"])
		undo_redo.add_undo_property(node, "position", _initial_state["position"])
		undo_redo.commit_action()
	
	_initial_state.clear()
