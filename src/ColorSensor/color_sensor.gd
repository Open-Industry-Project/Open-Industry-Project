@tool
extends Node3D

var register_tag_ok := false
var tag_group_init := false
var tag_group_original: String

var mesh : ImmediateMesh
var beam_mat : StandardMaterial3D = preload("uid://ntmcfd25jgpm").duplicate()
var instance
var scenario

@export var max_range: float = 1.524

@export var show_beam: bool = true:
	set(value):
		show_beam = value
		if instance: 
			RenderingServer.instance_set_visible(instance,show_beam)
	
@export var color : Color = Color.TRANSPARENT
		
@export var color_map : Dictionary[Color,int] = {
	Color.RED:1, 
	Color.GREEN:2, 
	Color.BLUE:3
}

@export var color_value : int = 0:
	set(value):
		if register_tag_ok and tag_group_init and value != color_value:
			OIPComms.write_int32(tag_group_name, tag_name, value)

		color_value = value

@export_category("Communications")

@export var enable_comms := false
@export var tag_group_name: String
@export_custom(0,"tag_group_enum") var tag_groups:
	set(value):
		tag_group_name = value
		tag_groups = value
		
@export var tag_name := ""

func _validate_property(property: Dictionary):
	if property.name == "color_value":
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

func _enter_tree() -> void:
	instance = RenderingServer.instance_create()
	scenario = get_world_3d().scenario
	mesh = ImmediateMesh.new()
	
	RenderingServer.instance_set_scenario(instance, scenario)
	RenderingServer.instance_set_base(instance, mesh)
	RenderingServer.instance_set_visible(instance,show_beam)
	
	tag_group_original = tag_group_name
	if(tag_group_name.is_empty()):
		tag_group_name = OIPComms.get_tag_groups()[0]

	tag_groups = tag_group_name

	SimulationEvents.simulation_started.connect(_on_simulation_started)
	OIPComms.tag_group_initialized.connect(_tag_group_initialized)

func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	OIPComms.tag_group_initialized.disconnect(_tag_group_initialized)


func _physics_process(delta: float) -> void:
	var start_pos = global_transform.translated_local(Vector3(0, 0.25, 0.42)).origin
	var end_pos = start_pos + global_transform.basis.z * max_range

	var query = PhysicsRayQueryParameters3D.create(start_pos, end_pos, 8)
	var space_state = get_world_3d().direct_space_state
	var result = space_state.intersect_ray(query)
	var result_distance = max_range

	if result.size() > 0:
		result_distance = start_pos.distance_to(result["position"])
		var collider : CollisionObject3D = result["collider"]
		var mesh_instance : MeshInstance3D = collider.get_node("MeshInstance3D")
		var material : StandardMaterial3D = mesh_instance.mesh.surface_get_material(0)
		color = material.albedo_color
		color_value = color_map.get(color,0)
		beam_mat.albedo_color = Color.RED
	else:
		color = Color.TRANSPARENT
		color_value = 0
		beam_mat.albedo_color = Color.GREEN

	if show_beam:
		mesh.clear_surfaces()
		mesh.surface_begin(Mesh.PRIMITIVE_LINES, beam_mat)
		mesh.surface_add_vertex(start_pos)
		
		if color_value == 0:
			mesh.surface_add_vertex(start_pos + global_transform.basis.z * result_distance)
		else:
			mesh.surface_add_vertex(start_pos + global_transform.basis.z * max_range)
		
		mesh.surface_end()

func _on_simulation_started() -> void:
	if enable_comms:
		register_tag_ok = OIPComms.register_tag(tag_group_name, tag_name, 1)

func _tag_group_initialized(_tag_group_name: String) -> void:
	if _tag_group_name == tag_group_name:
		tag_group_init = true
		if register_tag_ok:
			OIPComms.write_int32(tag_group_name, tag_name, color_value)
