@tool
extends Node3D

var ray_marker: Marker3D
var ray_mesh: MeshInstance3D
var cylinder_mesh: CylinderMesh
var ray_material: StandardMaterial3D

var register_tag_ok := false
var tag_group_init := false
var tag_group_original: String

@export var enable_comms := true
@export var tag_group_name: String
@export_custom(0,"tag_group_enum") var tag_groups:
	set(value):
		tag_group_name = value
		tag_groups = value
			
@export var tag_name := ""	
@export var max_range: float = 6.0
@export var show_beam: bool :
	set(value): 
		show_beam = value
		if(ray_marker):
			ray_marker.visible = value;
	
@export var beam_blocked_color: Color = Color.RED
@export var beam_scan_color: Color = Color.GREEN
@export var blocked: bool = false:
	set(value):
		if register_tag_ok and tag_group_init and value != blocked:
			OIPComms.write_bit(tag_group_name, tag_name, value)

		blocked = value

func _validate_property(property: Dictionary):
	if property.name == "blocked":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_READ_ONLY
	elif property.name == "tag_group_name":
		property.usage = PROPERTY_USAGE_STORAGE
	elif property.name == "tag_groups":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE

func _property_can_revert(property: StringName) -> bool:
	return property == "tag_groups"

func _property_get_revert(property: StringName) -> Variant:
	if property == "tag_groups":
		return tag_group_original
	else: 
		return

func _ready() -> void:
	ray_marker = $RayMarker
	ray_mesh = $RayMarker/MeshInstance3D
	cylinder_mesh = ray_mesh.mesh.duplicate() as CylinderMesh
	ray_mesh.mesh = cylinder_mesh
	ray_material = cylinder_mesh.material.duplicate() as StandardMaterial3D
	cylinder_mesh.material = ray_material
	ray_marker.visible = show_beam

func _enter_tree() -> void:
	tag_group_original = tag_group_name
	if(tag_group_name.is_empty()):
		tag_group_name = OIPComms.get_tag_groups()[0]

	tag_groups = tag_group_name

	SimulationEvents.simulation_started.connect(_on_simulation_started)
	SimulationEvents.simulation_ended.connect(_on_simulation_ended)
	OIPComms.tag_group_initialized.connect(_tag_group_initialized)

func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	SimulationEvents.simulation_ended.disconnect(_on_simulation_ended)
	OIPComms.tag_group_initialized.disconnect(_tag_group_initialized)


func _physics_process(delta: float) -> void:
	var space_state = get_world_3d().direct_space_state
	var start_pos = ray_marker.global_transform.origin
	var end_pos = start_pos + global_transform.basis.z * max_range
	var query = PhysicsRayQueryParameters3D.create(start_pos, end_pos)
	query.collision_mask = 8
	var result = space_state.intersect_ray(query)
	
	if result.size() > 0:
		blocked = true
		var result_distance = ray_marker.global_transform.origin.distance_to(result["position"])
		if cylinder_mesh.height != result_distance:
				cylinder_mesh.height = result_distance
		if ray_material.albedo_color != beam_blocked_color:
				ray_material.albedo_color = beam_blocked_color
	else:
		blocked = false
		if cylinder_mesh.height != max_range:
				cylinder_mesh.height = max_range
		if ray_material.albedo_color != beam_scan_color:
				ray_material.albedo_color = beam_scan_color
	
	ray_mesh.position = Vector3(0, 0, cylinder_mesh.height * 0.5)

func _on_simulation_started() -> void:
	if enable_comms:
		register_tag_ok = OIPComms.register_tag(tag_group_name, tag_name, 1)

func _on_simulation_ended() -> void:
	cylinder_mesh.height = max_range
	ray_material.albedo_color = beam_scan_color
	ray_mesh.position = Vector3(0, 0, cylinder_mesh.height * 0.5)

func _tag_group_initialized(_tag_group_name: String) -> void:
	if _tag_group_name == tag_group_name:
		tag_group_init = true
		if register_tag_ok:
			OIPComms.write_bit(tag_group_name, tag_name, blocked)
