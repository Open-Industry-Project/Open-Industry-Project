@tool
class_name Rack
extends ResizableNode3D

## Storage rack. Size: X = width, Y = total height, Z = depth.
## Bottom level is left open for forklift access.

var width: float:
	get: return size.x
var depth: float:
	get: return size.z
var shelf_height: float:
	get: return size.y / num_shelves

@export_group("Rack Configuration")
@export_range(1, 10, 1) var num_shelves: int = 4:
	set(value):
		var old_shelf_h := shelf_height
		num_shelves = value
		if is_node_ready():
			size = Vector3(size.x, old_shelf_h * num_shelves, size.z)
			update_gizmos()

@export var shelf_color: Color = Color(0.8, 0.5, 0.2):
	set(value):
		shelf_color = value
		if is_node_ready():
			_update_materials()

@export var frame_color: Color = Color(0.3, 0.3, 0.3):
	set(value):
		frame_color = value
		if is_node_ready():
			_update_materials()

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

var _static_body: StaticBody3D
var _frame_material: StandardMaterial3D
var _shelf_material: StandardMaterial3D
var _frame_mm_inst: MultiMeshInstance3D
var _shelf_meshes: Array[MeshInstance3D] = []
var _collision_shape: CollisionShape3D
var _frame_xforms: Array[Transform3D] = []
var _collision_faces: PackedVector3Array = PackedVector3Array()


func _init() -> void:
	super._init()
	size_default = Vector3(2.4, 6.0, 1.2)
	size_min = Vector3(0.5, 1.0, 0.5)


func _ready() -> void:
	_frame_material = StandardMaterial3D.new()
	_frame_material.albedo_color = frame_color
	_shelf_material = StandardMaterial3D.new()
	_shelf_material.albedo_color = shelf_color
	_rebuild_rack()


func _on_size_changed() -> void:
	_rebuild_rack()


func _update_materials() -> void:
	_frame_material.albedo_color = frame_color
	_shelf_material.albedo_color = shelf_color


func _get_resize_local_bounds(for_size: Vector3) -> AABB:
	return AABB(
		Vector3(-for_size.x / 2, 0, -for_size.z / 2),
		for_size,
	)


func _get_active_resize_handle_ids() -> PackedInt32Array:
	return PackedInt32Array([0, 1, 2, 4, 5])


func _rebuild_rack() -> void:
	if not is_node_ready():
		return

	_ensure_static_body()
	_static_body.position = Vector3(-width / 2, 0, -depth / 2)

	_frame_xforms.clear()
	_collision_faces.clear()

	_create_vertical_frames()
	_create_shelves()
	_create_horizontal_supports()

	_apply_multimesh(_frame_mm_inst, _frame_xforms, _frame_material)

	(_collision_shape.shape as ConcavePolygonShape3D).set_faces(_collision_faces)


func _ensure_static_body() -> void:
	if is_instance_valid(_frame_mm_inst):
		return

	_static_body = get_node_or_null("StaticBody3D") as StaticBody3D
	if _static_body:
		for child in _static_body.get_children():
			child.free()
		_shelf_meshes.clear()
	else:
		_static_body = StaticBody3D.new()
		_static_body.name = "StaticBody3D"
		_static_body.collision_layer = 1
		_static_body.collision_mask = 15
		add_child(_static_body)
		_static_body.owner = self

	var unit_box := BoxMesh.new()
	_frame_mm_inst = MultiMeshInstance3D.new()
	_frame_mm_inst.multimesh = MultiMesh.new()
	_frame_mm_inst.multimesh.transform_format = MultiMesh.TRANSFORM_3D
	_frame_mm_inst.multimesh.mesh = unit_box
	_static_body.add_child(_frame_mm_inst)
	_frame_mm_inst.owner = self

	_collision_shape = CollisionShape3D.new()
	_collision_shape.shape = ConcavePolygonShape3D.new()
	_static_body.add_child(_collision_shape)
	_collision_shape.owner = self


func _apply_multimesh(inst: MultiMeshInstance3D, xforms: Array[Transform3D], material: StandardMaterial3D) -> void:
	inst.material_override = material
	inst.multimesh.instance_count = xforms.size()
	for i in xforms.size():
		inst.multimesh.set_instance_transform(i, xforms[i])


func _get_axis_positions(length: float, interval: float) -> Array[float]:
	var positions: Array[float] = [0.0]
	var pos := interval
	while pos < length - 0.001:
		positions.append(pos)
		pos += interval
	if length > 0.001:
		positions.append(length)
	return positions


