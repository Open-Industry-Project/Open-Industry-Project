@tool
class_name BeltConveyorEnd
extends ResizableNode3D

## Conveyor speed in meters per second.
## Negative values will reverse the direction of the conveyor.
@export var speed: float = 2:
	set(value):
		speed = value
		if is_inside_tree():
			_update_belt_material_scale()
			_update_belt_material_position()
			_update_belt_velocity()

@export var disable_collision: bool = false:
	set(value):
		disable_collision = value
		_update_collision_and_visibility()

var _belt_position: float = 0.0
var _belt_material: ShaderMaterial
var _metal_material: ShaderMaterial

@onready var _static_body: StaticBody3D = get_node("StaticBody3D")
@onready var _mesh: MeshInstance3D = get_node("MeshInstance3D")


func _init() -> void:
	super._init() # Call parent _init to inherit hijack_scale metadata
	size_min = Vector3(0.01, 0.02, 0.01)


func _enter_tree() -> void:
	super._enter_tree()
	SimulationEvents.simulation_started.connect(_on_simulation_started)
	SimulationEvents.simulation_ended.connect(_on_simulation_ended)


func _ready() -> void:
	_setup_references()
	_setup_materials()
	_on_size_changed()
	_update_belt_velocity()
	_update_collision_and_visibility()


func _physics_process(delta: float) -> void:
	if SimulationEvents.simulation_running:
		if not SimulationEvents.simulation_paused:
			_belt_position += speed * delta
		if _belt_position >= 1.0:
			_belt_position = 0.0
		_update_belt_material_position()


func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	SimulationEvents.simulation_ended.disconnect(_on_simulation_ended)
	super._exit_tree()


func _get_constrained_size(new_size: Vector3) -> Vector3:
	var height := new_size.y
	new_size.x = height / 2.0
	return new_size


func fix_material_overrides() -> void:
	# This is necessary because the editor's duplication action will overwrite our materials after we've initialized them.
	if _mesh.get_surface_override_material(0) != _belt_material:
		_mesh.set_surface_override_material(0, _belt_material)
	if _mesh.get_surface_override_material(1) != _metal_material:
		_mesh.set_surface_override_material(1, _metal_material)


func update_belt_color(color: Color) -> void:
	if _belt_material:
		(_belt_material as ShaderMaterial).set_shader_parameter("ColorMix", color)
		fix_material_overrides()


func update_belt_texture(is_standard_texture: bool) -> void:
	if _belt_material:
		(_belt_material as ShaderMaterial).set_shader_parameter("BlackTextureOn", is_standard_texture)
		fix_material_overrides()


func _setup_references() -> void:
	_belt_material = _mesh.mesh.surface_get_material(0) as ShaderMaterial
	_metal_material = _mesh.mesh.surface_get_material(1) as ShaderMaterial
	
	var collision_shape = _static_body.get_node_or_null("CollisionShape3D") as CollisionShape3D
	if collision_shape and collision_shape.shape:
		collision_shape.shape = collision_shape.shape.duplicate()


func _setup_materials() -> void:
	_belt_material = _mesh.mesh.surface_get_material(0).duplicate() as ShaderMaterial
	_metal_material = _mesh.mesh.surface_get_material(1).duplicate() as ShaderMaterial
	_mesh.set_surface_override_material(0, _belt_material)
	_mesh.set_surface_override_material(1, _metal_material)


func _update_belt_material_scale() -> void:
	var BASE_RADIUS: float = clamp(round((size.y - 0.01) * 100.0) / 100.0, 0.01, 0.25)
	var BASE_BELT_LENGTH: float = PI * BASE_RADIUS
	var belt_length := PI * size.x
	var belt_scale: float = belt_length / BASE_BELT_LENGTH
	if _belt_material and speed != 0:
		# Apply scaled UV scrolling to curved part of the conveyor end
		_belt_material.set_shader_parameter("Scale", belt_scale * sign(speed))
		fix_material_overrides()


func _update_metal_material_scale() -> void:
	if _metal_material:
		(_metal_material as ShaderMaterial).set_shader_parameter("Scale", _mesh.scale.x)
		(_metal_material as ShaderMaterial).set_shader_parameter("Scale2", _mesh.scale.y)
		fix_material_overrides()


func _update_belt_material_position() -> void:
	if _belt_material:
		(_belt_material as ShaderMaterial).set_shader_parameter("BeltPosition", _belt_position * sign(-speed))
		fix_material_overrides()


func _update_collision_and_visibility() -> void:
	if not _static_body:
		return
	if disable_collision:
		_static_body.collision_layer = 0
		_static_body.collision_mask = 0
		_static_body.visible = false
	else:
		_static_body.collision_layer = 2
		_static_body.collision_mask = 0
		_static_body.visible = true


func _update_belt_velocity() -> void:
	if not _static_body:
		return
		
	if SimulationEvents.simulation_running or speed != 0:
		var local_front: Vector3 = global_transform.basis.z.normalized()
		var radius: float = size.x
		var new_velocity: Vector3 = local_front * speed / radius
		if _static_body.constant_angular_velocity != new_velocity:
			_static_body.constant_angular_velocity = new_velocity


func _update_marker_positions() -> void:
	# Update marker positions to maintain their relative positions as the conveyor is resized
	var curved_end_marker_1 = get_node_or_null("CurvedEndMarker")
	var curved_end_marker_2 = get_node_or_null("CurvedEndMarker2")
	
	if curved_end_marker_1:
		curved_end_marker_1.position = Vector3(size.x, 0, size.z / 2.0)
	
	if curved_end_marker_2:
		curved_end_marker_2.position = Vector3(size.x, 0, -size.z / 2.0)


func _on_size_changed() -> void:
	if not get_node_or_null("MeshInstance3D"):
		return
	
	var collision_shape := get_node_or_null("StaticBody3D/CollisionShape3D")
	if not collision_shape or not collision_shape.shape:
		return
	
	var mesh_base_size := Vector3(0.25, 0.5, 2)
	$MeshInstance3D.scale = size / mesh_base_size
	
	var cylinder := collision_shape.shape as CylinderShape3D
	if cylinder:
		cylinder.height = size.z
		cylinder.radius = size.x

	_update_belt_material_scale()
	_update_metal_material_scale()
	_update_belt_velocity()
	_update_marker_positions()


func _on_simulation_started() -> void:
	_update_belt_velocity()


func _on_simulation_ended() -> void:
	_belt_position = 0.0
	_update_belt_material_position()
	if not is_inside_tree() or not _static_body:
		return
	_static_body.constant_angular_velocity = Vector3.ZERO
