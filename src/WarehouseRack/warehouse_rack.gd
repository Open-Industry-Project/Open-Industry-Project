@tool
class_name WarehouseRack
extends Node3D

## Warehouse rack system for storing pallets and boxes
## Configurable number of shelves, width, height, and depth

@export_group("Rack Dimensions")
@export_range(1.0, 10.0, 0.1) var width: float = 2.4:
	set(value):
		width = value
		if is_node_ready():
			_rebuild_rack()

@export_range(1.0, 10.0, 0.1) var depth: float = 1.2:
	set(value):
		depth = value
		if is_node_ready():
			_rebuild_rack()

@export_range(1.0, 10.0, 0.1) var shelf_height: float = 1.5:
	set(value):
		shelf_height = value
		if is_node_ready():
			_rebuild_rack()

@export_group("Rack Configuration")
@export_range(1, 10, 1) var num_shelves: int = 4:
	set(value):
		num_shelves = value
		if is_node_ready():
			_rebuild_rack()

@export var shelf_color: Color = Color(0.8, 0.5, 0.2):
	set(value):
		shelf_color = value
		if is_node_ready():
			_rebuild_rack()

@export var frame_color: Color = Color(0.3, 0.3, 0.3):
	set(value):
		frame_color = value
		if is_node_ready():
			_rebuild_rack()

@export_group("Identification")
@export var rack_id: String = "RACK-001":
	set(value):
		rack_id = value

@export_multiline var description: String = "Warehouse storage rack"

@export_group("Placement Guides")
@export var enable_placement_guides: bool = false:
	set(value):
		enable_placement_guides = value
		if is_node_ready():
			_rebuild_rack()

@export_range(0.1, 2.0, 0.1) var placement_interval: float = 0.6:
	set(value):
		placement_interval = value
		if is_node_ready():
			_rebuild_rack()

@export var guide_color: Color = Color(0.5, 0.5, 0.5, 0.5):
	set(value):
		guide_color = value
		if is_node_ready():
			_rebuild_rack()

@export_group("Structural Support")
@export var enable_auto_poles: bool = true:
	set(value):
		enable_auto_poles = value
		if is_node_ready():
			_rebuild_rack()

@export_range(0.5, 3.0, 0.1) var pole_interval: float = 1.2:
	set(value):
		pole_interval = value
		if is_node_ready():
			_rebuild_rack()

const FRAME_THICKNESS = 0.08
const SHELF_THICKNESS = 0.04
const GUIDE_SIZE = 0.05

var _meshes: Array[MeshInstance3D] = []
var _collision_shapes: Array[CollisionShape3D] = []

func _ready() -> void:
	_rebuild_rack()

func _rebuild_rack() -> void:
	if not is_node_ready():
		return
	
	# Clear existing meshes and collision shapes
	for mesh in _meshes:
		if is_instance_valid(mesh):
			mesh.queue_free()
	_meshes.clear()
	
	for collision in _collision_shapes:
		if is_instance_valid(collision):
			collision.queue_free()
	_collision_shapes.clear()
	
	# Create static body if it doesn't exist
	var static_body: StaticBody3D = get_node_or_null("StaticBody3D")
	if not static_body:
		static_body = StaticBody3D.new()
		static_body.name = "StaticBody3D"
		static_body.collision_layer = 1
		static_body.collision_mask = 15
		add_child(static_body)
		static_body.owner = self
	
	# Build the rack structure
	_create_vertical_frames(static_body)
	_create_shelves(static_body)
	_create_horizontal_supports(static_body)
	
	# Add placement guides if enabled
	if enable_placement_guides:
		_create_placement_guides(static_body)

func _create_vertical_frames(parent: StaticBody3D) -> void:
	var total_height = num_shelves * shelf_height
	
	if enable_auto_poles:
		# Create poles at regular intervals for load distribution
		var num_poles_width = int(width / pole_interval) + 1
		var num_poles_depth = int(depth / pole_interval) + 1
		
		for w in range(num_poles_width):
			for d in range(num_poles_depth):
				var x_pos = min(w * pole_interval, width)
				var z_pos = min(d * pole_interval, depth)
				
				# Create vertical pole at this position
				_create_vertical_pole(parent, Vector3(x_pos, 0, z_pos), total_height)
	else:
		# Create only 4 corner posts (original behavior)
		var corners = [
			Vector3(0, 0, 0),
			Vector3(width, 0, 0),
			Vector3(0, 0, depth),
			Vector3(width, 0, depth)
		]
		
		for corner in corners:
			_create_vertical_pole(parent, corner, total_height)

