@tool
class_name BeltConveyor
extends ResizableNode3D

enum ConvTexture {
	STANDARD,
	ALTERNATE
}

## Emitted when the conveyor's speed changes.
signal speed_changed

@export var belt_color : Color = Color(1, 1, 1, 1):
	set(value):
		belt_color = value
		_update_material_color()

@export var belt_texture = ConvTexture.STANDARD:
	set(value):
		belt_texture = value
		_update_material_texture()


## Conveyor speed in meters per second.
## Negative values will reverse the direction of the conveyor.
@export_custom(PROPERTY_HINT_NONE, "suffix:m/s") var speed: float = 2:
	set(value):
		if value == speed:
			return
		speed = value
		_update_speed()
		_update_belt_material_scale()
		speed_changed.emit()

		# dont write until the group is initialized
		if register_speed_tag_ok and speed_tag_group_init:
			OIPComms.write_float32(speed_tag_group_name, speed_tag_name, value)

		if register_running_tag_ok and running_tag_group_init:
			OIPComms.write_bit(running_tag_group_name, running_tag_name, value > 0.0)

@export var belt_physics_material : PhysicsMaterial:
	get:
		var sb_node = get_node_or_null("StaticBody3D") as StaticBody3D
		if sb_node:
			return sb_node.physics_material_override
		return null
	set(value):
		var sb_node = get_node_or_null("StaticBody3D") as StaticBody3D
		if sb_node:
			sb_node.physics_material_override = value
		var sb_end1 = get_node_or_null("BeltConveyorEnd/StaticBody3D") as StaticBody3D
		if sb_end1:
			sb_end1.physics_material_override = value
		var sb_end2 = get_node_or_null("BeltConveyorEnd2/StaticBody3D") as StaticBody3D
		if sb_end2:
			sb_end2.physics_material_override = value

var sb: StaticBody3D
var ce1: BeltConveyorEnd
var ce2: BeltConveyorEnd
var mesh: MeshInstance3D
var belt_material: Material
var metal_material: Material
var belt_position: float = 0.0

var register_speed_tag_ok := false
var register_running_tag_ok := false
var speed_tag_group_init := false
var running_tag_group_init := false
var _enable_comms_changed = false:
	set(value):
		notify_property_list_changed()

@export_category("Communications")
@export var enable_comms := false
@export var speed_tag_group_name: String
@export_custom(0,"tag_group_enum") var speed_tag_groups:
	set(value):
		speed_tag_group_name = value
		speed_tag_groups = value
@export var speed_tag_name := ""
@export var running_tag_group_name: String
@export_custom(0,"tag_group_enum") var running_tag_groups:
	set(value):
		running_tag_group_name = value
		running_tag_groups = value
@export var running_tag_name := ""


func _validate_property(property: Dictionary):
	if property.name == "enable_comms":
		property.usage = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "speed_tag_group_name":
		property.usage = PROPERTY_USAGE_STORAGE
	elif property.name == "speed_tag_groups":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "speed_tag_name":
		property.usage = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "running_tag_group_name":
		property.usage = PROPERTY_USAGE_STORAGE
	elif property.name == "running_tag_groups":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "running_tag_name":
		property.usage = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE


static func _get_constrained_size(new_size: Vector3) -> Vector3:
	# Don't allow belt conveyors to be shorter than the total length of their ends.
	# Ends' length varies with height.
	var height := new_size.y
	var end_length := height / 2.0
	# For sanity, ensure that the middle's length is non-zero.
	var middle_min_length := 0.01
	var minimum_length := end_length * 2.0 + middle_min_length
	new_size.x = max(new_size.x, minimum_length)
	return new_size


func _init() -> void:
	SIZE_DEFAULT = Vector3(4, 0.5, 1.524)


func _on_instantiated() -> void:
	_setup_references()
	_setup_materials()
	_update_material_texture()
	_update_material_color()
	_update_speed()
	_update_physics_material()
	_on_size_changed()


