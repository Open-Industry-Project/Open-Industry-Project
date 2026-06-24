@tool
extends Node3D

const DEFAULT_SIZE := 0.5
const GENERATED_CUPS_NAME := "GeneratedCups"

@export var tool_size_x: float = 0.5:
	set(value):
		tool_size_x = maxf(value, 0.5)
		_rebuild()

@export var tool_size_z: float = 0.5:
	set(value):
		tool_size_z = maxf(value, 0.5)
		_rebuild()

@export var cup_pitch_x: float = 0.1:
	set(value):
		cup_pitch_x = maxf(value, 0.01)
		_rebuild()

@export var cup_pitch_z: float = 0.1:
	set(value):
		cup_pitch_z = maxf(value, 0.01)
		_rebuild()

@export var cup_margin_x: float = 0.05:
	set(value):
		cup_margin_x = maxf(value, 0.0)
		_rebuild()

@export var cup_margin_z: float = 0.05:
	set(value):
		cup_margin_z = maxf(value, 0.0)
		_rebuild()

@export var cups_enabled: bool = true:
	set(value):
		cups_enabled = value
		_rebuild()

@export var rail_b_use_v_for_length: bool = false:
	set(value):
		rail_b_use_v_for_length = value
		_rebuild()

var _attachment: Node3D
var _planes: Node3D
var _rail_a_01: Node3D
var _rail_a_02: Node3D
var _rail_b_01: Node3D
var _rail_b_02: Node3D
var _cap_01: Node3D
var _cap_02: Node3D
var _cap_03: Node3D
var _cap_04: Node3D
var _cup_template: Node3D
var _generated_cups: Node3D

var _cap_01_base: Vector3
var _cap_02_base: Vector3
var _cap_03_base: Vector3
var _cap_04_base: Vector3
var _rail_a_01_base: Vector3
var _rail_a_02_base: Vector3
var _rail_b_01_base: Vector3
var _rail_b_02_base: Vector3
var _planes_base: Vector3
var _cup_base: Vector3

var _setup_done: bool = false


func _ready() -> void:
	_setup_refs()
	_capture_base_positions()
	_rebuild()


func _setup_refs() -> void:
	_attachment = get_node_or_null("Attachment") as Node3D
	if not _attachment:
		return

	_cap_01 = _attachment.get_node_or_null("Cap_01") as Node3D
	_cap_02 = _attachment.get_node_or_null("Cap_02") as Node3D
	_cap_03 = _attachment.get_node_or_null("Cap_03") as Node3D
	_cap_04 = _attachment.get_node_or_null("Cap_04") as Node3D
	_planes = _attachment.get_node_or_null("Planes") as Node3D
	_rail_b_01 = _attachment.get_node_or_null("Rail_B_01") as Node3D
	_rail_b_02 = _attachment.get_node_or_null("Rail_B_02") as Node3D
	_rail_a_01 = _attachment.get_node_or_null("Rail_A_01") as Node3D
	_rail_a_02 = _attachment.get_node_or_null("Rail_A_02") as Node3D
	_cup_template = _attachment.get_node_or_null("SuctionCup_01") as Node3D

	_generated_cups = _attachment.get_node_or_null(GENERATED_CUPS_NAME) as Node3D
	if not _generated_cups:
		_generated_cups = Node3D.new()
		_generated_cups.name = GENERATED_CUPS_NAME
		_attachment.add_child(_generated_cups)
		if Engine.is_editor_hint():
			_generated_cups.owner = get_tree().edited_scene_root

	_setup_done = true


func _capture_base_positions() -> void:
	if not _setup_done:
		return

	if _cap_01:
		_cap_01_base = _cap_01.position
	if _cap_02:
		_cap_02_base = _cap_02.position
	if _cap_03:
		_cap_03_base = _cap_03.position
	if _cap_04:
		_cap_04_base = _cap_04.position

	if _rail_a_01:
		_rail_a_01_base = _rail_a_01.position
	if _rail_a_02:
		_rail_a_02_base = _rail_a_02.position
	if _rail_b_01:
		_rail_b_01_base = _rail_b_01.position
	if _rail_b_02:
		_rail_b_02_base = _rail_b_02.position

	if _planes:
		_planes_base = _planes.position
	if _cup_template:
		_cup_base = _cup_template.position


