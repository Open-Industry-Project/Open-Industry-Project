## Editor-only: forwards EditorInterface simulation signals to the
## SimRuntime autoload so parts (which now connect to SimRuntime) keep
## working when the user presses Play in the editor.
##
## In headless this plugin is not loaded; HeadlessRunner-style scripts
## drive SimRuntime directly via start_simulation() / stop_simulation().
@tool
extends EditorPlugin


func _enter_tree() -> void:
	EditorInterface.simulation_started.connect(SimRuntime.simulation_started.emit)
	EditorInterface.simulation_stopped.connect(SimRuntime.simulation_stopped.emit)
	EditorInterface.simulation_pause_toggled.connect(SimRuntime.simulation_pause_toggled.emit)
	EditorInterface.transform_requested.connect(SimRuntime.transform_requested.emit)
	EditorInterface.transform_commited.connect(SimRuntime.transform_commited.emit)


func _exit_tree() -> void:
	EditorInterface.simulation_started.disconnect(SimRuntime.simulation_started.emit)
	EditorInterface.simulation_stopped.disconnect(SimRuntime.simulation_stopped.emit)
	EditorInterface.simulation_pause_toggled.disconnect(SimRuntime.simulation_pause_toggled.emit)
	EditorInterface.transform_requested.disconnect(SimRuntime.transform_requested.emit)
	EditorInterface.transform_commited.disconnect(SimRuntime.transform_commited.emit)
