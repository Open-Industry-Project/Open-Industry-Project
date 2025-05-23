@tool
class_name RollerConveyorEnd
extends AbstractRollerContainer

@export var flipped: bool = false:
	set(value):
		if flipped != value:
			flipped = value
			roller_rotation_changed.emit(_get_rotation_from_skew_angle(_roller_skew_angle_degrees))

var _roller: Roller

func _init() -> void:
	super()
	width_changed.connect(self._set_ends_separation)

func setup_existing_rollers() -> void:
	_roller = get_node("Roller")
	super.setup_existing_rollers()

func _get_rollers() -> Array[Roller]:
	var rollers: Array[Roller] = [_roller]
	return rollers

func _get_rotation_from_skew_angle(angle_degrees: float) -> Vector3:
	var rot = super._get_rotation_from_skew_angle(angle_degrees)
	return rot + Vector3(0, 180, 0) if flipped else rot

func _set_ends_separation(width: float) -> void:
	var end_node = get_node("ConveyorRollerEnd")
	if end_node:
		var meshes = []
		for child in end_node.get_children():
			if child is MeshInstance3D:
				meshes.append(child)

		if meshes.size() >= 2:
			var half_width = width / 2.0
			meshes[0].position = Vector3(meshes[0].position.x, meshes[0].position.y, -half_width)
			meshes[1].position = Vector3(meshes[1].position.x, meshes[1].position.y, half_width)
