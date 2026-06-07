@tool
class_name DockDoorLeaf
extends Node3D

const _INTERACT_LAYER := 2

var opening_width: float = 4.0
var opening_height: float = 4.5
var wall_thickness: float = 0.3
var slat_count: int = 6
var open_speed: float = 4.0
var door_material: Material
var groove_material: Material

var open: bool = false:
	set(value):
		open = value
		_target_y = opening_height if value else 0.0

var _panel: AnimatableBody3D
var _target_y: float = 0.0


func build() -> void:
	for child in get_children():
		remove_child(child)
		child.queue_free()

	var ow := opening_width
	var oh := opening_height
	var t := wall_thickness
	# Curtain sits proud of the interior wall face (+z) so it stacks in front of the
	# header when raised instead of vanishing into it.
	var panel_depth := t * 0.6
	var panel_z := t + panel_depth * 0.5

	_panel = AnimatableBody3D.new()
	_panel.name = "Panel"
	_panel.sync_to_physics = false
	_panel.collision_layer = 1 << 0
	_panel.collision_mask = 0
	add_child(_panel)
	_add_box(_panel, "Leaf", Vector3(ow * 0.98, oh, panel_depth), Vector3(0.0, oh * 0.5, panel_z), door_material)

	var slat_h := oh / float(slat_count)
	for i in range(1, slat_count):
		_add_box(
			_panel, "Slat%d" % i,
			Vector3(ow * 0.98, 0.06, panel_depth + 0.02),
			Vector3(0.0, i * slat_h, panel_z),
			groove_material,
		)

	# Fixed interact target (layer 2, no blocking) so aiming stays at the doorway
	# whether the curtain is up or down.
	var interact := StaticBody3D.new()
	interact.name = "Interact"
	interact.collision_layer = 1 << (_INTERACT_LAYER - 1)
	interact.collision_mask = 0
	add_child(interact)
	var interact_shape := CollisionShape3D.new()
	var interact_box := BoxShape3D.new()
	interact_box.size = Vector3(ow * 0.98, oh, panel_depth)
	interact_shape.shape = interact_box
	interact_shape.position = Vector3(0.0, oh * 0.5, panel_z)
	interact.add_child(interact_shape)

	_target_y = oh if open else 0.0
	_panel.position.y = _target_y
	set_process(true)


func use() -> void:
	open = not open


func _process(delta: float) -> void:
	if _panel == null:
		return
	var current := _panel.position.y
	if is_equal_approx(current, _target_y):
		return
	_panel.position.y = move_toward(current, _target_y, open_speed * delta)


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

	var shape := CollisionShape3D.new()
	var box_shape := BoxShape3D.new()
	box_shape.size = size
	shape.shape = box_shape
	shape.position = center
	parent.add_child(shape)
