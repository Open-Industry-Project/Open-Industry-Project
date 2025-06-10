@tool
class_name RunBar
extends PanelContainer

@onready var play_button: Button = $HBoxContainer/Play
@onready var pause_button: Button = $HBoxContainer/Pause
@onready var stop_button: Button = $HBoxContainer/Stop
var clear_output_btn: Button

var play = false
var pause = true
var stop = true


func _ready() -> void:
	if not ProjectSettings.get_setting("addons/Open Industry Project/Output/Clear on Simulation Start"):
		ProjectSettings.set_setting("addons/Open Industry Project/Output/Clear on Simulation Start", false)

	ProjectSettings.set_as_basic("addons/Open Industry Project/Output/Clear on Simulation Start", true)
	
	play_button.icon = get_theme_icon("Play", "EditorIcons")
	pause_button.icon = get_theme_icon("Pause", "EditorIcons")
	stop_button.icon = get_theme_icon("Stop", "EditorIcons")

	clear_output_btn = get_tree().root.get_child(0).get_child(4).get_child(0).get_child(1).get_child(1).get_child(1).get_child(0).get_child(0).get_child(1).get_child(0).get_child(0).get_child(2).get_child(0).get_child(0)

	SimulationEvents.simulation_started.connect(func() -> void:
		SimulationEvents.simulation_running = true
		PhysicsServer3D.set_active(true)
		play_button.disabled = true
		pause_button.disabled = false
		stop_button.disabled = false
		play = true
		pause = false
		stop = false
	)
	SimulationEvents.simulation_ended.connect(func() -> void:
		SimulationEvents.simulation_running = false
		PhysicsServer3D.set_active(false)
		play_button.disabled = false
		pause_button.disabled = true
		stop_button.disabled = true
		play = false
		pause = true
		stop = true
	)

	play_button.pressed.connect(_on_play_pressed)
	pause_button.toggled.connect(_on_pause_toggled)
	stop_button.pressed.connect(_on_stop_pressed)


func _on_play_pressed() -> void:
	pause_button.button_pressed = false
	play = false
	SimulationEvents.start_simulation()


func _on_pause_toggled(pressed: bool) -> void:
	SimulationEvents.toggle_pause_simulation(pressed)


func _on_stop_pressed() -> void:
	pause_button.button_pressed = false
	pause = false
	SimulationEvents.stop_simulation()


# Legacy methods - kept for compatibility but delegate to SimulationEvents
func start_simulation() -> void:
	SimulationEvents.start_simulation()


func toggle_pause_simulation(pressed: bool) -> void:
	SimulationEvents.toggle_pause_simulation(pressed)


func stop_simulation() -> void:
	SimulationEvents.stop_simulation()


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