func _create_vertical_pole(parent: StaticBody3D, base_position: Vector3, height: float) -> void:
	# Create a single vertical pole at the specified position
	var mesh_instance = _create_box_mesh(
		base_position + Vector3(0, height / 2, 0),
		Vector3(FRAME_THICKNESS, height, FRAME_THICKNESS),
		frame_color
	)
	parent.add_child(mesh_instance)
	mesh_instance.owner = self
	_meshes.append(mesh_instance)
	
	# Add collision shape for the pole
	var collision = _create_box_collision(
		base_position + Vector3(0, height / 2, 0),
		Vector3(FRAME_THICKNESS, height, FRAME_THICKNESS)
	)
	parent.add_child(collision)
	collision.owner = self
	_collision_shapes.append(collision)

func _create_shelves(parent: StaticBody3D) -> void:
	for i in range(num_shelves):
		var y_pos = i * shelf_height + shelf_height
		
		# Create shelf platform
		var shelf_mesh = _create_box_mesh(
			Vector3(width / 2, y_pos, depth / 2),
			Vector3(width, SHELF_THICKNESS, depth),
			shelf_color
		)
		parent.add_child(shelf_mesh)
		shelf_mesh.owner = self
		_meshes.append(shelf_mesh)
		
		# Add collision shape for shelf
		var collision = _create_box_collision(
			Vector3(width / 2, y_pos, depth / 2),
			Vector3(width, SHELF_THICKNESS, depth)
		)
		parent.add_child(collision)
		collision.owner = self
		_collision_shapes.append(collision)
		
		# Add load distribution beams at pole intervals if auto poles enabled
		if enable_auto_poles:
			_create_load_distribution_beams(parent, y_pos)

func _create_horizontal_supports(parent: StaticBody3D) -> void:
	# Create horizontal supports connecting the vertical frames at each shelf level
	for i in range(num_shelves + 1):
		var y_pos = i * shelf_height
		
		# Front support
		var front_support = _create_box_mesh(
			Vector3(width / 2, y_pos, 0),
			Vector3(width - FRAME_THICKNESS * 2, FRAME_THICKNESS, FRAME_THICKNESS),
			frame_color
		)
		parent.add_child(front_support)
		front_support.owner = self
		_meshes.append(front_support)
		
		# Back support
		var back_support = _create_box_mesh(
			Vector3(width / 2, y_pos, depth),
			Vector3(width - FRAME_THICKNESS * 2, FRAME_THICKNESS, FRAME_THICKNESS),
			frame_color
		)
		parent.add_child(back_support)
		back_support.owner = self
		_meshes.append(back_support)

func _create_load_distribution_beams(parent: StaticBody3D, y_pos: float) -> void:
	# Create cross-beams connecting poles at this shelf level for load distribution
	var num_poles_width = int(width / pole_interval) + 1
	var num_poles_depth = int(depth / pole_interval) + 1
	
	# Create beams along width direction
	for d in range(num_poles_depth):
		var z_pos = min(d * pole_interval, depth)
		
		for w in range(num_poles_width - 1):
			var x_start = min(w * pole_interval, width)
			var x_end = min((w + 1) * pole_interval, width)
			var beam_length = x_end - x_start
			var beam_center = x_start + beam_length / 2
			
			# Create horizontal beam
			var beam_mesh = _create_box_mesh(
				Vector3(beam_center, y_pos - SHELF_THICKNESS / 2 - FRAME_THICKNESS / 2, z_pos),
				Vector3(beam_length, FRAME_THICKNESS, FRAME_THICKNESS),
				frame_color
			)
			parent.add_child(beam_mesh)
			beam_mesh.owner = self
			_meshes.append(beam_mesh)
	
	# Create beams along depth direction
	for w in range(num_poles_width):
		var x_pos = min(w * pole_interval, width)
		
		for d in range(num_poles_depth - 1):
			var z_start = min(d * pole_interval, depth)
			var z_end = min((d + 1) * pole_interval, depth)
			var beam_length = z_end - z_start
			var beam_center = z_start + beam_length / 2
			
			# Create horizontal beam
			var beam_mesh = _create_box_mesh(
				Vector3(x_pos, y_pos - SHELF_THICKNESS / 2 - FRAME_THICKNESS / 2, beam_center),
				Vector3(FRAME_THICKNESS, FRAME_THICKNESS, beam_length),
				frame_color
			)
			parent.add_child(beam_mesh)
			beam_mesh.owner = self
			_meshes.append(beam_mesh)

func _create_placement_guides(parent: StaticBody3D) -> void:
	# Create visual guides and collision markers at specific intervals on each shelf
	for shelf_idx in range(num_shelves):
		var y_pos = (shelf_idx + 1) * shelf_height + SHELF_THICKNESS / 2
		
		# Calculate number of guides along width
		var num_guides_width = int(width / placement_interval)
		# Calculate number of guides along depth
		var num_guides_depth = int(depth / placement_interval)
		
		# Create guides at regular intervals
		for w in range(num_guides_width + 1):
			for d in range(num_guides_depth + 1):
				var x_pos = w * placement_interval
				var z_pos = d * placement_interval
				
				# Skip if outside rack bounds
				if x_pos > width or z_pos > depth:
					continue
				
				# Create visual guide marker
				var guide_mesh = _create_box_mesh(
					Vector3(x_pos, y_pos, z_pos),
					Vector3(GUIDE_SIZE, GUIDE_SIZE * 0.5, GUIDE_SIZE),
					guide_color
				)
				parent.add_child(guide_mesh)
				guide_mesh.owner = self
				_meshes.append(guide_mesh)
				
				# Add small collision at guide position for snapping
				var guide_collision = _create_box_collision(
					Vector3(x_pos, y_pos, z_pos),
					Vector3(GUIDE_SIZE, GUIDE_SIZE * 0.5, GUIDE_SIZE)
				)
				parent.add_child(guide_collision)
				guide_collision.owner = self
				_collision_shapes.append(guide_collision)

