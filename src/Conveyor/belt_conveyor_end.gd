@tool
class_name BeltConveyorEnd
extends ResizableNode3D

## Conveyor speed in meters per second.
## Negative values will reverse the direction of the conveyor.
@export var speed: float = 2:
	set(value):
		speed = value
		_update_belt_material_scale()
		_update_belt_material_position()
		_update_belt_velocity()

var belt_position: float = 0.0
var running: bool = false
var static_body: StaticBody3D
var mesh: MeshInstance3D
var belt_material: ShaderMaterial
var metal_material: ShaderMaterial


static func _get_constrained_size(new_size: Vector3) -> Vector3:
	var height := new_size.y
	new_size.x = height / 2.0
	return new_size


func _init() -> void:
	SIZE_MIN = Vector3(0.01, 0.02, 0.01)


func _on_instantiated():
	_setup_references()
	_setup_materials()
	_on_size_changed()


func _enter_tree() -> void:
	SimulationEvents.simulation_started.connect(_on_simulation_started)
	SimulationEvents.simulation_ended.connect(_on_simulation_ended)


func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	SimulationEvents.simulation_ended.disconnect(_on_simulation_ended)


func _ready() -> void:
	pass


func _physics_process(delta: float) -> void:
	if SimulationEvents.simulation_running:
		if not SimulationEvents.simulation_paused:
			belt_position += speed * delta
		if belt_position >= 1.0:
			belt_position = 0.0
		_update_belt_material_position()


func _on_simulation_started() -> void:
	_update_belt_velocity()


func _on_simulation_ended() -> void:
	belt_position = 0.0
	_update_belt_material_position()
	_update_belt_velocity()


func _setup_references() -> void:
	static_body = get_node("StaticBody3D") as StaticBody3D
	mesh = get_node("MeshInstance3D") as MeshInstance3D
	belt_material = mesh.mesh.surface_get_material(0) as ShaderMaterial
	metal_material = mesh.mesh.surface_get_material(1) as ShaderMaterial


func _setup_materials() -> void:
	belt_material = mesh.mesh.surface_get_material(0).duplicate() as ShaderMaterial
	metal_material = mesh.mesh.surface_get_material(1).duplicate() as ShaderMaterial
	mesh.set_surface_override_material(0, belt_material)
	mesh.set_surface_override_material(1, metal_material)


func fix_material_overrides() -> void:
	# This is necessary because the editor's duplication action will overwrite our materials after we've initialized them.
	if mesh.get_surface_override_material(0) != belt_material:
		mesh.set_surface_override_material(0, belt_material)
	if mesh.get_surface_override_material(1) != metal_material:
		mesh.set_surface_override_material(1, metal_material)


func _update_belt_material_scale() -> void:
	var y = size.y
	var BASE_RADIUS: float = clamp(round((y - 0.01) * 100.0) / 100.0, 0.01, 0.25)
	var BASE_BELT_LENGTH: float = PI * BASE_RADIUS

	var radius: float = size.x
	var belt_length: float = PI * radius
	var belt_scale: float = belt_length / BASE_BELT_LENGTH

	if belt_material and speed != 0:
		# Apply scaled UV scrolling to curved part of the conveyor end
		belt_material.set_shader_parameter("Scale", belt_scale * sign(speed))
		fix_material_overrides()


func _update_metal_material_scale() -> void:
	if metal_material:
		(metal_material as ShaderMaterial).set_shader_parameter("Scale", mesh.scale.x)
		(metal_material as ShaderMaterial).set_shader_parameter("Scale2", mesh.scale.y)
		fix_material_overrides()


func _update_belt_material_position() -> void:
	if belt_material:
		(belt_material as ShaderMaterial).set_shader_parameter("BeltPosition", belt_position * sign(-speed))
		fix_material_overrides()


func _on_size_changed():
	if not (get_node_or_null("MeshInstance3D") and get_node_and_resource("StaticBody3D/CollisionShape3D:shape")[1]):
		# Children not instantiated yet.
		# Do nothing and wait to get called again later.
		return
	var mesh_base_size := Vector3(0.25, 0.5, 2)
	$MeshInstance3D.scale = size / mesh_base_size
	var cylinder := $StaticBody3D/CollisionShape3D.shape as CylinderShape3D
	cylinder.height = size.z
	cylinder.radius = size.x

	_update_belt_material_scale()
	_update_metal_material_scale()
	_update_belt_velocity()


func _update_belt_velocity():
	if SimulationEvents.simulation_running:
		var local_front: Vector3 = global_transform.basis.z.normalized()
		var radius: float = size.x
		var new_velocity: Vector3 = local_front * speed / radius
		if static_body.constant_angular_velocity != new_velocity:
			static_body.constant_angular_velocity = new_velocity
	else:
		static_body.constant_angular_velocity = Vector3.ZERO