func _create_vertical_frames() -> void:
	var total_height := size.y

	if enable_auto_poles:
		var x_positions := _get_axis_positions(width, pole_interval)
		var z_positions := _get_axis_positions(depth, pole_interval)

		for x_pos in x_positions:
			for z_pos in z_positions:
				_add_frame_box(
					Vector3(x_pos, total_height / 2, z_pos),
					Vector3(FRAME_THICKNESS, total_height, FRAME_THICKNESS),
				)
	else:
		for x in [0.0, width]:
			for z in [0.0, depth]:
				_add_frame_box(
					Vector3(x, total_height / 2, z),
					Vector3(FRAME_THICKNESS, total_height, FRAME_THICKNESS),
				)


func _create_shelves() -> void:
	for i in range(num_shelves):
		var y_pos := (i + 1) * shelf_height
		var shelf_size := Vector3(width, SHELF_THICKNESS, depth)

		var mesh_inst: MeshInstance3D
		if i < _shelf_meshes.size():
			mesh_inst = _shelf_meshes[i]
		else:
			mesh_inst = MeshInstance3D.new()
			mesh_inst.mesh = BoxMesh.new()
			_static_body.add_child(mesh_inst)
			mesh_inst.owner = self
			_shelf_meshes.append(mesh_inst)

		(mesh_inst.mesh as BoxMesh).size = shelf_size
		(mesh_inst.mesh as BoxMesh).material = _shelf_material
		mesh_inst.position = Vector3(width / 2, y_pos, depth / 2)

		_add_collision_box(Vector3(width / 2, y_pos, depth / 2), shelf_size)

		if enable_auto_poles:
			_create_load_distribution_beams(y_pos)

	while _shelf_meshes.size() > num_shelves:
		_shelf_meshes.pop_back().free()


func _create_horizontal_supports() -> void:
	for i in range(num_shelves + 1):
		var y_pos := i * shelf_height
		var support_size := Vector3(width - FRAME_THICKNESS * 2, FRAME_THICKNESS, FRAME_THICKNESS)

		_add_frame_box(Vector3(width / 2, y_pos, 0), support_size)
		_add_frame_box(Vector3(width / 2, y_pos, depth), support_size)


func _create_load_distribution_beams(y_pos: float) -> void:
	var x_positions := _get_axis_positions(width, pole_interval)
	var z_positions := _get_axis_positions(depth, pole_interval)
	var beam_y := y_pos - SHELF_THICKNESS / 2 - FRAME_THICKNESS / 2

	for z_pos in z_positions:
		for w in range(x_positions.size() - 1):
			var beam_length := x_positions[w + 1] - x_positions[w]
			_add_frame_box(
				Vector3(x_positions[w] + beam_length / 2, beam_y, z_pos),
				Vector3(beam_length, FRAME_THICKNESS, FRAME_THICKNESS),
			)

	for x_pos in x_positions:
		for d in range(z_positions.size() - 1):
			var beam_length := z_positions[d + 1] - z_positions[d]
			_add_frame_box(
				Vector3(x_pos, beam_y, z_positions[d] + beam_length / 2),
				Vector3(FRAME_THICKNESS, FRAME_THICKNESS, beam_length),
			)


func _add_frame_box(pos: Vector3, box_size: Vector3) -> void:
	_frame_xforms.append(Transform3D(Basis.from_scale(box_size), pos))
	_add_collision_box(pos, box_size)


func _add_collision_box(pos: Vector3, box_size: Vector3) -> void:
	var h := box_size / 2
	var corners := [
		Vector3(-h.x, -h.y, -h.z), Vector3(h.x, -h.y, -h.z),
		Vector3(h.x, -h.y, h.z), Vector3(-h.x, -h.y, h.z),
		Vector3(-h.x, h.y, -h.z), Vector3(h.x, h.y, -h.z),
		Vector3(h.x, h.y, h.z), Vector3(-h.x, h.y, h.z),
	]
	var tris := [
		4,5,6, 4,6,7,
		3,2,1, 3,1,0,
		1,2,6, 1,6,5,
		3,0,4, 3,4,7,
		2,3,7, 2,7,6,
		0,1,5, 0,5,4,
	]
	for idx in tris:
		_collision_faces.append(pos + corners[idx])


func _get_custom_preview_node() -> Node3D:
	var preview_scene := load("res://parts/Rack.tscn") as PackedScene
	var preview_node := preview_scene.instantiate(PackedScene.GEN_EDIT_STATE_DISABLED) as Node3D
	_disable_collisions_recursive(preview_node)
	return preview_node


func _disable_collisions_recursive(node: Node) -> void:
	if node is CollisionShape3D:
		node.disabled = true
	if node is CollisionObject3D:
		node.collision_layer = 0
		node.collision_mask = 0
	for child in node.get_children():
		_disable_collisions_recursive(child)
