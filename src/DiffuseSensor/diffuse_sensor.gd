@tool
class_name DiffuseSensor
extends Node3D

@export var max_range: float = 1.524:
	set(value):
		value = clamp(value, 0, 100)
		max_range = value

@export var show_beam: bool = true:
	set(value):
		show_beam = value
		if _instance:
			RenderingServer.instance_set_visible(_instance, show_beam)
			if show_beam:
				_beam_needs_update = true

@export var normally_closed: bool = false:
	set(value):
		normally_closed = value
		_update_output()

@export var detected: bool = false:
	set(value):
		detected = value
		_update_output()

@export var output: bool = false:
	set(value):
		if _register_tag_ok and _tag_group_init and value != output:
			OIPComms.write_bit(tag_group_name, tag_name, value)
		output = value

var _mesh: ImmediateMesh
static var _beam_material: StandardMaterial3D = preload("uid://ntmcfd25jgpm")
var _instance: RID
var _scenario: RID
var _register_tag_ok: bool = false
var _tag_group_init: bool = false
var _tag_group_original: String
var _enable_comms_changed: bool = false:
	set(value):
		notify_property_list_changed()

var _last_result_distance: float = -1.0
var _last_beam_color: Color = Color.TRANSPARENT
var _last_has_detection: bool = false
var _last_transform: Transform3D
var _beam_needs_update: bool = true

@export_category("Communications")
@export var enable_comms: bool = false
@export var tag_group_name: String
@export_custom(0, "tag_group_enum") var tag_groups:
	set(value):
		tag_group_name = value
		tag_groups = value
@export var tag_name: String = ""


func _validate_property(property: Dictionary) -> void:
	if property.name == "detected":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_READ_ONLY
	elif property.name == "output":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_READ_ONLY
	elif property.name == "tag_group_name":
		property.usage = PROPERTY_USAGE_STORAGE
	elif property.name == "enable_comms":
		property.usage = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_STORAGE
	elif property.name == "tag_groups":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if OIPComms.get_enable_comms() else PROPERTY_USAGE_NONE
	elif property.name == "tag_name":
		property.usage = PROPERTY_USAGE_DEFAULT if OIPComms.get_enable_comms() else PROPERTY_USAGE_STORAGE


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
	_beam_needs_update = true

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
	var has_detection := result.size() > 0

	var beam_color: Color
	if has_detection:
		result_distance = start_pos.distance_to(result["position"])
		detected = true
		beam_color = Color.RED
	else:
		detected = false
		beam_color = Color.GREEN

	var current_transform = global_transform
	if show_beam and (_beam_needs_update or result_distance != _last_result_distance or 
					  beam_color != _last_beam_color or has_detection != _last_has_detection or 
					  current_transform != _last_transform):
		_update_beam_mesh(start_pos, result_distance, beam_color, has_detection)
		_last_result_distance = result_distance
		_last_beam_color = beam_color
		_last_has_detection = has_detection
		_last_transform = current_transform
		_beam_needs_update = false


func _update_beam_mesh(start_pos: Vector3, result_distance: float, beam_color: Color, has_detection: bool) -> void:
	_mesh.clear_surfaces()
	_mesh.surface_begin(Mesh.PRIMITIVE_LINES, _beam_material)
	_mesh.surface_set_color(beam_color)
	_mesh.surface_add_vertex(start_pos)

	if has_detection:
		_mesh.surface_set_color(beam_color)
		_mesh.surface_add_vertex(start_pos + global_transform.basis.z * result_distance)
	else:
		_mesh.surface_add_vertex(start_pos + global_transform.basis.z * max_range)

	_mesh.surface_end()


func use() -> void:
	show_beam = not show_beam


func _update_output() -> void:
	var new_output := detected
	if normally_closed:
		new_output = !detected
	output = new_output


func _on_simulation_started() -> void:
	if enable_comms:
		_register_tag_ok = OIPComms.register_tag(tag_group_name, tag_name, 1)


func _tag_group_initialized(tag_group_name_param: String) -> void:
	if tag_group_name_param == tag_group_name:
		_tag_group_init = true
		if _register_tag_ok:
			OIPComms.write_bit(tag_group_name, tag_name, output)
