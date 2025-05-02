@tool
extends AbstractRollerContainer
class_name RollerConveyorEnd

const BASE_WIDTH: float = 2.0

@export var flipped: bool = false:
	set(value):
		if _flipped != value:
			_flipped = value
			emit_signal("roller_rotation_changed", _get_rotation_from_skew_angle(_roller_skew_angle_degrees))

var _flipped: bool = false
var roller: Roller

func _ready() -> void:
	if not get_parent():
		return
	roller = get_node("Roller")
	setup_existing_rollers()

func _get_rollers() -> Array[Roller]:
	var rollers: Array[Roller] = []
	if roller:
		rollers.assign([roller])
	return rollers

func set_width(width: float) -> void:
	var end = get_node("ConveyorRollerEnd")
	end.scale = Vector3(1.0, 1.0, width / BASE_WIDTH)
	for end_mesh in end.get_children():
		if end_mesh is MeshInstance3D:
			end_mesh.scale = Vector3(1.0, 1.0, BASE_WIDTH / width)

func _get_rotation_from_skew_angle(angle_degrees: float) -> Vector3:
	var rot = super._get_rotation_from_skew_angle(angle_degrees)
	return rot + Vector3(0, 180, 0) if flipped else rot
