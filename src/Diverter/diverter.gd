@tool
class_name Diverter
extends Node3D

## Button to trigger a divert action in the editor.
@export_tool_button("Divert") var divert_action = divert
## Time in seconds for the diverter to complete its motion.
@export_custom(PROPERTY_HINT_NONE, "suffix:s") var divert_time: float = 0.25
## Distance the diverter arm travels during activation.
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var divert_distance: float = 0.75

var size: Vector3 = Vector3(0.722, 1.2, 2.127)

var _fire_divert: bool = false:
	set(value):
		_fire_divert = value
		await get_tree().create_timer(0.3).timeout
		_fire_divert = false

var _cycled: bool = true
var _diverting: bool = false
var _previous_fire_divert_state: bool = false
var _tag := OIPCommsTag.new()
@onready var _diverter_animator: DiverterAnimator = $DiverterAnimator

@export_category("Communications")
## Enable communication with external PLC/control systems.
@export var enable_comms: bool = false
@export var tag_group_name: String
## The tag group for reading divert commands from external systems.
@export_custom(0, "tag_group_enum") var tag_groups:
	set(value):
		tag_group_name = value
		tag_groups = value
## The tag name for the divert trigger in the selected tag group.[br]Datatype: [code]BOOL[/code][br][br]Format varies by protocol:[br][b]EIP:[/b] CIP tag names[br][b]Modbus:[/b] prefix+number (e.g. [code]co0[/code])[br][b]OPC UA:[/b] full NodeId (e.g. [code]ns=2;s=MyVariable[/code] or [code]ns=2;i=12345[/code]).
@export var tag_name: String = ""

func _validate_property(property: Dictionary) -> void:
	OIPCommsSetup.validate_tag_property(property)

func _enter_tree() -> void:
	tag_group_name = OIPCommsSetup.default_tag_group(tag_group_name)
	SimulationManager.simulation_started.connect(_on_simulation_started)
	OIPCommsSetup.connect_comms(self, _tag_group_initialized, _tag_group_polled)

func _exit_tree() -> void:
	SimulationManager.simulation_started.disconnect(_on_simulation_started)
	OIPCommsSetup.disconnect_comms(self, _tag_group_initialized, _tag_group_polled)

func use() -> void:
	divert()

func divert() -> void:
	_fire_divert = true

func _physics_process(delta: float) -> void:
	if _fire_divert and not _previous_fire_divert_state:
		_diverting = true
		_cycled = false

	if _diverting and not _cycled:
		_diverter_animator.fire(divert_time, divert_distance)
		_diverting = false
		_cycled = true

	_previous_fire_divert_state = _fire_divert

func _on_simulation_started() -> void:
	if enable_comms:
		_tag.register(tag_group_name, tag_name)

func _tag_group_initialized(tag_group_name_param: String) -> void:
	if _tag.on_group_initialized(tag_group_name_param):
		_tag.write_bit(_fire_divert)

func _tag_group_polled(tag_group_name_param: String) -> void:
	if not enable_comms or not _tag.matches_group(tag_group_name_param):
		return
	_fire_divert = _tag.read_bit()
