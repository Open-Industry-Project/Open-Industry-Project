@tool
class_name ConveyorStopSensor
extends Node3D

## Stops a conveyor when a DiffuseSensor detects an object.
## Restores conveyor speed when the sensor clears.

@export var sensor: Node3D
@export var conveyor: Node3D
@export_custom(PROPERTY_HINT_NONE, "suffix:m/s") var run_speed: float = 0.5


func _physics_process(_delta: float) -> void:
	if not EditorInterface.is_simulation_running():
		return
	if not sensor or not conveyor:
		return
	if sensor.detected:
		conveyor.speed = 0.0
	else:
		conveyor.speed = run_speed
