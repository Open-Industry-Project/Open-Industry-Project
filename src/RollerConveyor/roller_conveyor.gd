@tool
class_name RollerConveyor
extends ResizableNode3D

@export var enable_comms: bool = false:
	set(value):
		enable_comms = value
		notify_property_list_changed()
@export var tag: String = ""
@export var update_rate: int = 100
@export_custom(PROPERTY_HINT_NONE, "suffix:m/s")
var speed: float = 2.0:
	set(value):
		speed = value
		if _instance_ready:
			$RollerConveyorLegacy.speed = value
@export_range(-60, 60 , 1, "degrees") var skew_angle: float = 0.0:
	set(value):
		skew_angle = value
		if _instance_ready:
			$RollerConveyorLegacy.skew_angle = value


static func _get_constrained_size(new_size: Vector3) -> Vector3:
	return Vector3(max(1.5, new_size.x), 0.24, max(0.10, new_size.z))


func _on_instantiated() -> void:
	$RollerConveyorLegacy.on_scene_instantiated()
	super._on_instantiated()
	$RollerConveyorLegacy.speed = speed
	$RollerConveyorLegacy.skew_angle = skew_angle


func _get_initial_size() -> Vector3:
	return Vector3(abs($RollerConveyorLegacy.scale.x) + 0.5, 0.24, abs($RollerConveyorLegacy.scale.z))


func _get_default_size() -> Vector3:
	return Vector3(1.525, 0.24, 1.524)


func _on_size_changed() -> void:
	$RollerConveyorLegacy.set_size(size)
