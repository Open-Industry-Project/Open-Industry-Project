@tool
class_name BladeStop
extends Node3D

@export var active: bool = false:
	set(value):
		active = value
		if not is_inside_tree():
			return
			
		if active:
			_up()
		else:
			_down()

@export var air_pressure_height: float = 0.0:
	set(value):
		air_pressure_height = value
		if not is_inside_tree():
			return
			
		_blade.position = Vector3(_blade.position.x, air_pressure_height + _active_pos if active else air_pressure_height, _blade.position.z)
		_air_pressure_r.position = Vector3(_air_pressure_r.position.x, air_pressure_height, _air_pressure_r.position.z)
		_air_pressure_l.position = Vector3(_air_pressure_l.position.x, air_pressure_height, _air_pressure_l.position.z)

var _active_pos: float = 0.24
var _register_tag_ok: bool = false
var _tag_group_init: bool = false
var _tag_group_original: String
@onready var _blade: StaticBody3D = $Blade
@onready var _air_pressure_r: MeshInstance3D = $Corners/AirPressureR
@onready var _air_pressure_l: MeshInstance3D = $Corners/AirPressureL
@onready var _blade_corner_r: MeshInstance3D = $Corners/AirPressureR/BladeCornerR
@onready var _blade_corner_l: MeshInstance3D = $Corners/AirPressureL/BladeCornerL
@onready var _corners: Node3D = $Corners

@export_category("Communications")
@export var enable_comms: bool = false
@export var tag_group_name: String
@export_custom(0, "tag_group_enum") var tag_groups:
	set(value):
		tag_group_name = value
		tag_groups = value
@export var tag_name: String = ""


func _validate_property(property: Dictionary) -> void:
	if property.name == "tag_group_name":
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
	_tag_group_original = tag_group_name
	if tag_group_name.is_empty():
		tag_group_name = OIPComms.get_tag_groups()[0]

	tag_groups = tag_group_name

	SimulationEvents.simulation_started.connect(_on_simulation_started)
	OIPComms.tag_group_initialized.connect(_tag_group_initialized)
	OIPComms.tag_group_polled.connect(_tag_group_polled)
	OIPComms.enable_comms_changed.connect(notify_property_list_changed)


func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	OIPComms.tag_group_initialized.disconnect(_tag_group_initialized)
	OIPComms.tag_group_polled.disconnect(_tag_group_polled)
	OIPComms.enable_comms_changed.disconnect(notify_property_list_changed)


func _ready() -> void:
	_blade.position = Vector3(_blade.position.x, air_pressure_height, _blade.position.z)
	_air_pressure_r.position = Vector3(_air_pressure_r.position.x, air_pressure_height, _air_pressure_r.position.z)
	_air_pressure_l.position = Vector3(_air_pressure_l.position.x, air_pressure_height, _air_pressure_l.position.z)


func use() -> void:
	active = not active


func _up() -> void:
	var tween := create_tween().set_parallel()
	tween.tween_property(_blade, "position", Vector3(_blade.position.x, air_pressure_height + _active_pos, _blade.position.z), 0.15)
	tween.tween_property(_blade_corner_r, "position", Vector3(_blade_corner_r.position.x, _active_pos, _blade_corner_r.position.z), 0.15)
	tween.tween_property(_blade_corner_l, "position", Vector3(_blade_corner_l.position.x, _active_pos, _blade_corner_l.position.z), 0.15)


func _down() -> void:
	var tween := create_tween().set_parallel()
	tween.tween_property(_blade, "position", Vector3(_blade.position.x, air_pressure_height, _blade.position.z), 0.15)
	tween.tween_property(_blade_corner_r, "position", Vector3(_blade_corner_r.position.x, 0, _blade_corner_r.position.z), 0.15)
	tween.tween_property(_blade_corner_l, "position", Vector3(_blade_corner_l.position.x, 0, _blade_corner_l.position.z), 0.15)


func _on_simulation_started() -> void:
	if enable_comms:
		_register_tag_ok = OIPComms.register_tag(tag_group_name, tag_name, 1)


func _tag_group_initialized(tag_group_name_param: String) -> void:
	if tag_group_name_param == tag_group_name:
		_tag_group_init = true
		if _register_tag_ok:
			OIPComms.write_bit(tag_group_name, tag_name, active)


func _tag_group_polled(tag_group_name_param: String) -> void:
	if not enable_comms:
		return
		
	active = OIPComms.read_bit(tag_group_name, tag_name)
