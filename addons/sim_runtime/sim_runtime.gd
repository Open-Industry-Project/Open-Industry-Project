## Headless-friendly mirror of EditorInterface's simulation lifecycle.
##
## Parts (BeltConveyor, DiffuseSensor, ...) connect to SimRuntime instead of
## EditorInterface, so they work in both editor and headless runs. In the
## editor, sim_runtime_editor_bridge.gd forwards EditorInterface signals
## here. In headless, a runner script calls start_simulation() / stop_simulation()
## directly.
##
## Registered as autoload `SimRuntime` in project.godot — accessed globally
## by that name. No `class_name` here (would conflict with the autoload).
extends Node

signal simulation_started
signal simulation_stopped
signal simulation_pause_toggled(paused: bool)
signal transform_requested(data: Dictionary)
signal transform_commited

var _running: bool = false
var _paused: bool = false


func _ready() -> void:
	simulation_started.connect(_on_started)
	simulation_stopped.connect(_on_stopped)
	simulation_pause_toggled.connect(_on_pause_toggled)


func is_simulation_running() -> bool:
	return _running


func is_simulation_paused() -> bool:
	return _paused


func start_simulation() -> void:
	if _running:
		return
	simulation_started.emit()


func stop_simulation() -> void:
	if not _running:
		return
	simulation_stopped.emit()


func toggle_pause_simulation() -> void:
	simulation_pause_toggled.emit(not _paused)


func _on_started() -> void:
	_running = true
	_paused = false
	if Engine.has_singleton(&"OIPComms"):
		Engine.get_singleton(&"OIPComms").set_sim_running(true)


func _on_stopped() -> void:
	_running = false
	if Engine.has_singleton(&"OIPComms"):
		Engine.get_singleton(&"OIPComms").set_sim_running(false)


func _on_pause_toggled(paused: bool) -> void:
	_paused = paused
