@tool
class_name DockDoor
extends Node3D

## Width of the wall segment this door fills (matches `Building.SECTION_SIZE`).
@export var segment_width: float = 10.0:
	set(value):
		segment_width = value
		_rebuild()

## Height of the wall segment (matches `Building.FULL_WALL_HEIGHT`).
@export var segment_height: float = 12.0:
	set(value):
		segment_height = value
		_rebuild()

## Number of door openings spread across the segment.
@export_range(1, 2) var door_count: int = 1:
	set(value):
		door_count = value
		notify_property_list_changed()
		_rebuild()

## Depth of the surround walls.
@export var wall_thickness: float = 0.3:
	set(value):
		wall_thickness = value
		_rebuild()

## Width of each door aperture.
@export var opening_width: float = 4.0:
	set(value):
		opening_width = value
		_rebuild()

## Height of each door aperture, measured up from the floor.
@export var opening_height: float = 4.5:
	set(value):
		opening_height = value
		_rebuild()

## How many horizontal slats each sectional curtain is split into (visual only).
@export_range(1, 20) var slat_count: int = 6:
	set(value):
		slat_count = value
		_rebuild()

## Travel speed of the curtains in meters per second.
@export var open_speed: float = 4.0

## Open/close the first (left) door. Animates live in the editor and at runtime.
@export var door_1_open: bool = false:
	set(value):
		door_1_open = value
		_set_leaf_open(0, value)

## Open/close the second (right) door. Only used when [member door_count] is 2.
@export var door_2_open: bool = false:
	set(value):
		door_2_open = value
		_set_leaf_open(1, value)

## Surround (frame) appearance.
@export var wall_material: Material:
	set(value):
		wall_material = value
		_rebuild()

## Door panel appearance.
@export var door_material: Material:
	set(value):
		door_material = value
		_rebuild()

const _MIN_COLUMN := 0.3

var _leaves: Array[DockDoorLeaf] = []
var _render_layers: int = 2


func _ready() -> void:
	_rebuild()


func _validate_property(property: Dictionary) -> void:
	if property.name == "door_2_open" and door_count < 2:
		property.usage &= ~PROPERTY_USAGE_EDITOR


func set_render_layer(layers: int) -> void:
	_render_layers = layers
	for mesh in find_children("*", "MeshInstance3D", true):
		(mesh as MeshInstance3D).layers = layers


func _set_leaf_open(index: int, value: bool) -> void:
	if index < _leaves.size() and _leaves[index]:
		_leaves[index].open = value


func _rebuild() -> void:
	if not is_node_ready():
		return

	for child in get_children():
		remove_child(child)
		child.queue_free()
	_leaves.clear()

	var wall_mat := wall_material if wall_material else _default_wall_material()
	var door_mat := door_material if door_material else _default_door_material()
	var groove_mat := _groove_material()

	var w := segment_width
	var h := segment_height
	var t := wall_thickness
	var n := clampi(door_count, 1, 2)

	var ow := minf(opening_width, (w - (n + 1) * _MIN_COLUMN) / float(n))
	var col := (w - n * ow) / float(n + 1)
	var oh := minf(opening_height, h)

	var surround := StaticBody3D.new()
	surround.name = "Surround"
	surround.collision_layer = 1
	surround.collision_mask = 0
	add_child(surround)

	for j in range(n + 1):
		var cx := j * (ow + col) + col * 0.5
		_add_box(surround, "Column%d" % j, Vector3(col, h, t), Vector3(cx, h * 0.5, t * 0.5), wall_mat)

	for i in range(n):
		var opening_cx := col * (i + 1) + ow * i + ow * 0.5
		_add_box(surround, "Header%d" % i, Vector3(ow, h - oh, t), Vector3(opening_cx, (oh + h) * 0.5, t * 0.5), wall_mat)

		var leaf := DockDoorLeaf.new()
		leaf.name = "Door%d" % (i + 1)
		leaf.opening_width = ow
		leaf.opening_height = oh
		leaf.wall_thickness = t
		leaf.slat_count = slat_count
		leaf.open_speed = open_speed
		leaf.door_material = door_mat
		leaf.groove_material = groove_mat
		leaf.open = door_2_open if i == 1 else door_1_open
		leaf.position = Vector3(opening_cx, 0.0, 0.0)
		add_child(leaf)
		leaf.build()
		_leaves.append(leaf)

	set_render_layer(_render_layers)


func _add_box(parent: Node, p_name: String, size: Vector3, center: Vector3, material: Material) -> void:
	var mesh := MeshInstance3D.new()
	mesh.name = p_name
	var box := BoxMesh.new()
	box.size = size
	box.material = material
	mesh.mesh = box
	mesh.position = center
	mesh.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	parent.add_child(mesh)

	if parent is CollisionObject3D:
		var shape := CollisionShape3D.new()
		var box_shape := BoxShape3D.new()
		box_shape.size = size
		shape.shape = box_shape
		shape.position = center
		parent.add_child(shape)


func _default_wall_material() -> StandardMaterial3D:
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(0.62, 0.63, 0.66)
	mat.roughness = 0.9
	return mat


func _default_door_material() -> StandardMaterial3D:
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(0.78, 0.79, 0.82)
	mat.metallic = 0.4
	mat.roughness = 0.55
	return mat


func _groove_material() -> StandardMaterial3D:
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(0.32, 0.33, 0.35)
	mat.roughness = 0.8
	return mat
