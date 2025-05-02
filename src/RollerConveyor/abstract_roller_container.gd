@tool
extends Node3D
class_name AbstractRollerContainer

signal width_changed(width: float)
signal length_changed(length: float)
signal roller_length_changed(length: float)
signal roller_rotation_changed(rotation_degrees: Vector3)
signal roller_added(roller: Roller)
signal roller_removed(roller: Roller)

var _width: float = 2
var _length: float = 1
var _roller_length: float = 2
var _roller_skew_angle_degrees: float = 0.0

func _init() -> void:
	roller_added.connect(self._handle_roller_added)
	roller_removed.connect(self._handle_roller_removed)

# Virtual method to be overridden
func setup_existing_rollers() -> void:
	for roller in _get_rollers():
		# If length_changed has already been fired, then we've already
		# added and subscribed some Rollers, but we still need to
		# subscribe the original ones. To ensure that each Roller is
		# only subscribed once, we're going to unsubscribe them all,
		# then then subscribe them.
		roller_removed.emit(roller)
		roller_added.emit(roller)

func on_owner_scale_changed(scale: Vector3) -> void:
	rescale_inverse(scale)

func rescale_inverse(owner_scale: Vector3) -> void:
	scale = Vector3(1.0 / owner_scale.x, 1.0 / owner_scale.y, 1.0 / owner_scale.z)

func set_width(width: float) -> void:
	var changed: bool = _width != width
	_width = width
	if changed:
		update_roller_length()
		width_changed.emit(_width)

func set_length(length: float) -> void:
	var changed: bool = _length != length
	_length = length
	if changed:
		length_changed.emit(_length)

func set_roller_skew_angle(skew_angle_degrees: float) -> void:
	var changed: bool = fmod(_roller_skew_angle_degrees, 360.0) != fmod(skew_angle_degrees, 360.0)
	_roller_skew_angle_degrees = skew_angle_degrees
	if changed:
		roller_rotation_changed.emit(_get_rotation_from_skew_angle(_roller_skew_angle_degrees))
		update_roller_length()

func update_roller_length() -> void:
	if abs(fmod(_roller_skew_angle_degrees, 180.0)) == 90.0:
		return
	var new_length: float = _width / cos(_roller_skew_angle_degrees * 2.0 * PI / 360.0)
	var changed: bool = new_length != _roller_length
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

	roller_rotation_changed.connect(roller.set_rotation_degrees)
	roller_length_changed.connect(roller.set_length)

func _handle_roller_removed(roller: Roller) -> void:
	roller_rotation_changed.disconnect(roller.set_rotation_degrees)
	roller_length_changed.disconnect(roller.set_length)

# Virtual method to be overridden
func _get_rotation_from_skew_angle(angle_degrees: float) -> Vector3:
	return Vector3(0, angle_degrees, 0)