func _enter_tree() -> void:
	SimulationEvents.simulation_started.connect(_on_simulation_started)
	SimulationEvents.simulation_ended.connect(_on_simulation_ended)
	OIPComms.tag_group_initialized.connect(_tag_group_initialized)
	OIPComms.tag_group_polled.connect(_tag_group_polled)
	OIPComms.enable_comms_changed.connect(func() -> void: _enable_comms_changed = OIPComms.get_enable_comms)


func _ready() -> void:
	migrate_scale_to_size()


func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	SimulationEvents.simulation_ended.disconnect(_on_simulation_ended)
	OIPComms.tag_group_initialized.disconnect(_tag_group_initialized)
	OIPComms.tag_group_polled.disconnect(_tag_group_polled)


func _physics_process(delta: float) -> void:
	if SimulationEvents.simulation_running:
		var local_left = sb.global_transform.basis.x.normalized()
		var velocity = local_left * speed
		sb.constant_linear_velocity = velocity
		if !SimulationEvents.simulation_paused:
			belt_position += speed * delta
		if speed != 0:
			(belt_material as ShaderMaterial).set_shader_parameter("BeltPosition", belt_position * sign(speed))
		if belt_position >= 1.0:
			belt_position = 0.0


func _on_simulation_started() -> void:
	if enable_comms:
		register_speed_tag_ok = OIPComms.register_tag(speed_tag_group_name, speed_tag_name, 1)
		register_running_tag_ok = OIPComms.register_tag(running_tag_group_name, running_tag_name, 1)


func _on_simulation_ended() -> void:
	belt_position = 0.0
	(belt_material as ShaderMaterial).set_shader_parameter("BeltPosition", belt_position)
	sb.constant_linear_velocity = Vector3.ZERO


func _setup_references() -> void:
	sb = get_node("StaticBody3D") as StaticBody3D
	ce1 = get_node("BeltConveyorEnd") as BeltConveyorEnd
	ce2 = get_node("BeltConveyorEnd2") as BeltConveyorEnd
	mesh = get_node("StaticBody3D/MeshInstance3D") as MeshInstance3D
	belt_material = mesh.mesh.surface_get_material(0)
	metal_material = mesh.mesh.surface_get_material(1)


func _setup_materials() -> void:
	belt_material = mesh.mesh.surface_get_material(0).duplicate() as Material
	metal_material = mesh.mesh.surface_get_material(1).duplicate() as Material
	mesh.set_surface_override_material(0, belt_material)
	mesh.set_surface_override_material(1, metal_material)
	mesh.set_surface_override_material(2, metal_material)


func fix_material_overrides() -> void:
	# This is necessary because the editor's duplication action will overwrite our materials after we've initialized them.
	if mesh.get_surface_override_material(0) != belt_material:
		mesh.set_surface_override_material(0, belt_material)
	if mesh.get_surface_override_material(1) != metal_material:
		mesh.set_surface_override_material(1, metal_material)
	if mesh.get_surface_override_material(2) != metal_material:
		mesh.set_surface_override_material(2, metal_material)


func _update_material_texture() -> void:
	if belt_material:
		belt_material.set_shader_parameter("BlackTextureOn", belt_texture == ConvTexture.STANDARD)
		fix_material_overrides()
	if ce1 and ce1.belt_material:
		ce1.belt_material.set_shader_parameter("BlackTextureOn", belt_texture == ConvTexture.STANDARD)
		ce1.fix_material_overrides()
	if ce2 and ce2.belt_material:
		ce2.belt_material.set_shader_parameter("BlackTextureOn", belt_texture == ConvTexture.STANDARD)
		ce2.fix_material_overrides()


func _update_material_color() -> void:
	if belt_material:
		belt_material.set_shader_parameter("ColorMix", belt_color)
		fix_material_overrides()
	if ce1 and ce1.belt_material:
		ce1.belt_material.set_shader_parameter("ColorMix", belt_color)
		ce1.fix_material_overrides()
	if ce2 and ce2.belt_material:
		ce2.belt_material.set_shader_parameter("ColorMix", belt_color)
		ce2.fix_material_overrides()


func _update_speed() -> void:
	if ce1:
		ce1.speed = speed
	if ce2:
		ce2.speed = speed


