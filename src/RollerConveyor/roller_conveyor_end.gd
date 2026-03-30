@tool
class_name RollerConveyorEnd
extends AbstractRollerContainer

const END_OFFSET: float = 0.165

## When true, mirrors the end roller rotation (used for opposite-end positioning).
@export var flipped: bool = false:
	set(value):
		if flipped != value:
			flipped = value
			roller_rotation_changed.emit(_get_rotation_from_skew_angle(_roller_skew_angle_degrees))
			_update_all_roller_lengths()

@onready var _roller: Roller = get_node("Roller")


func setup_existing_rollers() -> void:
	super.setup_existing_rollers()


func _get_rollers() -> Array[Roller]:
	if _roller == null:
		return []
	return [_roller]


func _get_rotation_from_skew_angle(angle_degrees: float) -> Vector3:
	var rot := super._get_rotation_from_skew_angle(angle_degrees)
	return rot + Vector3(0, 180, 0) if flipped else rot


func _apply_roller_length(roller: Roller) -> void:
	var roller_conveyor_x: float
	if flipped:
		roller_conveyor_x = -_length / 2.0 + END_OFFSET
	else:
		roller_conveyor_x = _length / 2.0 - END_OFFSET

	var skew_rad := deg_to_rad(_roller_skew_angle_degrees)

	var result := AbstractRollerContainer.calculate_clipped_roller(
		roller_conveyor_x,
		_effective_conveyor_half_length(),
		_roller_length,
		skew_rad,
	)

	var clipped_length := result.x
	var center_offset := result.y

	if clipped_length <= 0.0:
		roller.visible = false
		return

	roller.visible = true
	roller.set_length_and_offset(clipped_length, center_offset)
	roller.position = Vector3(0.0, roller.position.y, 0.0)
