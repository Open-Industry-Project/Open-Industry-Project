@tool
class_name CollisionManager
extends Node3D

## A tool script that calculates the bounds of all BeltConveyorArea3D nodes
## and creates a single continuous static body that overlaps exactly with all conveyors.

@export var auto_update: bool = false:
	set(value):
		auto_update = value
		if auto_update:
			_update_collision()

@export var static_body: StaticBody3D
@export var collision_margin: float = 0.01

var _conveyor_nodes: Array[BeltConveyorArea3D] = []

func _ready() -> void:
	if Engine.is_editor_hint():
		_setup_static_body()

func _setup_static_body() -> void:
	if not static_body:
		static_body = StaticBody3D.new()
		static_body.name = "ConveyorStaticBody"
		add_child(static_body)
		static_body.owner = get_tree().edited_scene_root

## Finds all BeltConveyorArea3D nodes in the scene and updates the collision
@export var update_collision: bool = false:
	set(value):
		if value and Engine.is_editor_hint():
			_update_collision()

func _update_collision() -> void:
	_find_conveyor_nodes()
	_create_continuous_collision()

func _find_conveyor_nodes() -> void:
	_conveyor_nodes.clear()
	var root = get_tree().edited_scene_root if Engine.is_editor_hint() else get_tree().current_scene
	if not root:
		return
	
	_search_for_conveyors(root)
	print("Found %d BeltConveyorArea3D nodes" % _conveyor_nodes.size())

func _search_for_conveyors(node: Node) -> void:
	if node is BeltConveyorArea3D:
		_conveyor_nodes.append(node as BeltConveyorArea3D)
	
	for child in node.get_children():
		_search_for_conveyors(child)

func _create_continuous_collision() -> void:
	if not static_body:
		_setup_static_body()
	
	# Clear existing collision shapes
	for child in static_body.get_children():
		if child is CollisionShape3D:
			child.queue_free()
	
	if _conveyor_nodes.is_empty():
		print("No conveyor nodes found to create collision for")
		return
	
	# Group connected conveyors and create merged collision shapes
	var conveyor_groups = _group_connected_conveyors()
	
	for i in range(conveyor_groups.size()):
		var group = conveyor_groups[i]
		_create_merged_collision_for_group(group, i)
	
	print("Created %d merged collision shapes for %d conveyors" % [conveyor_groups.size(), _conveyor_nodes.size()])

func _group_connected_conveyors() -> Array[Array]:
	"""Groups conveyors that are connected/adjacent into continuous segments"""
	var groups: Array[Array] = []
	var processed: Array[BeltConveyorArea3D] = []
	
	for conveyor in _conveyor_nodes:
		if conveyor in processed:
			continue
		
		var group: Array[BeltConveyorArea3D] = []
		_find_connected_conveyors(conveyor, group, processed)
		groups.append(group)
	
	return groups

func _find_connected_conveyors(conveyor: BeltConveyorArea3D, group: Array[BeltConveyorArea3D], processed: Array[BeltConveyorArea3D]) -> void:
	"""Recursively finds all conveyors connected to the given conveyor"""
	if conveyor in processed:
		return
	
	group.append(conveyor)
	processed.append(conveyor)
	
	# Find adjacent conveyors
	for other_conveyor in _conveyor_nodes:
		if other_conveyor in processed:
			continue
		
		if _are_conveyors_connected(conveyor, other_conveyor):
			_find_connected_conveyors(other_conveyor, group, processed)

func _are_conveyors_connected(conv1: BeltConveyorArea3D, conv2: BeltConveyorArea3D) -> bool:
	"""Determines if two conveyors are connected/adjacent"""
	var pos1 = conv1.global_position
	var pos2 = conv2.global_position
	var size1 = conv1.size
	var size2 = conv2.size
	
	# Check if conveyors are aligned on the same horizontal plane (similar Y positions)
	var y_tolerance = max(size1.y, size2.y) * 0.1
	if abs(pos1.y - pos2.y) > y_tolerance:
		return false
	
	# Check if conveyors are aligned in the same direction (X or Z axis)
	var x_distance = abs(pos1.x - pos2.x)
	var z_distance = abs(pos1.z - pos2.z)
	
	# Connection tolerance - conveyors are connected if their edges touch within this margin
	var connection_tolerance = 0.05
	
	# Check X-axis alignment (conveyors arranged along X-axis)
	if z_distance <= max(size1.z, size2.z) * 0.6: # Width alignment tolerance
		var gap_distance = x_distance - (size1.x + size2.x) * 0.5
		return gap_distance <= connection_tolerance
	
	# Check Z-axis alignment (conveyors arranged along Z-axis)  
	if x_distance <= max(size1.x, size2.x) * 0.6: # Length alignment tolerance
		var gap_distance = z_distance - (size1.z + size2.z) * 0.5
		return gap_distance <= connection_tolerance
	
	return false