func _create_box_mesh(position: Vector3, size: Vector3, color: Color) -> MeshInstance3D:
	var mesh_instance = MeshInstance3D.new()
	var box_mesh = BoxMesh.new()
	box_mesh.size = size
	
	var material = StandardMaterial3D.new()
	material.albedo_color = color
	box_mesh.material = material
	
	mesh_instance.mesh = box_mesh
	mesh_instance.position = position
	
	return mesh_instance

func _create_box_collision(position: Vector3, size: Vector3) -> CollisionShape3D:
	var collision = CollisionShape3D.new()
	var shape = BoxShape3D.new()
	shape.size = size
	collision.shape = shape
	collision.position = position
	
	return collision

## Returns the Y position of a specific shelf (0-indexed)
func get_shelf_position(shelf_index: int) -> float:
	if shelf_index < 0 or shelf_index >= num_shelves:
		push_error("Invalid shelf index: %d" % shelf_index)
		return 0.0
	return (shelf_index + 1) * shelf_height

## Returns an array of all shelf Y positions
func get_all_shelf_positions() -> Array[float]:
	var positions: Array[float] = []
	for i in range(num_shelves):
		positions.append(get_shelf_position(i))
	return positions

## Returns the center position of a shelf surface (useful for placing items)
func get_shelf_center(shelf_index: int) -> Vector3:
	var y_pos = get_shelf_position(shelf_index)
	return Vector3(width / 2, y_pos + SHELF_THICKNESS / 2, depth / 2)

## Returns the total height of the rack
func get_total_height() -> float:
	return num_shelves * shelf_height

## Returns all pole positions (base positions at ground level)
func get_pole_positions() -> Array[Vector3]:
	var positions: Array[Vector3] = []
	
	if enable_auto_poles:
		var num_poles_width = int(width / pole_interval) + 1
		var num_poles_depth = int(depth / pole_interval) + 1
		
		for w in range(num_poles_width):
			for d in range(num_poles_depth):
				var x_pos = min(w * pole_interval, width)
				var z_pos = min(d * pole_interval, depth)
				positions.append(Vector3(x_pos, 0, z_pos))
	else:
		# Return only corner positions
		positions.append(Vector3(0, 0, 0))
		positions.append(Vector3(width, 0, 0))
		positions.append(Vector3(0, 0, depth))
		positions.append(Vector3(width, 0, depth))
	
	return positions

## Returns the number of poles in the rack structure
func get_pole_count() -> int:
	if enable_auto_poles:
		var num_poles_width = int(width / pole_interval) + 1
		var num_poles_depth = int(depth / pole_interval) + 1
		return num_poles_width * num_poles_depth
	else:
		return 4  # Only corner posts

## Returns all placement guide positions for a specific shelf
func get_placement_guide_positions(shelf_index: int) -> Array[Vector3]:
	var positions: Array[Vector3] = []
	
	if shelf_index < 0 or shelf_index >= num_shelves:
		push_error("Invalid shelf index: %d" % shelf_index)
		return positions
	
	var y_pos = get_shelf_position(shelf_index) + SHELF_THICKNESS / 2
	
	# Calculate number of guides
	var num_guides_width = int(width / placement_interval)
	var num_guides_depth = int(depth / placement_interval)
	
	# Get all guide positions
	for w in range(num_guides_width + 1):
		for d in range(num_guides_depth + 1):
			var x_pos = w * placement_interval
			var z_pos = d * placement_interval
			
			# Skip if outside rack bounds
			if x_pos > width or z_pos > depth:
				continue
			
			positions.append(Vector3(x_pos, y_pos, z_pos))
	
	return positions

## Returns the nearest placement guide position to a given point on a shelf
func get_nearest_guide_position(shelf_index: int, target_position: Vector3) -> Vector3:
	var guides = get_placement_guide_positions(shelf_index)
	
	if guides.is_empty():
		return get_shelf_center(shelf_index)
	
	var nearest = guides[0]
	var min_distance = target_position.distance_to(nearest)
	
	for guide_pos in guides:
		var distance = target_position.distance_to(guide_pos)
		if distance < min_distance:
			min_distance = distance
			nearest = guide_pos
	
	return nearest
