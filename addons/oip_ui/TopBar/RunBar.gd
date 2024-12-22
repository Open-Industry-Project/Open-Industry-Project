@tool
extends PanelContainer

@onready var play_button: Button = $HBoxContainer/Play
@onready var pause_button: Button = $HBoxContainer/Pause
@onready var stop_button: Button = $HBoxContainer/Stop

var clear_output_btn : Button

var play = false
var pause = true
var stop = true

func start_simulation() -> void:
	pause_button.button_pressed = false
	play = false
	SimulationEvents.simulation_set_paused.emit(false)
	SimulationEvents.simulation_started.emit()
	if(EditorInterface.has_method("set_simulation_started")):
		EditorInterface.call("set_simulation_started",true)

func toggle_pause_simulation(pressed: bool) -> void:
	SimulationEvents.simulation_paused = !SimulationEvents.simulation_paused
	SimulationEvents.simulation_set_paused.emit(pressed)
	if SimulationEvents.simulation_paused:
		get_tree().edited_scene_root.process_mode = Node.PROCESS_MODE_DISABLED
	else:
		get_tree().edited_scene_root.process_mode = Node.PROCESS_MODE_INHERIT
		
func stop_simulation() -> void:
	pause_button.button_pressed = false
	pause = false
	SimulationEvents.simulation_set_paused.emit(false)
	SimulationEvents.simulation_ended.emit()
	if(EditorInterface.has_method("set_simulation_started")):
		EditorInterface.call("set_simulation_started",false)

func _disable_buttons() -> void:
	PhysicsServer3D.set_active(false)
	play_button.disabled = true
	pause_button.disabled = true
	stop_button.disabled = true

func _enable_buttons() -> void:
	PhysicsServer3D.set_active(play)
	play_button.disabled = play
	pause_button.disabled = pause
	stop_button.disabled = stop

func _ready() -> void:
	if not ProjectSettings.get_setting("addons/Open Industry Project/Output/Clear on Simulation Start"):
		ProjectSettings.set_setting("addons/Open Industry Project/Output/Clear on Simulation Start", false)

	ProjectSettings.set_as_basic("addons/Open Industry Project/Output/Clear on Simulation Start",true)

	clear_output_btn = get_tree().root.get_child(0).get_child(4).get_child(0).get_child(1).get_child(1).get_child(1).get_child(0).get_child(0).get_child(1).get_child(0).get_child(0).get_child(2).get_child(0).get_child(0)

	get_tree().paused = false

	SimulationEvents.simulation_started.connect(func () -> void:
		SimulationEvents.simulation_running = true
		PhysicsServer3D.set_active(true)
		play_button.disabled = true
		pause_button.disabled = false
		stop_button.disabled = false
		play = true
		pause = false
		stop = false
	)
	SimulationEvents.simulation_ended.connect(func () -> void:
		SimulationEvents.simulation_running = false
		PhysicsServer3D.set_active(false)
		play_button.disabled = false
		pause_button.disabled = true
		stop_button.disabled = true
		play = false
		pause = true
		stop = true
	)

	play_button.pressed.connect(start_simulation)
	pause_button.toggled.connect(toggle_pause_simulation)
	stop_button.pressed.connect(stop_simulation)
