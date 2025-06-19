@tool
extends EditorNode3DGizmoPlugin

const HANDLE_SIZE = 0.1
const HANDLE_COLOR = Color(1, 0.5, 0, 1)
const HANDLE_COLOR_HOVER = Color(1, 0.8, 0, 1)

# Store initial values when dragging starts
var _drag_initial_size: Vector3
var _drag_initial_position: Vector3
var _drag_initial_transform: Transform3D
var _is_dragging: bool = false

func _get_gizmo_name():
	return "ConveyorGizmo"

func _has_gizmo(node):
	# Only show gizmo for main conveyor nodes, not their children
	if not node is ResizableNode3D:
		return false
	
	# Check if this is a main conveyor type (not a child component)
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

func _redraw(gizmo: EditorNode3DGizmo, exclude_axis: int = -1):
	gizmo.clear()
	
	var node = gizmo.get_node_3d()
	if not node is ResizableNode3D:
		return
	
	var resizable_node = node as ResizableNode3D
	var size = resizable_node.size
	
	# Create handles for resizing - one on each face of the box
	var handles = PackedVector3Array()
	var handle_ids = PackedInt32Array()
	
	# All possible handles
	var all_handles = [
		Vector3(size.x/2, 0, 0),   # 0: Right (+X)
		Vector3(-size.x/2, 0, 0),  # 1: Left (-X)
		Vector3(0, size.y/2, 0),   # 2: Top (+Y)
		Vector3(0, -size.y/2, 0),  # 3: Bottom (-Y)
		Vector3(0, 0, size.z/2),   # 4: Front (+Z)
		Vector3(0, 0, -size.z/2)   # 5: Back (-Z)
	]
	
	# Add handles, excluding the axis being dragged
	for i in range(all_handles.size()):
		var axis_index = int(i / 2)  # 0 for X, 1 for Y, 2 for Z
		if axis_index != exclude_axis:
			handles.append(all_handles[i])
			handle_ids.append(i)
	
	if handles.size() > 0:
		gizmo.add_handles(handles, get_material("handles", gizmo), handle_ids)

func _get_handle_name(gizmo: EditorNode3DGizmo, handle_id: int, secondary: bool):
	var names = ["Right (+X)", "Left (-X)", "Top (+Y)", "Bottom (-Y)", "Front (+Z)", "Back (-Z)"]
	if handle_id >= 0 and handle_id < names.size():
		return names[handle_id]
	return ""

func _get_handle_value(gizmo: EditorNode3DGizmo, handle_id: int, secondary: bool):
	var node = gizmo.get_node_3d()
	if not node is ResizableNode3D:
		return null
	
	var resizable_node = node as ResizableNode3D
	# Store initial values when dragging starts
	_drag_initial_size = resizable_node.size
	_drag_initial_position = node.position
	_drag_initial_transform = node.transform
	_is_dragging = true
	return {"size": resizable_node.size, "position": node.position}

func _set_handle(gizmo: EditorNode3DGizmo, handle_id: int, secondary: bool, camera: Camera3D, point: Vector2):
	var node = gizmo.get_node_3d()
	if not node is ResizableNode3D or not _is_dragging:
		return
	
	var resizable_node = node as ResizableNode3D
	
	# Determine which axis and direction we're resizing
	var axis_index = int(handle_id / 2)  # 0 for X, 1 for Y, 2 for Z
	var is_positive = (handle_id % 2) == 0  # Even handles are positive
	
	# Get parent transform for coordinate conversion
	var parent_transform = node.get_parent_node_3d().global_transform if node.get_parent_node_3d() else Transform3D.IDENTITY
	var initial_global_transform = parent_transform * _drag_initial_transform
	
	# Calculate the fixed edge (the one that shouldn't move)
	var fixed_edge_local = Vector3.ZERO
	fixed_edge_local[axis_index] = _drag_initial_size[axis_index] / 2.0 * (-1 if is_positive else 1)
	var fixed_edge_global = initial_global_transform * fixed_edge_local
	
	# Get the resize axis direction in global space
	var axis_local = Vector3.ZERO
	axis_local[axis_index] = 1.0
	var axis_global = (initial_global_transform.basis * axis_local).normalized()
	
	# Cast mouse ray
	var ray_from = camera.project_ray_origin(point)
	var ray_dir = camera.project_ray_normal(point)
	
	# Use a much simpler approach: project mouse into world space at the depth of the fixed edge
	var depth = camera.global_transform.origin.distance_to(fixed_edge_global)
	var world_position = camera.project_position(point, depth)
	
	# Project this position onto the resize axis
	var to_cursor = world_position - fixed_edge_global
	var distance_along_axis = to_cursor.dot(axis_global)
	
	# Calculate new size
	var new_size = _drag_initial_size
	new_size[axis_index] = abs(distance_along_axis)
	
	# Apply constraints
	new_size[axis_index] = max(new_size[axis_index], resizable_node.size_min[axis_index])
	
	# Calculate new position
	var actual_distance = new_size[axis_index] * (1 if distance_along_axis >= 0 else -1)
	var center_global = fixed_edge_global + axis_global * (actual_distance / 2.0)
	var new_position = parent_transform.affine_inverse() * center_global
	
	# Update both properties
	node.position = new_position
	resizable_node.size = new_size
	
	# Update handle positions for non-dragged axes only
	var exclude_axis = int(handle_id / 2)
	_redraw(gizmo, exclude_axis)

func _commit_handle(gizmo: EditorNode3DGizmo, handle_id: int, secondary: bool, restore, cancel: bool):
	var node = gizmo.get_node_3d()
	if not node is ResizableNode3D:
		return
	
	var resizable_node = node as ResizableNode3D
	
	# Reset dragging state
	_is_dragging = false
	
	if cancel:
		if restore is Dictionary and restore.has("size") and restore.has("position"):
			resizable_node.size = restore["size"]
			node.position = restore["position"]
	else:
		var undo_redo = EditorInterface.get_editor_undo_redo()
		undo_redo.create_action("Resize Conveyor")
		undo_redo.add_do_property(resizable_node, "size", resizable_node.size)
		undo_redo.add_do_property(node, "position", node.position)
		if restore is Dictionary and restore.has("size") and restore.has("position"):
			undo_redo.add_undo_property(resizable_node, "size", restore["size"])
			undo_redo.add_undo_property(node, "position", restore["position"])
		undo_redo.commit_action()
	
	_redraw(gizmo) 
