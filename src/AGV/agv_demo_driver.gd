@tool
class_name AGVDemoDriver
extends Node3D

## Drives an AGV in a straight-aisle loop: pickup → reverse → 180° turn →
## approach rack → lift → insert → release → reverse → 180° turn → repeat.

@export var agv: AGV
## DiffuseSensor at conveyor end — AGV waits at PickupClear until this detects a pallet.
@export var end_sensor: Node3D
@export var pickup_clear_waypoint: String = "1: PickupClear"
@export var pickup_waypoint: String = "2: Pickup"
@export var rack_approach_waypoint: String = "3: RackApproach"
@export var rack_waypoint: String = "4: Rack"
## Lift heights for each rack level. Cycles in order.
@export var shelf_heights: Array[float] = [2.1, 4.1, 6.1]
## Fork height for sliding under a pallet on the conveyor.
@export_range(0.0, 3.0, 0.01, "suffix:m") var conveyor_lift: float = 0.85
## Fork height while driving between stations (clears conveyor guards).
@export_range(0.0, 3.0, 0.01, "suffix:m") var travel_lift: float = 0.9
@export_range(0.0, 5.0, 0.1, "suffix:s") var pickup_retry: float = 1.5
@export_range(0.0, 5.0, 0.1, "suffix:s") var dwell_time: float = 0.5

var _running: bool = false
var _shelf_index: int = 0


func _enter_tree() -> void:
	if not EditorInterface.simulation_started.is_connected(_on_sim_start):
		EditorInterface.simulation_started.connect(_on_sim_start)
	if not EditorInterface.simulation_stopped.is_connected(_on_sim_stop):
		EditorInterface.simulation_stopped.connect(_on_sim_stop)


func _exit_tree() -> void:
	if EditorInterface.simulation_started.is_connected(_on_sim_start):
		EditorInterface.simulation_started.disconnect(_on_sim_start)
	if EditorInterface.simulation_stopped.is_connected(_on_sim_stop):
		EditorInterface.simulation_stopped.disconnect(_on_sim_stop)


func _on_sim_start() -> void:
	if not agv:
		push_warning("AGVDemoDriver: no AGV assigned")
		return
	if shelf_heights.is_empty():
		push_warning("AGVDemoDriver: shelf_heights is empty")
		return
	_running = true
	_shelf_index = 0
	_run_cycle()


func _on_sim_stop() -> void:
	_running = false


func _run_cycle() -> void:
	while _running and is_instance_valid(agv):
		await _go(pickup_clear_waypoint)
		if not _running: return

		await _wait_for_pallet()
		if not _running: return

		await _drive_lift(conveyor_lift)

		await _go(pickup_waypoint)
		if not _running: return
		await _wait(dwell_time)

		agv.pick_at_current_height()
		if not agv.holding_object:
			await _wait(pickup_retry)
			continue

		await _drive_lift(travel_lift)

		await _go(pickup_clear_waypoint)
		if not _running: return

		await _go(rack_approach_waypoint)
		if not _running: return

		var shelf_h: float = shelf_heights[_shelf_index]
		await _drive_lift(shelf_h)

		await _go(rack_waypoint)
		if not _running: return
		await _wait(dwell_time)

		agv.release()
		await _wait(dwell_time)

		await _go(rack_approach_waypoint)
		if not _running: return

		await _drive_lift(travel_lift)

		_shelf_index = (_shelf_index + 1) % shelf_heights.size()


func _go(wp: String) -> void:
	agv.go_to_waypoint(wp)
	while _running and is_instance_valid(agv) and agv.is_moving():
		await get_tree().process_frame


func _drive_lift(h: float) -> void:
	agv.drive_lift(h)
	while _running and is_instance_valid(agv) and agv.is_lifting():
		await get_tree().process_frame


func _wait_for_pallet() -> void:
	if not end_sensor:
		await _wait(3.0)
		return
	while _running and is_instance_valid(end_sensor) and not end_sensor.detected:
		await get_tree().process_frame


func _wait(t: float) -> void:
	if t > 0:
		await get_tree().create_timer(t).timeout