func _create_merged_collision_for_group(group: Array[BeltConveyorArea3D], group_index: int) -> void:
	"""Creates a single merged collision shape for a group of connected conveyors"""
	if group.is_empty():
		return
	
	# If only one conveyor in group, create individual collision
	if group.size() == 1:
		_create_collision_for_conveyor(group[0])
		return
	
	# Calculate the bounding box that encompasses all conveyors in the group
	var merged_bounds = _calculate_group_bounds(group)
	
	# Create a single collision shape for the entire group
	var collision_shape = CollisionShape3D.new()
	var box_shape = BoxShape3D.new()
	
	box_shape.size = merged_bounds.size
	collision_shape.shape = box_shape
	
	# Position the collision shape
	var world_center = merged_bounds.get_center()
	var relative_position = static_body.global_transform.inverse() * world_center
	collision_shape.position = relative_position
	
	# Add to static body
	static_body.add_child(collision_shape)
	collision_shape.owner = get_tree().edited_scene_root if Engine.is_editor_hint() else null
	collision_shape.name = "MergedConveyorCollision_Group%d" % group_index

func _calculate_group_bounds(group: Array[BeltConveyorArea3D]) -> AABB:
	"""Calculates the combined AABB for a group of connected conveyors"""
	var bounds = AABB()
	var first = true
	
	for conveyor in group:
		var conveyor_bounds = AABB()
		conveyor_bounds.position = conveyor.global_position - conveyor.size / 2.0
		conveyor_bounds.size = conveyor.size
		
		# Adjust for conveyor positioning (top surface at y=0)
		conveyor_bounds.position.y -= conveyor.size.y / 2.0
		
		if first:
			bounds = conveyor_bounds
			first = false
		else:
			bounds = bounds.merge(conveyor_bounds)
	
	return bounds

func _create_collision_for_conveyor(conveyor: BeltConveyorArea3D) -> void:
	# Get the conveyor's world transform and size
	var conveyor_transform = conveyor.global_transform
	var conveyor_size = conveyor.size
	
	# Create a collision shape
	var collision_shape = CollisionShape3D.new()
	var box_shape = BoxShape3D.new()
	
	# Set the box shape size to match the conveyor
	# Adding small margin to ensure perfect overlap
	box_shape.size = conveyor_size + Vector3.ONE * collision_margin
	collision_shape.shape = box_shape
	
	# Position the collision shape relative to the static body
	var relative_transform = static_body.global_transform.inverse() * conveyor_transform
	collision_shape.transform = relative_transform
	
	# Adjust position to account for conveyor's positioning
	# BeltConveyorArea3D positions its collision with the top surface at y=0
	collision_shape.position.y -= conveyor_size.y / 2.0
	
	# Add the collision shape to the static body
	static_body.add_child(collision_shape)
	collision_shape.owner = get_tree().edited_scene_root if Engine.is_editor_hint() else null
	collision_shape.name = "ConveyorCollision_" + conveyor.name

func get_conveyor_bounds() -> AABB:
	"""Returns the combined AABB of all conveyor nodes in world space"""
	if _conveyor_nodes.is_empty():
		return AABB()
	
	var combined_bounds = AABB()
	var first = true
	
	for conveyor in _conveyor_nodes:
		var conveyor_aabb = AABB()
		conveyor_aabb.position = conveyor.global_position - conveyor.size / 2.0
		conveyor_aabb.size = conveyor.size
		
		# Adjust for conveyor positioning (top surface at y=0)
		conveyor_aabb.position.y -= conveyor.size.y / 2.0
		
		if first:
			combined_bounds = conveyor_aabb
			first = false
		else:
			combined_bounds = combined_bounds.merge(conveyor_aabb)
	
	return combined_bounds

## Helper function to get all conveyor positions and sizes for debugging
func get_conveyor_info() -> Array[Dictionary]:
	var info: Array[Dictionary] = []
	for conveyor in _conveyor_nodes:
		info.append({
			"name": conveyor.name,
			"position": conveyor.global_position,
			"size": conveyor.size,
			"transform": conveyor.global_transform
		})
	return info

## Removes all collision shapes from the static body
func clear_collision() -> void:
	if not static_body:
		return
	
	for child in static_body.get_children():
		if child is CollisionShape3D:
			child.queue_free()
	
	print("Cleared all collision shapes")

## Returns the number of conveyor nodes found in the last update
func get_conveyor_count() -> int:
	return _conveyor_nodes.size()

## Returns true if the collision manager has been set up properly
func is_ready() -> bool:
	return static_body != null and not _conveyor_nodes.is_empty()

## Debug function to print conveyor grouping information
func debug_conveyor_groups() -> void:
	if _conveyor_nodes.is_empty():
		print("No conveyors found")
		return
	
	var groups = _group_connected_conveyors()
	print("=== Conveyor Grouping Debug ===")
	print("Total conveyors: %d" % _conveyor_nodes.size())
	print("Groups found: %d" % groups.size())
	
	for i in range(groups.size()):
		var group = groups[i]
		print("Group %d (%d conveyors):" % [i, group.size()])
		for conveyor in group:
			print("  - %s at %s (size: %s)" % [conveyor.name, conveyor.global_position, conveyor.size])
	print("===============================")

func _validate_property(property: Dictionary) -> void:
	if property.name == "update_collision":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE 
