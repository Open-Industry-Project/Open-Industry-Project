@tool
extends Node

signal simulation_started
signal simulation_set_paused(paused)
signal simulation_ended

var simulation_running: bool = false
var simulation_paused: bool = false
var selected_nodes: Array[Node]


func _enter_tree() -> void:
	if not Engine.is_editor_hint():
		return

	EditorInterface.get_selection().selection_changed.connect(_on_selection_changed)

	var editor_settings := EditorInterface.get_editor_settings()

	var use_shortcut := Shortcut.new()
	var key_stroke := InputEventKey.new()
	key_stroke.keycode = KEY_C
	use_shortcut.events.append(key_stroke)
	editor_settings.add_shortcut("Open Industry Project/Use", use_shortcut)

	var snap_shortcut := Shortcut.new()
	var snap_key_stroke := InputEventKey.new()
	snap_key_stroke.keycode = KEY_C
	snap_key_stroke.ctrl_pressed = true
	snap_key_stroke.shift_pressed = true
	snap_shortcut.events.append(snap_key_stroke)
	editor_settings.add_shortcut("Open Industry Project/Snap Conveyor", snap_shortcut)

	EditorInterface.simulation_started.connect(_on_engine_simulation_started)
	EditorInterface.simulation_stopped.connect(_on_engine_simulation_stopped)
	EditorInterface.simulation_pause_toggled.connect(_on_engine_simulation_pause_toggled)


func _ready() -> void:
	if is_instance_valid(owner):
		await owner.ready

		EditorInterface.set_main_screen_editor("3D")
		EditorInterface.open_scene_from_path("res://Main/Main.tscn")

	get_tree().paused = false


func _process(delta: float) -> void:
	_select_nodes()


func _input(event: InputEvent) -> void:
	if not Engine.is_editor_hint():
		return

	var editor_settings := EditorInterface.get_editor_settings()

	if editor_settings.is_shortcut("Open Industry Project/Use", event) and event.is_pressed() and not event.is_echo():
		var selection := EditorInterface.get_selection()
		for node: Node in selection.get_selected_nodes():
			if(node.has_method("use")):
				node.call("use")

	if editor_settings.is_shortcut("Open Industry Project/Snap Conveyor", event) and event.is_pressed() and not event.is_echo():
		ConveyorSnapping.snap_selected_conveyors()


func _on_engine_simulation_started() -> void:
	simulation_running = true
	simulation_paused = false
	PhysicsServer3D.set_active(true)
	simulation_set_paused.emit(false)
	simulation_started.emit()


func _on_engine_simulation_stopped() -> void:
	simulation_running = false
	simulation_paused = false
	PhysicsServer3D.set_active(false)
	simulation_set_paused.emit(false)
	simulation_ended.emit()


func _on_engine_simulation_pause_toggled(paused: bool) -> void:
	simulation_paused = paused
	simulation_set_paused.emit(paused)
	var root := get_tree().edited_scene_root
	if root:
		if simulation_paused:
			root.process_mode = Node.PROCESS_MODE_DISABLED
		else:
			root.process_mode = Node.PROCESS_MODE_INHERIT


func stop_simulation() -> void:
	EditorInterface.stop_simulation()


func start_simulation() -> void:
	EditorInterface.start_simulation()


func toggle_pause_simulation() -> void:
	EditorInterface.toggle_pause_simulation()


func _on_selection_changed() -> void:
	selected_nodes = EditorInterface.get_selection().get_selected_nodes()
	_select_nodes()


func _select_nodes() -> void:
	if selected_nodes.size() > 0:
		for node: Node in selected_nodes:
			if(!node):
				return

			if node.has_method("selected"):
				node.call("selected")
