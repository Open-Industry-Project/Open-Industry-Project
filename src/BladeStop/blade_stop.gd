@tool
class_name BladeStop
extends Node3D

## When true, the blade is raised to stop items.
@export var active: bool = false:
	set(value):
		active = value
		if not is_inside_tree():
			return
			
		if active:
			_up()
		else:
			_down()

## Vertical offset for the blade's base position (adjusts mounting height).
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var air_pressure_height: float = 0.0:
	set(value):
		air_pressure_height = value
		if not is_inside_tree():
			return
			
		_blade.position = Vector3(_blade.position.x, air_pressure_height + _active_pos if active else air_pressure_height, _blade.position.z)
		_air_pressure_r.position = Vector3(_air_pressure_r.position.x, air_pressure_height, _air_pressure_r.position.z)
		_air_pressure_l.position = Vector3(_air_pressure_l.position.x, air_pressure_height, _air_pressure_l.position.z)

var _active_pos: float = 0.24
var _tag := OIPCommsTag.new()
@onready var _blade: StaticBody3D = $Blade
@onready var _air_pressure_r: MeshInstance3D = $Corners/AirPressureR
@onready var _air_pressure_l: MeshInstance3D = $Corners/AirPressureL
@onready var _blade_corner_r: MeshInstance3D = $Corners/AirPressureR/BladeCornerR
@onready var _blade_corner_l: MeshInstance3D = $Corners/AirPressureL/BladeCornerL
@onready var _corners: Node3D = $Corners

@export_category("Communications")
## Enable communication with external PLC/control systems.
@export var enable_comms: bool = false
@export var tag_group_name: String
## The tag group for reading/writing the active state.
@export_custom(0, "tag_group_enum") var tag_groups:
	set(value):
		tag_group_name = value
		tag_groups = value
## The tag name for the blade stop state in the selected tag group.[br]Datatype: [code]BOOL[/code][br][br]Format varies by protocol:[br][b]EIP:[/b] CIP tag names[br][b]Modbus:[/b] prefix+number (e.g. [code]co0[/code])[br][b]OPC UA:[/b] full NodeId (e.g. [code]ns=2;s=MyVariable[/code] or [code]ns=2;i=12345[/code]).
@export var tag_name: String = ""


func _validate_property(property: Dictionary) -> void:
	OIPCommsSetup.validate_tag_property(property)


func _enter_tree() -> void:
	tag_group_name = OIPCommsSetup.default_tag_group(tag_group_name)
	SimulationEvents.simulation_started.connect(_on_simulation_started)
	OIPCommsSetup.connect_comms(self, _tag_group_initialized, _tag_group_polled)


func _exit_tree() -> void:
	SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	OIPCommsSetup.disconnect_comms(self, _tag_group_initialized, _tag_group_polled)


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
		_tag.register(tag_group_name, tag_name)


func _tag_group_initialized(tag_group_name_param: String) -> void:
	if _tag.on_group_initialized(tag_group_name_param):
		_tag.write_bit(active)


func _tag_group_polled(tag_group_name_param: String) -> void:
	if not enable_comms or not _tag.matches_group(tag_group_name_param):
		return
	active = _tag.read_bit()
