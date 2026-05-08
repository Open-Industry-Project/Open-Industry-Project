@tool
class_name SideGuard
extends MeshInstance3D

@export_custom(PROPERTY_HINT_NONE, "suffix:m") var length: float = 1.0:
	set(value):
		if is_equal_approx(length, value):
			return
		length = value
		_rebuild()

## False once the user has manually adjusted the +X edge.
@export_storage var front_anchored: bool = true

@export_storage var back_anchored: bool = true

@export_storage var front_boundary_tracking: bool = false

@export_storage var back_boundary_tracking: bool = false

## Arc value at the -X edge; matches `BeltConveyor.side_guard_openings`.
@export_storage var arc_back: float = 0.0

@export_storage var arc_front: float = 0.0


func _ready() -> void:
	_rebuild()


func _exit_tree() -> void:
	SensorBeamCache.unregister_instance(self)


func _rebuild() -> void:
	if length <= 0 or not is_inside_tree():
		return
	mesh = SideGuardMesh.create(length)
	set_surface_override_material(0, SideGuardMesh.create_material())
	set_instance_shader_parameter("Scale", 1.0)
	_update_collision_shape()
	SensorBeamCache.register_instance(self)


func get_metal_material() -> ShaderMaterial:
	return get_surface_override_material(0) as ShaderMaterial


func _update_collision_shape() -> void:
	if length <= 0:
		return
	var body := get_node_or_null("StaticBody3D") as StaticBody3D
	if body == null:
		body = StaticBody3D.new()
		body.name = "StaticBody3D"
		# mask=8 sees cargo; ghost filtering blocks tunneling; friction=0 so cargo slides.
		body.disable_mode = StaticBody3D.DISABLE_MODE_MAKE_STATIC
		body.collision_mask = 8
		body.ghost_collision_filtering_enabled = true
		var phys := PhysicsMaterial.new()
		phys.friction = 0.0
		body.physics_material_override = phys
		add_child(body, false, Node.INTERNAL_MODE_FRONT)
	var collision := body.get_node_or_null("CollisionShape3D") as CollisionShape3D
	if collision == null:
		collision = CollisionShape3D.new()
		collision.name = "CollisionShape3D"
		body.add_child(collision)

	var box := collision.shape as BoxShape3D
	if box == null:
		box = BoxShape3D.new()
		collision.shape = box
	var wh := SideGuardMesh.WALL_HEIGHT
	var wt := SideGuardMesh.WALL_THICKNESS
	# Thick collision centered on the visual wall — inward overhang catches edge cargo.
	var ct := SideGuardMesh.COLLISION_THICKNESS
	box.size = Vector3(length, wh, ct)
	collision.position = Vector3(0, wh / 2.0, wt / 2.0)