func _update_physics_material() -> void:
	if ce1:
		var sb1 = ce1.get_node("StaticBody3D") as StaticBody3D
		if sb1:
			sb1.physics_material_override = sb.physics_material_override
	if ce2:
		var sb2 = ce2.get_node("StaticBody3D") as StaticBody3D
		if sb2:
			sb2.physics_material_override = sb.physics_material_override


func _update_belt_material_scale() -> void:
	if belt_material and speed != 0:
		var BASE_RADIUS: float = clamp(round((size.y - 0.01) * 100.0) / 100.0, 0.01, 0.25)
		var collision_shape = sb.get_node("CollisionShape3D").shape as BoxShape3D
		var middle_length = collision_shape.size.x
		var BASE_BELT_LENGTH: float = PI * BASE_RADIUS
		var belt_scale: float = middle_length / BASE_BELT_LENGTH
		(belt_material as ShaderMaterial).set_shader_parameter("Scale", belt_scale * sign(speed))
		fix_material_overrides()

func _update_metal_material_scale() -> void:
	if metal_material:
		(metal_material as ShaderMaterial).set_shader_parameter("Scale", mesh.scale.x)
		(metal_material as ShaderMaterial).set_shader_parameter("Scale2", mesh.scale.y)
		fix_material_overrides()


func _on_size_changed() -> void:
	var length := size.x
	var height := size.y
	var width := size.z

	# Get components that need to be adjusted.
	var end1 := ce1
	var end2 := ce2
	var middle_body := sb
	var middle_mesh := mesh
	var middle_collision_shape := get_node_and_resource("StaticBody3D/CollisionShape3D:shape")[1] as BoxShape3D
	if not (is_instance_valid(end1)
			and is_instance_valid(end2)
			and is_instance_valid(middle_body)
			and is_instance_valid(middle_mesh)
			and is_instance_valid(middle_collision_shape)):
		# Children not instantiated yet.
		# Do nothing and wait to get called again later.
		return

	# Calculate dimensions of the components (when they don't match the ones above).
	# Ends' length varies with height.
	var end_length := height / 2.0
	# Middle length fills the rest.
	var middle_length := length - 2.0 * end_length

	# Update component sizes.
	var middle_size := Vector3(middle_length, height, width)
	var end_size := Vector3(end_length, height, width)
	# Size of the mesh at scale=1. (Size per scale unit.)
	var middle_mesh_base_size := Vector3(1, 0.5, 2)
	middle_mesh.scale = middle_size / middle_mesh_base_size
	middle_collision_shape.size = middle_size
	end1.size = end_size
	end2.size = end_size

	# Update materials.
	_update_belt_material_scale()
	_update_metal_material_scale()

	# Update component positions.
	# Ensures that the top surface of the conveyor is on the y=0 plane.
	var base_pos = Vector3(0, -height / 2.0, 0)
	middle_body.position = base_pos
	var end_offset_x = length / 2.0 - end_length
	end1.position = Vector3(base_pos.x + end_offset_x, base_pos.y, base_pos.z)
	end2.position = Vector3(base_pos.x + -end_offset_x, base_pos.y, base_pos.z)


## Convert existing scale into size.
## Avoids doing anything if size has already been set to a non-default value.
func migrate_scale_to_size():
	if scale == Vector3.ONE:
		return  # scale already reset; nothing to do
	if size != SIZE_DEFAULT:
		return  # size isn't default; assume migration has already happened despite the unexpected scale.
	var scale_original = scale
	scale = Vector3.ONE
	size = scale_original * Vector3(1, 0.5, 1) + Vector3(0.5, 0, 0)


func _tag_group_initialized(_tag_group_name: String) -> void:
	if _tag_group_name == speed_tag_group_name:
		speed_tag_group_init = true
	if _tag_group_name == running_tag_group_name:
		running_tag_group_init = true


func _tag_group_polled(_tag_group_name: String) -> void:
	if not enable_comms: return

	if _tag_group_name == speed_tag_group_name and speed_tag_group_init:
		speed = OIPComms.read_float32(speed_tag_group_name, speed_tag_name)