func _rebuild() -> void:
	if not is_node_ready():
		return

	if not _setup_done:
		_setup_refs()
		_capture_base_positions()

	if not _attachment:
		return

	var x_ratio: float = tool_size_x / DEFAULT_SIZE
	var z_ratio: float = tool_size_z / DEFAULT_SIZE

	_apply_axis_scale(_planes, true, false, true, x_ratio, 1.0, z_ratio)

	_apply_axis_scale(_rail_a_01, true, false, false, x_ratio, 1.0, 1.0)
	_apply_axis_scale(_rail_a_02, true, false, false, x_ratio, 1.0, 1.0)

	_apply_axis_scale(_rail_b_01, false, false, true, 1.0, 1.0, z_ratio)
	_apply_axis_scale(_rail_b_02, false, false, true, 1.0, 1.0, z_ratio)

	_apply_uv_tiling(_planes, x_ratio, z_ratio)

	_apply_uv_tiling(_rail_a_01, x_ratio, 1.0)
	_apply_uv_tiling(_rail_a_02, x_ratio, 1.0)

	if rail_b_use_v_for_length:
		_apply_uv_tiling(_rail_b_01, 1.0, z_ratio)
		_apply_uv_tiling(_rail_b_02, 1.0, z_ratio)
	else:
		_apply_uv_tiling(_rail_b_01, z_ratio, 1.0)
		_apply_uv_tiling(_rail_b_02, z_ratio, 1.0)

	_reposition_parts()
	_rebuild_cups()


func _apply_axis_scale(node: Node3D, use_x: bool, use_y: bool, use_z: bool, x_value: float, y_value: float, z_value: float) -> void:
	if not node:
		return

	var s := node.scale
	if use_x:
		s.x = x_value
	if use_y:
		s.y = y_value
	if use_z:
		s.z = z_value
	node.scale = s


func _apply_uv_tiling(node: Node3D, u_value: float, v_value: float = 1.0) -> void:
	if not node:
		return

	if node.has_method("set_tiling_multipliers"):
		node.call("set_tiling_multipliers", u_value, v_value)


func _reposition_parts() -> void:
	var half_x: float = tool_size_x * 0.5
	var half_z: float = tool_size_z * 0.5

	if _cap_01:
		_cap_01.position = Vector3(-half_x, _cap_01_base.y, -half_z)
	if _cap_02:
		_cap_02.position = Vector3(half_x, _cap_02_base.y, -half_z)
	if _cap_03:
		_cap_03.position = Vector3(-half_x, _cap_03_base.y, half_z)
	if _cap_04:
		_cap_04.position = Vector3(half_x, _cap_04_base.y, half_z)

	if _rail_a_01:
		_rail_a_01.position = Vector3(0.0, _rail_a_01_base.y, -half_z)
	if _rail_a_02:
		_rail_a_02.position = Vector3(0.0, _rail_a_02_base.y, half_z)

	if _rail_b_01:
		_rail_b_01.position = Vector3(-half_x, _rail_b_01_base.y, 0.0)
	if _rail_b_02:
		_rail_b_02.position = Vector3(half_x, _rail_b_02_base.y, 0.0)

	if _planes:
		_planes.position = Vector3(0.0, _planes_base.y, 0.0)


func _rebuild_cups() -> void:
	if not _generated_cups:
		return

	for child in _generated_cups.get_children():
		_generated_cups.remove_child(child)
		child.queue_free()

	if not cups_enabled or not _cup_template:
		if _cup_template:
			_cup_template.visible = false
		return

	_cup_template.visible = false

	var usable_x: float = maxf(tool_size_x - cup_margin_x * 2.0, 0.0)
	var usable_z: float = maxf(tool_size_z - cup_margin_z * 2.0, 0.0)

	var count_x: int = maxi(1, int(usable_x / cup_pitch_x) + 1)
	var count_z: int = maxi(1, int(usable_z / cup_pitch_z) + 1)

	var start_x: float = -usable_x * 0.5
	var start_z: float = -usable_z * 0.5

	for ix in range(count_x):
		for iz in range(count_z):
			var cup := _cup_template.duplicate()
			cup.name = "SuctionCup_%d_%d" % [ix + 1, iz + 1]

			var px: float = 0.0 if count_x == 1 else start_x + ix * (usable_x / float(count_x - 1))
			var pz: float = 0.0 if count_z == 1 else start_z + iz * (usable_z / float(count_z - 1))

			cup.position = Vector3(px, _cup_base.y, pz)
			cup.visible = true
			_generated_cups.add_child(cup)

			if Engine.is_editor_hint():
				cup.owner = get_tree().edited_scene_root
