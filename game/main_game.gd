extends Node3D
## Main game controller — bootstraps the standalone simulation experience.
##
## Instantiates the building environment, camera, HUD, and the placement /
## selection systems, then wires them together so that equipment can be placed,
## selected, moved, rotated and deleted entirely in-game.

const GameCameraScript := preload("res://game/game_camera.gd")
const GameHUDScript := preload("res://game/ui/game_hud.gd")
const PlacementSystemScript := preload("res://game/systems/placement_system.gd")
const SelectionSystemScript := preload("res://game/systems/selection_system.gd")

# Scene references created at runtime.
var _camera: Camera3D
var _hud: Control
var _placement: Node3D       # PlacementSystem
var _selection: Node          # SelectionSystem
var _simulation_root: Node3D
var _building: Node3D

var _paused: bool = false


func _ready() -> void:
	_setup_environment()
	_setup_camera()
	_setup_simulation_root()
	_setup_systems()
	_setup_ui()
	_connect_signals()


# ── Scene setup ──────────────────────────────────────────────────────────────

func _setup_environment() -> void:
	# Instantiate the warehouse building.
	var building_scene := load("res://parts/Building.tscn") as PackedScene
	if building_scene:
		_building = building_scene.instantiate()
		add_child(_building)


func _setup_camera() -> void:
	_camera = Camera3D.new()
	_camera.set_script(GameCameraScript)
	_camera.current = true
	add_child(_camera)


func _setup_simulation_root() -> void:
	# All placed equipment goes under this node.
	_simulation_root = Node3D.new()
	_simulation_root.name = "SimulationRoot"
	add_child(_simulation_root)


func _setup_systems() -> void:
	# Placement system (ghost preview + click-to-place).
	_placement = Node3D.new()
	_placement.name = "PlacementSystem"
	_placement.set_script(PlacementSystemScript)
	add_child(_placement)
	_placement.setup(_camera, _simulation_root)

	# Selection system (click-to-select + move / rotate / delete).
	_selection = Node.new()
	_selection.name = "SelectionSystem"
	_selection.set_script(SelectionSystemScript)
	add_child(_selection)
	_selection.setup(_camera, _simulation_root)


func _setup_ui() -> void:
	var canvas := CanvasLayer.new()
	canvas.name = "UILayer"
	add_child(canvas)

	_hud = Control.new()
	_hud.name = "GameHUD"
	_hud.set_script(GameHUDScript)
	_hud.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	canvas.add_child(_hud)


# ── Signal wiring ────────────────────────────────────────────────────────────

func _connect_signals() -> void:
	# HUD → systems.
	_hud.part_selected.connect(_on_part_selected)
	_hud.mode_changed.connect(_on_mode_changed)
	_hud.simulation_pause_requested.connect(_on_pause_requested)

	# Placement system → HUD feedback.
	_placement.object_placed.connect(_on_object_placed)
	_placement.placement_cancelled.connect(_on_placement_cancelled)

	# Selection system → HUD feedback.
	_selection.selection_changed.connect(_on_selection_changed)


# ── Callbacks ────────────────────────────────────────────────────────────────

func _on_part_selected(scene_path: String) -> void:
	# Switch to placement mode.
	_selection.deselect()
	_placement.activate(scene_path)


func _on_mode_changed(mode: String) -> void:
	if mode != "place":
		_placement.deactivate()


func _on_object_placed(_instance: Node3D) -> void:
	_hud.set_status("Object placed! Click another part or right-click to stop placing.")


func _on_placement_cancelled() -> void:
	_hud.set_mode("select")
	_hud.set_status("Placement cancelled.")


func _on_selection_changed(selected: Node3D) -> void:
	if selected:
		_hud.set_status("Selected: %s  (G = move, R = rotate, Del = delete, Esc = deselect)" % selected.name)
	else:
		_hud.set_status("Click a part to place it, or click an object to select it.")


func _on_pause_requested() -> void:
	_paused = not _paused
	SimulationManager.set_paused(_paused)
	_hud.update_pause_button(_paused)
	_hud.set_status("Simulation %s." % ("paused" if _paused else "resumed"))


# ── Global input (keyboard shortcuts) ───────────────────────────────────────

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey:
		var key := event as InputEventKey
		if key.pressed and not key.echo:
			match key.keycode:
				KEY_TAB:
					# Toggle parts panel visibility.
					if _hud.has_node("PanelContainer"):
						pass  # handled inside HUD
				KEY_SPACE:
					_on_pause_requested()
					get_viewport().set_input_as_handled()
