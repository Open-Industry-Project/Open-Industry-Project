@tool
class_name ColorSensor
extends Node3D

@export var max_range: float = 1.524
@export var show_beam: bool = true:
	set(value):
		show_beam = value
		if _instance:
			RenderingServer.instance_set_visible(_instance, show_beam)

@export var color_detected: Color = Color.BLACK:
	set(value):
		color_detected = value

		if color_map.has(value):
			color_value = color_map[value]
		else:
			color_value = 0
		
		if _register_tag_ok and _tag_group_init:
			OIPComms.write_int32(tag_group_name, tag_name, color_value)

@export var color_map: Dictionary[Color, int] = {
	Color.RED: 1,
	Color.GREEN: 2,
	Color.BLUE: 3
}

@export var color_value: int = 0:
	set(value):
		if _register_tag_ok and _tag_group_init and value != color_value:
			OIPComms.write_int32(tag_group_name, tag_name, value)
		color_value = value

var _mesh: ImmediateMesh
var _beam_mat: StandardMaterial3D = preload("uid://ntmcfd25jgpm").duplicate()
var _instance: RID
var _scenario: RID
var _register_tag_ok: bool = false
var _tag_group_init: bool = false
var _tag_group_original: String
var _enable_comms_changed: bool = false:
	set(value):
		notify_property_list_changed()

@export_category("Communications")
@export var enable_comms: bool = false
@export var tag_group_name: String
@export_custom(0, "tag_group_enum") var tag_groups:
	set(value):
		tag_group_name = value
		tag_groups = value
@export var tag_name: String = ""


func _validate_property(property: Dictionary) -> void:
	if property.name == "color_value":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_READ_ONLY
	elif property.name == "tag_group_name":
		property.usage = PROPERTY_USAGE_STORAGE
	elif property.name == "enable_comms":
		property.usage = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "tag_groups":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "tag_name":
		property.usage = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE


func _property_can_revert(property: StringName) -> bool:
	return property == "tag_groups"


func _property_get_revert(property: StringName) -> Variant:
	if property == "tag_groups":
		return _tag_group_original
	else:
		return null


func _enter_tree() -> void:
	_instance = RenderingServer.instance_create()
	_scenario = get_world_3d().scenario
	_mesh = ImmediateMesh.new()

	RenderingServer.instance_set_scenario(_instance, _scenario)
	RenderingServer.instance_set_base(_instance, _mesh)
	RenderingServer.instance_set_visible(_instance, show_beam)

	_tag_group_original = tag_group_name
	if tag_group_name.is_empty():
		tag_group_name = OIPComms.get_tag_groups()[0]

	tag_groups = tag_group_name

	SimulationEvents.simulation_started.connect(_on_simulation_started)
	OIPComms.tag_group_initialized.connect(_tag_group_initialized)
	OIPComms.enable_comms_changed.connect(func() -> void: _enable_comms_changed = OIPComms.get_enable_comms())


func _exit_tree() -> void:
	RenderingServer.free_rid(_instance)
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	OIPComms.tag_group_initialized.disconnect(_tag_group_initialized)


func _physics_process(_delta: float) -> void:
	var start_pos := global_transform.translated_local(Vector3(0, 0.25, 0.42)).origin
	var end_pos := start_pos + global_transform.basis.z * max_range

	var query := PhysicsRayQueryParameters3D.create(start_pos, end_pos, 8)
	var space_state := get_world_3d().direct_space_state
	var result := space_state.intersect_ray(query)
	var result_distance := max_range
	var new_color: Color

	if result.size() > 0:
		result_distance = start_pos.distance_to(result["position"])
		var collider: CollisionObject3D = result["collider"]
		var mesh_instance: MeshInstance3D = collider.get_node("MeshInstance3D")
		var material: StandardMaterial3D = mesh_instance.mesh.surface_get_material(0)
		new_color = material.albedo_color
		_beam_mat.albedo_color = new_color
	else:
		new_color = Color.TRANSPARENT
		_beam_mat.albedo_color = Color.GREEN

	# Only update color_detected if the color actually changed
	if new_color != color_detected:
		color_detected = new_color

	if show_beam:
		_mesh.clear_surfaces()
		_mesh.surface_begin(Mesh.PRIMITIVE_LINES, _beam_mat)
		_mesh.surface_add_vertex(start_pos)

		if result.size() > 0:
			_mesh.surface_add_vertex(start_pos + global_transform.basis.z * result_distance)
		else:
			_mesh.surface_add_vertex(start_pos + global_transform.basis.z * max_range)

		_mesh.surface_end()


func use() -> void:
	show_beam = not show_beam


func _on_simulation_started() -> void:
	if enable_comms:
		_register_tag_ok = OIPComms.register_tag(tag_group_name, tag_name, 1)


func _tag_group_initialized(tag_group_name_param: String) -> void:
	if tag_group_name_param == tag_group_name:
		_tag_group_init = true
		if _register_tag_ok:
			OIPComms.write_int32(tag_group_name, tag_name, color_value)
