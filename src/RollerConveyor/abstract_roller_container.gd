@tool
@abstract
class_name AbstractRollerContainer
extends Node3D

signal width_changed(width: float)
signal length_changed(length: float)
signal roller_length_changed(length: float)
signal roller_rotation_changed(rotation_degrees: Vector3)
signal roller_added(roller: Roller)
signal roller_removed(roller: Roller)

var _width: float = 2.0
var _length: float = 1.0
var _roller_length: float = 2.0
var _roller_skew_angle_degrees: float = 0.0

func _init() -> void:
	roller_added.connect(self._handle_roller_added)
	roller_removed.connect(self._handle_roller_removed)

# Virtual method to be overridden
func setup_existing_rollers() -> void:
	for roller in _get_rollers():
		roller_added.emit(roller)

func set_width(width: float) -> void:
	var changed := _width != width
	_width = width
	if changed:
		_update_roller_length()
		width_changed.emit(_width)

func set_length(length: float) -> void:
	var changed := _length != length
	_length = length
	if changed:
		length_changed.emit(_length)

func set_roller_skew_angle(skew_angle_degrees: float) -> void:
	var changed := fmod(_roller_skew_angle_degrees, 360.0) != fmod(skew_angle_degrees, 360.0)
	_roller_skew_angle_degrees = skew_angle_degrees
	if changed:
		roller_rotation_changed.emit(_get_rotation_from_skew_angle(_roller_skew_angle_degrees))
		_update_roller_length()

func _update_roller_length() -> void:
	if abs(fmod(_roller_skew_angle_degrees, 180.0)) == 90.0:
		return
	var new_length := _width / cos(_roller_skew_angle_degrees * 2.0 * PI / 360.0)
	var changed := new_length != _roller_length
	_roller_length = new_length
	if changed:
		roller_length_changed.emit(_roller_length)

# Virtual method to be overridden
func _get_rollers() -> Array[Roller]:
	var rollers: Array[Roller] = []
	for child in get_children():
		if child is Roller:
			rollers.append(child)
	return rollers

func _handle_roller_added(roller: Roller) -> void:
	roller.set_rotation_degrees(_get_rotation_from_skew_angle(_roller_skew_angle_degrees))
	roller.set_length(_roller_length)

	# It's possible for this handler to be called multiple times for the same roller:
	# Once when an increase in length adds a Roller and again when instantiation completes (setup_existing_rollers).
	# Check if the signal is already connected to avoid errors.
	if not roller_rotation_changed.is_connected(roller.set_rotation_degrees):
		roller_rotation_changed.connect(roller.set_rotation_degrees)
	if not roller_length_changed.is_connected(roller.set_length):
		roller_length_changed.connect(roller.set_length)

func _handle_roller_removed(roller: Roller) -> void:
	roller_rotation_changed.disconnect(roller.set_rotation_degrees)
	roller_length_changed.disconnect(roller.set_length)

# Virtual method to be overridden
func _get_rotation_from_skew_angle(angle_degrees: float) -> Vector3:
	return Vector3(0, angle_degrees, 0)
