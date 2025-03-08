@tool
extends Node3D

@export var active: bool = false:
	set(value):
		active = value
		if(not _blade):
			return
		if(active):
			_up()
		else:
			_down()

var _active_pos: float = 0.24

@export var air_pressure_height: float = 0.0:
	set(value):
		air_pressure_height = value
		if(not _blade):
			return
		_blade.position = Vector3(_blade.position.x, air_pressure_height + _active_pos if active else air_pressure_height, _blade.position.z)
		_air_pressure_r.position = Vector3(_air_pressure_r.position.x, air_pressure_height, _air_pressure_r.position.z)
		_air_pressure_l.position = Vector3(_air_pressure_l.position.x, air_pressure_height, _air_pressure_l.position.z)


var _blade: StaticBody3D
var _air_pressure_r: MeshInstance3D
var _air_pressure_l: MeshInstance3D
var _blade_corner_r: MeshInstance3D
var _blade_corner_l: MeshInstance3D
var _corners: Node3D

func _ready() -> void:
	_blade = $Blade
	_air_pressure_r = $Corners/AirPressureR
	_air_pressure_l = $Corners/AirPressureL
	_blade_corner_r = $Corners/AirPressureR/BladeCornerR
	_blade_corner_l = $Corners/AirPressureL/BladeCornerL
	_corners = $Corners
	
	_blade.position = Vector3(_blade.position.x, air_pressure_height, _blade.position.z)
	_air_pressure_r.position = Vector3(_air_pressure_r.position.x, air_pressure_height, _air_pressure_r.position.z)
	_air_pressure_l.position = Vector3(_air_pressure_l.position.x, air_pressure_height, _air_pressure_l.position.z)

func use() -> void:
	active = not active

func _up() -> void:
	var tween = create_tween().set_parallel()
	tween.tween_property(_blade, "position", Vector3(_blade.position.x, air_pressure_height + _active_pos, _blade.position.z), 0.15)
	tween.tween_property(_blade_corner_r, "position", Vector3(_blade_corner_r.position.x, _active_pos, _blade_corner_r.position.z), 0.15)
	tween.tween_property(_blade_corner_l, "position", Vector3(_blade_corner_l.position.x, _active_pos, _blade_corner_l.position.z), 0.15)

func _down() -> void:
	var tween = create_tween().set_parallel()
	tween.tween_property(_blade, "position", Vector3(_blade.position.x, air_pressure_height, _blade.position.z), 0.15)
	tween.tween_property(_blade_corner_r, "position", Vector3(_blade_corner_r.position.x, 0, _blade_corner_r.position.z), 0.15)
	tween.tween_property(_blade_corner_l, "position", Vector3(_blade_corner_l.position.x, 0, _blade_corner_l.position.z), 0.15)
