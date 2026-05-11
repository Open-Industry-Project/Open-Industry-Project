@tool
class_name RollerConveyor
extends ResizableNode3D

signal width_changed(width: float)
signal length_changed(length: float)
signal roller_skew_angle_changed(skew_angle_degrees: float)
signal speed_changed(speed: float)
signal roller_override_material_changed(material: Material)

const CIRCUMFERENCE: float = 2.0 * PI * Roller.RADIUS
const ROLLERS_Y_OFFSET: float = -0.12
@export_custom(PROPERTY_HINT_NONE, "suffix:m/s") var speed: float = 1.0:
	set(value):
		if value == speed:
			return
		speed = value
		speed_changed.emit(value)
		_update_conveyor_velocity()

		if _running_tag.is_ready():
			_running_tag.write_bit(value != 0.0)

## Roller skew angle for angled product movement.
@export_range(-60, 60, 1, "degrees") var skew_angle: float = 0.0:
	set(value):
		if skew_angle != value:
			skew_angle = value
			roller_skew_angle_changed.emit(skew_angle)
			_update_conveyor_velocity()
			_update_transfer_plates()

@export_category("Communications")
@export var enable_comms: bool = false
@export var speed_tag_group_name: String
@export_custom(0, "tag_group_enum") var speed_tag_groups: String:
	set(value):
		speed_tag_group_name = value
		speed_tag_groups = value
## The tag name for the speed value in the selected tag group.[br]Datatype: [code]REAL[/code] (32-bit float)[br][br]Format varies by protocol:[br][b]EIP:[/b] CIP tag names[br][b]Modbus:[/b] prefix+number (e.g. [code]hr0[/code])[br][b]OPC UA:[/b] full NodeId (e.g. [code]ns=2;s=MyVariable[/code] or [code]ns=2;i=12345[/code]).
@export var speed_tag_name: String = ""
@export var running_tag_group_name: String
@export_custom(0, "tag_group_enum") var running_tag_groups: String:
	set(value):
		running_tag_group_name = value
		running_tag_groups = value
## The tag name for the running state in the selected tag group.[br]Datatype: [code]BOOL[/code][br][br]Format varies by protocol:[br][b]EIP:[/b] CIP tag names[br][b]Modbus:[/b] prefix+number (e.g. [code]co0[/code])[br][b]OPC UA:[/b] full NodeId (e.g. [code]ns=2;s=MyVariable[/code] or [code]ns=2;i=12345[/code]).
@export var running_tag_name: String = ""


@export_group("Frame & Side Guards")
@export var left_side_guards_enabled: bool = true:
	set(value):
		if left_side_guards_enabled == value:
			return
		left_side_guards_enabled = value
		_request_side_guard_rebuild()
@export var right_side_guards_enabled: bool = true:
	set(value):
		if right_side_guards_enabled == value:
			return
		right_side_guards_enabled = value
		_request_side_guard_rebuild()
## Openings in conveyor-local X (origin-centered). arc-length == X (single-segment).
@export_storage var side_guard_openings: Array[SideGuardOpening] = []:
	set(value):
		side_guard_openings = value
		_request_side_guard_rebuild()

@export_group("Legs")
@export var legs_enabled: bool = true:
	set(value):
		if legs_enabled == value:
			return
		legs_enabled = value
		_request_legs_refresh()
## World-space plane the legs reach down to.
@export var floor_plane: Plane = Plane(Vector3.UP, -2.0):
	set(value):
		if floor_plane.is_equal_approx(value):
			return
		floor_plane = value
		_request_legs_refresh()
@export var leg_model_scene: PackedScene = preload("res://parts/ConveyorLeg.tscn"):
	set(value):
		leg_model_scene = value
		_request_legs_refresh()

@export_subgroup("Tail End", "tail_end")
@export var tail_end_leg_enabled: bool = true:
	set(value):
		if tail_end_leg_enabled == value:
			return
		tail_end_leg_enabled = value
		_request_legs_refresh()
@export_range(0.0, 1.0, 0.01, "or_greater", "suffix:m") var tail_end_attachment_offset: float = 0.45:
	set(value):
		if tail_end_attachment_offset == value:
			return
		tail_end_attachment_offset = maxf(0.0, value)
		_request_legs_refresh()
@export_range(0.0, 5.0, 0.01, "or_greater", "suffix:m") var tail_end_leg_clearance: float = 0.5:
	set(value):
		if tail_end_leg_clearance == value:
			return
		tail_end_leg_clearance = maxf(0.0, value)
		_request_legs_refresh()

@export_subgroup("Head End", "head_end")
@export var head_end_leg_enabled: bool = true:
	set(value):
		if head_end_leg_enabled == value:
			return
		head_end_leg_enabled = value
		_request_legs_refresh()
@export_range(0.0, 1.0, 0.01, "or_greater", "suffix:m") var head_end_attachment_offset: float = 0.45:
	set(value):
		if head_end_attachment_offset == value:
			return
		head_end_attachment_offset = maxf(0.0, value)
		_request_legs_refresh()
@export_range(0.0, 5.0, 0.01, "or_greater", "suffix:m") var head_end_leg_clearance: float = 0.5:
	set(value):
		if head_end_leg_clearance == value:
			return
		head_end_leg_clearance = maxf(0.0, value)
		_request_legs_refresh()

@export_subgroup("Middle Legs", "middle_legs")
@export var middle_legs_enabled: bool = true:
	set(value):
		if middle_legs_enabled == value:
			return
		middle_legs_enabled = value
		_request_legs_refresh()
@export_range(0.5, 10.0, 0.05, "or_greater", "suffix:m") var middle_legs_spacing: float = 2.0:
	set(value):
		var clamped: float = maxf(0.5, value)
		if middle_legs_spacing == clamped:
			return
		middle_legs_spacing = clamped
		_request_legs_refresh()

@export_subgroup("Leg Exclusion Zone", "exclusion_")
## Skip legs in [code][tail + exclusion_start, tail + exclusion_end][/code]; both 0 disables.
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var exclusion_start: float = 0.0:
	set(value):
		if exclusion_start == value:
			return
		exclusion_start = value
		_request_legs_refresh()
@export_custom(PROPERTY_HINT_NONE, "suffix:m") var exclusion_end: float = 0.0:
	set(value):
		if exclusion_end == value:
			return
		exclusion_end = value
		_request_legs_refresh()


var running: bool = false:
	set(value):
		running = value
		set_physics_process(running)

var _speed_tag := OIPCommsTag.new()
var _running_tag := OIPCommsTag.new()

var _flow_arrow: Node3D
var _last_size: Vector3 = Vector3(1.525, 0.5, 1.524)
var _last_length: float = 1.525
var _last_width: float = 1.524
var _metal_material: Material
var _rollers: Rollers
var _ends: Node3D
var _roller_material: BaseMaterial3D
var _simple_conveyor_shape: StaticBody3D
var _transfer_plate_discharge: MeshInstance3D
var _transfer_plate_infeed: MeshInstance3D
var _transfer_plate_discharge_opp: MeshInstance3D
var _transfer_plate_infeed_opp: MeshInstance3D
var _transfer_plate_material: StandardMaterial3D
var _shadow_plate: MeshInstance3D
var _side_guards: Array[SideGuard] = []
var _legs: Array[Node3D] = []
var _side_guard_rebuild_pending: bool = false
var _legs_refresh_pending: bool = false
const _MIN_GUARD_LEN: float = 0.05
const _LEG_TAIL_NAME := "Leg_Tail"
const _LEG_HEAD_NAME := "Leg_Head"
const _LEG_MIDDLE_PREFIX := "Leg_Middle_"


func _get_custom_preview_node() -> Node3D:
	var preview_scene := load("res://parts/RollerConveyor.tscn") as PackedScene
	var preview_node := preview_scene.instantiate(PackedScene.GEN_EDIT_STATE_DISABLED) as Node3D
	preview_node.set_meta("is_preview", true)

	_disable_collisions_recursive(preview_node)

	preview_node.add_child(FlowDirectionArrow.create(preview_node.size))

	return preview_node


func _disable_collisions_recursive(node: Node) -> void:
	if node is CollisionShape3D:
		node.disabled = true

	if node is CollisionObject3D:
		node.collision_layer = 0
		node.collision_mask = 0

	for child in node.get_children():
		_disable_collisions_recursive(child)


func _init() -> void:
	super._init()
	size_default = Vector3(4, 0.5, 1.524)


func _enter_tree() -> void:
	super._enter_tree()

	speed_tag_group_name = OIPCommsSetup.default_tag_group(speed_tag_group_name)
	running_tag_group_name = OIPCommsSetup.default_tag_group(running_tag_group_name)
	if Engine.is_editor_hint():
		EditorInterface.simulation_started.connect(_on_simulation_started)
		EditorInterface.simulation_stopped.connect(_on_simulation_ended)
		running = EditorInterface.is_simulation_running()

	OIPCommsSetup.connect_comms(self, _tag_group_initialized, _tag_group_polled)


func _validate_property(property: Dictionary) -> void:
	if OIPCommsSetup.validate_tag_property(property, "speed_tag_group_name", "speed_tag_groups", "speed_tag_name"):
		return
	OIPCommsSetup.validate_tag_property(property, "running_tag_group_name", "running_tag_groups", "running_tag_name")


func _exit_tree() -> void:
	if _flow_arrow:
		FlowDirectionArrow.unregister(_flow_arrow)
	if Engine.is_editor_hint():
		if EditorInterface.simulation_started.is_connected(_on_simulation_started):
			EditorInterface.simulation_started.disconnect(_on_simulation_started)
		if EditorInterface.simulation_stopped.is_connected(_on_simulation_ended):
			EditorInterface.simulation_stopped.disconnect(_on_simulation_ended)

	OIPCommsSetup.disconnect_comms(self, _tag_group_initialized, _tag_group_polled)

	super._exit_tree()


func _ready() -> void:
	_clear_stale_snap_metas()
	_reset_preview_holder_transform()
	_setup_conveyor_physics()
	_setup_collision_shape()
	_setup_roller_initialization()
	_setup_material()
	_setup_shadow_plate()
	_setup_transfer_plates()
	_last_size = Vector3.ZERO
	_on_size_changed()
	_update_flow_arrow()
	SideGuardOpening.claim_unique(side_guard_openings, get_instance_id())
	_rebuild_side_guards()
	_rebuild_legs()
	_bind_snap_meta_now()


func _reset_preview_holder_transform() -> void:
	if not has_meta("is_preview"):
		return
	var holder := get_parent() as Node3D
	if holder == null:
		return
	holder.transform = Transform3D.IDENTITY


func _notification(what: int) -> void:
	if what == NOTIFICATION_TRANSFORM_CHANGED:
		_request_legs_refresh()


func _clear_stale_snap_metas() -> void:
	if not Engine.is_editor_hint():
		return
	var edited_root := EditorInterface.get_edited_scene_root()
	if edited_root != null and self != edited_root and not edited_root.is_ancestor_of(self):
		return
	const STALE: PackedStringArray = [
		"_snap_transform",
		"_snap_baseline_reverse",
		"_snap_baseline_floor_plane",
		"_snap_baseline_legs_xform",
		"_snap_flip_decision",
	]
	for key: String in STALE:
		if has_meta(key):
			remove_meta(key)


func _bind_snap_meta_now() -> void:
	if not Engine.is_editor_hint() or ConveyorLiveSnap.instance == null:
		return
	var edited_root := EditorInterface.get_edited_scene_root()
	if edited_root == null:
		return
	if self != edited_root and not edited_root.is_ancestor_of(self):
		return
	ConveyorLiveSnap.instance.bind_snap_meta(self)


func _collision_repositioned(collision_point: Vector3, collision_normal: Vector3) -> void:
	if collision_normal == Vector3.ZERO:
		return
	var new_plane: Plane = Plane(collision_normal, collision_point)
	if floor_plane.is_equal_approx(new_plane):
		return
	floor_plane = new_plane


func _collision_repositioned_save() -> Variant:
	return floor_plane


func _collision_repositioned_undo(saved: Variant) -> void:
	if saved is Plane:
		floor_plane = saved


func _update_flow_arrow() -> void:
	if _flow_arrow:
		FlowDirectionArrow.unregister(_flow_arrow)
		_flow_arrow.queue_free()
		_flow_arrow = null
	_flow_arrow = FlowDirectionArrow.create(size)
	add_child(_flow_arrow, false, Node.INTERNAL_MODE_FRONT)
	FlowDirectionArrow.register(_flow_arrow)


func _physics_process(_delta: float) -> void:
	if running and _roller_material:
		var roller_speed := speed / cos(deg_to_rad(skew_angle)) if absf(skew_angle) < 89.0 else speed
		_roller_material.uv1_offset.x = fmod(_roller_material.uv1_offset.x + roller_speed * _delta / CIRCUMFERENCE, 1.0)


func set_roller_override_material(material: Material) -> void:
	_roller_material = material as BaseMaterial3D
	roller_override_material_changed.emit(material)


func _setup_shadow_plate() -> void:
	_shadow_plate = get_node_or_null("ShadowPlate")
	if not _shadow_plate:
		_shadow_plate = MeshInstance3D.new()
		_shadow_plate.name = "ShadowPlate"
		_shadow_plate.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_SHADOWS_ONLY
		add_child(_shadow_plate)


func _setup_material() -> void:
	_metal_material = ConveyorFrameMesh.create_material()




func _setup_roller_initialization() -> void:
	set_roller_override_material(load("res://assets/3DModels/Materials/Metall2.tres").duplicate(true))

	_rollers = get_node_or_null("Rollers")
	_ends = get_node_or_null("Ends")

	if _rollers:
		_setup_roller_container(_rollers)

	if _ends:
		for end in _ends.get_children():
			if end is RollerConveyorEnd:
				_setup_roller_container(end)


func _setup_roller_container(container: AbstractRollerContainer) -> void:
	if container == null:
		return

	container.roller_added.connect(_on_roller_added)
	container.roller_removed.connect(_on_roller_removed)

	roller_skew_angle_changed.connect(container.set_roller_skew_angle)
	width_changed.connect(container.set_width)
	length_changed.connect(container.set_length)

	container.setup_existing_rollers()
	container.set_roller_skew_angle(skew_angle)
	container.set_width(size.z)
	container.set_length(size.x)


func _setup_conveyor_physics() -> void:
	_simple_conveyor_shape = get_node_or_null("SimpleConveyorShape") as StaticBody3D
	
	if _simple_conveyor_shape:
		var collision_shape := _simple_conveyor_shape.get_node_or_null("CollisionShape3D") as CollisionShape3D
		if collision_shape and collision_shape.shape is BoxShape3D:
			var box_shape := collision_shape.shape as BoxShape3D
			box_shape.size = size
		
		var physics_material := PhysicsMaterial.new()
		physics_material.friction = 0.8
		physics_material.rough = true
		_simple_conveyor_shape.physics_material_override = physics_material

		_update_conveyor_velocity()


func _setup_collision_shape() -> void:
	if _simple_conveyor_shape:
		var collision_shape := _simple_conveyor_shape.get_node_or_null("CollisionShape3D") as CollisionShape3D
		if collision_shape and collision_shape.shape:
			collision_shape.shape = collision_shape.shape.duplicate() as BoxShape3D


func _update_component_positions() -> void:
	var conv_roller := get_node_or_null("ConvRoller")
	if conv_roller:
		var frame_height := size.y

		conv_roller.scale = Vector3.ONE
		conv_roller.position = Vector3(0, -frame_height, 0)
		var left_side := conv_roller.get_node_or_null("ConvRollerL") as MeshInstance3D
		var right_side := conv_roller.get_node_or_null("ConvRollerR") as MeshInstance3D
		if left_side and right_side:
			left_side.visible = true
			right_side.visible = true
			var frame_mesh := ConveyorFrameMesh.create(size.x, frame_height)
			if _metal_material:
				frame_mesh.surface_set_material(0, _metal_material)
			left_side.mesh = frame_mesh
			right_side.mesh = frame_mesh
			var half_width := size.z / 2.0
			var wt := ConveyorFrameMesh.WALL_THICKNESS
			left_side.position = Vector3(0, 0, -half_width - wt)
			left_side.rotation = Vector3.ZERO
			right_side.position = Vector3(0, 0, half_width + wt)
			right_side.rotation = Vector3(0, PI, 0)

	var rollers_node := get_node_or_null("Rollers")
	if rollers_node:
		rollers_node.position = Vector3(-size.x / 2.0 + 0.2, ROLLERS_Y_OFFSET, 0)
		rollers_node.scale = Vector3.ONE

	var ends_node := get_node_or_null("Ends")
	if ends_node:
		ends_node.position = Vector3(0, ROLLERS_Y_OFFSET - 0.16, 0)

		var end1 := ends_node.get_node_or_null("RollerConveyorEnd")
		var end2 := ends_node.get_node_or_null("RollerConveyorEnd2")

		var end_offset := 0.165
		if end1:
			end1.position = Vector3(size.x / 2.0 - end_offset, 0, 0)
			end1.rotation_degrees = Vector3(0, 0, 0)
			end1.scale = Vector3.ONE
		if end2:
			end2.position = Vector3(-size.x / 2.0 + end_offset, 0, 0)
			end2.rotation_degrees = Vector3(0, 180, 0)
			end2.scale = Vector3.ONE


func _update_width() -> void:
	var new_width := size.z
	if _last_width != new_width:
		width_changed.emit(new_width)
		_last_width = new_width


func _update_length() -> void:
	var new_length := size.x
	if _last_length != new_length:
		length_changed.emit(new_length)
		_last_length = new_length




func _update_conveyor_velocity() -> void:
	if not _simple_conveyor_shape:
		return

	if running and speed != 0.0:
		var local_x := _simple_conveyor_shape.global_transform.basis.x.normalized()
		var local_y := _simple_conveyor_shape.global_transform.basis.y.normalized()
		var angle_rad := deg_to_rad(skew_angle)
		var cos_a := cos(angle_rad)
		var adjusted_speed := speed / cos_a if absf(cos_a) > 1e-3 else speed
		var velocity := local_x.rotated(local_y, angle_rad) * adjusted_speed
		_simple_conveyor_shape.constant_linear_velocity = velocity
	else:
		_simple_conveyor_shape.constant_linear_velocity = Vector3.ZERO


func _on_size_changed() -> void:
	if _last_size != size:
		size_changed.emit()
		_last_size = size

		if _simple_conveyor_shape:
			var collision_shape := _simple_conveyor_shape.get_node_or_null("CollisionShape3D") as CollisionShape3D
			if collision_shape and collision_shape.shape is BoxShape3D:
				var box_shape := collision_shape.shape as BoxShape3D
				box_shape.size = size

		_update_width()
		_update_length()
		_update_component_positions()
		_update_transfer_plates()

		if _simple_conveyor_shape:
			_simple_conveyor_shape.position = Vector3(0, -size.y / 2.0, 0)

		if _shadow_plate:
			var box := BoxMesh.new()
			box.size = Vector3(size.x, 0.01, size.z)
			_shadow_plate.mesh = box
			_shadow_plate.position = Vector3(0, -size.y, 0)

		_update_flow_arrow()
		_rebuild_side_guards()
		_rebuild_legs()


func _on_roller_added(roller: Roller) -> void:
	roller_override_material_changed.connect(roller.set_roller_override_material)
	roller.set_roller_override_material(_roller_material)


func _on_roller_removed(roller: Roller) -> void:
	if roller_override_material_changed.is_connected(roller.set_roller_override_material):
		roller_override_material_changed.disconnect(roller.set_roller_override_material)


func _on_simulation_started() -> void:
	running = true
	_update_conveyor_velocity()
	if enable_comms:
		_speed_tag.register(speed_tag_group_name, speed_tag_name)
		_running_tag.register(running_tag_group_name, running_tag_name)


func _on_simulation_ended() -> void:
	running = false
	_update_conveyor_velocity()
	if _roller_material:
		_roller_material.uv1_offset = Vector3.ZERO


func _tag_group_initialized(tag_group_name_param: String) -> void:
	_speed_tag.on_group_initialized(tag_group_name_param)
	_running_tag.on_group_initialized(tag_group_name_param)


func _tag_group_polled(tag_group_name_param: String) -> void:
	if not enable_comms:
		return

	if _speed_tag.matches_group(tag_group_name_param):
		speed = _speed_tag.read_float32()


func _setup_transfer_plates() -> void:
	_transfer_plate_material = StandardMaterial3D.new()
	_transfer_plate_material.albedo_color = Color(0.337, 0.655, 0.784)
	_transfer_plate_material.albedo_texture = load("res://assets/3DModels/Textures/Metal.png")
	_transfer_plate_material.metallic = 0.8
	_transfer_plate_material.roughness = 0.3
	_transfer_plate_material.cull_mode = BaseMaterial3D.CULL_DISABLED

	_transfer_plate_discharge = _get_or_create_internal_child("TransferPlateDischarge")
	_transfer_plate_discharge.material_override = _transfer_plate_material

	_transfer_plate_infeed = _get_or_create_internal_child("TransferPlateInfeed")
	_transfer_plate_infeed.material_override = _transfer_plate_material

	_transfer_plate_discharge_opp = _get_or_create_internal_child("TransferPlateDischargeOpp")
	_transfer_plate_discharge_opp.material_override = _transfer_plate_material

	_transfer_plate_infeed_opp = _get_or_create_internal_child("TransferPlateInfeedOpp")
	_transfer_plate_infeed_opp.material_override = _transfer_plate_material


func _get_or_create_internal_child(child_name: String) -> MeshInstance3D:
	var node := get_node_or_null(child_name) as MeshInstance3D
	if not node:
		node = MeshInstance3D.new()
		node.name = child_name
		node.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		add_child(node, false, Node.INTERNAL_MODE_FRONT)
	return node


func _update_transfer_plates() -> void:
	var plates: Array[MeshInstance3D] = [
		_transfer_plate_discharge, _transfer_plate_infeed,
		_transfer_plate_discharge_opp, _transfer_plate_infeed_opp,
	]

	if plates.any(func(p: MeshInstance3D) -> bool: return p == null):
		return

	if absf(skew_angle) < 0.01:
		for plate in plates:
			plate.visible = false
		return

	var half_l := size.x / 2.0
	var half_w := size.z / 2.0
	var skew_rad := deg_to_rad(skew_angle)
	var plate_y := ROLLERS_Y_OFFSET + Roller.RADIUS
	var skew_zone := half_w * absf(tan(skew_rad))
	var x_start := half_l - skew_zone
	var z_sign := signf(skew_angle)
	var skirt_depth := Roller.RADIUS * 2.0

	for plate in plates:
		plate.visible = true

	_transfer_plate_discharge.mesh = _create_transfer_plate_mesh(
		Vector3(x_start, plate_y, z_sign * half_w),
		Vector3(half_l, plate_y, z_sign * half_w),
		Vector3(half_l, plate_y, 0.0),
		skirt_depth,
	)

	_transfer_plate_discharge_opp.mesh = _create_transfer_plate_mesh(
		Vector3(x_start, plate_y, -z_sign * half_w),
		Vector3(half_l, plate_y, -z_sign * half_w),
		Vector3(half_l, plate_y, 0.0),
		skirt_depth,
	)

	_transfer_plate_infeed.mesh = _create_transfer_plate_mesh(
		Vector3(-x_start, plate_y, -z_sign * half_w),
		Vector3(-half_l, plate_y, -z_sign * half_w),
		Vector3(-half_l, plate_y, 0.0),
		skirt_depth,
	)

	_transfer_plate_infeed_opp.mesh = _create_transfer_plate_mesh(
		Vector3(-x_start, plate_y, z_sign * half_w),
		Vector3(-half_l, plate_y, z_sign * half_w),
		Vector3(-half_l, plate_y, 0.0),
		skirt_depth,
	)


## Triangle (v1-v2-v3) plus vertical skirts hiding shortened roller ends.
static func _create_transfer_plate_mesh(
	v1: Vector3, v2: Vector3, v3: Vector3, skirt_depth: float
) -> ArrayMesh:
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)

	var v1_bottom := v1 - Vector3(0, skirt_depth, 0)
	var v2_bottom := v2 - Vector3(0, skirt_depth, 0)
	var v3_bottom := v3 - Vector3(0, skirt_depth, 0)

	_add_tri(st, v1, v3, v2)

	_add_tri(st, v1, v1_bottom, v3_bottom)
	_add_tri(st, v3_bottom, v3, v1)

	_add_tri(st, v2, v2_bottom, v3_bottom)
	_add_tri(st, v3_bottom, v3, v2)

	st.generate_normals()
	return st.commit()


static func _add_tri(st: SurfaceTool, a: Vector3, b: Vector3, c: Vector3) -> void:
	st.set_uv(Vector2(0, 0)); st.add_vertex(a)
	st.set_uv(Vector2(1, 0)); st.add_vertex(b)
	st.set_uv(Vector2(1, 1)); st.add_vertex(c)


func request_side_guard_opening(arc_back: float, arc_front: float, side: String) -> void:
	if arc_front <= arc_back:
		return
	if side != "left" and side != "right":
		return
	var next: Array[SideGuardOpening] = side_guard_openings.duplicate(true)
	next.append(SideGuardOpening.make(arc_back, arc_front, side))
	side_guard_openings = next


func clear_side_guard_openings() -> void:
	if side_guard_openings.is_empty():
		return
	side_guard_openings = []


func _request_side_guard_rebuild() -> void:
	if _side_guard_rebuild_pending or not is_inside_tree():
		return
	_side_guard_rebuild_pending = true
	call_deferred("_rebuild_side_guards")


func _openings_for_side(side: String) -> Array[Vector2]:
	var ranges: Array[Vector2] = []
	for o: SideGuardOpening in side_guard_openings:
		if o == null or o.side != side:
			continue
		var s: float = o.arc_back
		var e: float = o.arc_front
		if e <= s:
			continue
		ranges.append(Vector2(s, e))
	ranges.sort_custom(func(a: Vector2, b: Vector2) -> bool: return a.x < b.x)
	var merged: Array[Vector2] = []
	for r: Vector2 in ranges:
		if merged.is_empty() or r.x > merged[-1].y:
			merged.append(r)
		else:
			merged[-1] = Vector2(merged[-1].x, maxf(merged[-1].y, r.y))
	return merged


func _subdivide_around_openings(start_x: float, end_x: float, openings: Array[Vector2]) -> Array[Vector2]:
	var subs: Array[Vector2] = [Vector2(start_x, end_x)]
	for opening: Vector2 in openings:
		var next_subs: Array[Vector2] = []
		for sub: Vector2 in subs:
			if opening.y <= sub.x or opening.x >= sub.y:
				next_subs.append(sub)
				continue
			if opening.x > sub.x:
				next_subs.append(Vector2(sub.x, opening.x))
			if opening.y < sub.y:
				next_subs.append(Vector2(opening.y, sub.y))
		subs = next_subs
	var out: Array[Vector2] = []
	for sub: Vector2 in subs:
		if sub.y - sub.x > _MIN_GUARD_LEN:
			out.append(sub)
	return out


func _rebuild_side_guards() -> void:
	_side_guard_rebuild_pending = false
	if not is_inside_tree():
		return
	_side_guards.clear()
	var keep := PackedStringArray()
	var half_l: float = size.x * 0.5
	var half_w: float = size.z * 0.5
	var wt: float = ConveyorFrameMesh.WALL_THICKNESS
	var ft: float = ConveyorFrameMesh.FLANGE_THICKNESS
	var guard_y: float = ft
	if left_side_guards_enabled:
		var subs: Array[Vector2] = _subdivide_around_openings(-half_l, half_l, _openings_for_side("left"))
		for k in range(subs.size()):
			var sub: Vector2 = subs[k]
			var n: String = "SideGuardLeft_%d" % k
			keep.append(n)
			_emit_side_guard(n, sub.x, sub.y, false, -half_w - wt, guard_y)
	if right_side_guards_enabled:
		var subs: Array[Vector2] = _subdivide_around_openings(-half_l, half_l, _openings_for_side("right"))
		for k in range(subs.size()):
			var sub: Vector2 = subs[k]
			var n: String = "SideGuardRight_%d" % k
			keep.append(n)
			_emit_side_guard(n, sub.x, sub.y, true, half_w + wt, guard_y)
	_remove_orphans_with_prefix(["SideGuardLeft_", "SideGuardRight_"], keep)


func _emit_side_guard(guard_name: String, sub_start: float, sub_end: float,
		flipped: bool, z_pos: float, flange_y: float) -> void:
	var sub_len: float = sub_end - sub_start
	var sub_mid: float = (sub_start + sub_end) * 0.5
	var guard_basis: Basis = Basis(Vector3.UP, PI) if flipped else Basis.IDENTITY
	var origin: Vector3 = Vector3(sub_mid, flange_y, z_pos)
	var sg: SideGuard = get_node_or_null(NodePath(guard_name)) as SideGuard
	if sg == null:
		sg = SideGuard.new()
		sg.name = guard_name
		add_child(sg, false, Node.INTERNAL_MODE_FRONT)
	sg.length = sub_len
	sg.transform = Transform3D(guard_basis, origin)
	sg.arc_back = sub_start
	sg.arc_front = sub_end
	_side_guards.append(sg)


func _request_legs_refresh() -> void:
	if _legs_refresh_pending or not is_inside_tree():
		return
	_legs_refresh_pending = true
	call_deferred("_rebuild_legs")


func _rebuild_legs() -> void:
	_legs_refresh_pending = false
	if not is_inside_tree():
		return
	_legs.clear()
	var keep: Dictionary = {}
	if not legs_enabled or leg_model_scene == null:
		_remove_orphan_legs(keep)
		return
	var specs: Array = _compute_leg_specs(size.x)
	if specs.is_empty():
		_remove_orphan_legs(keep)
		return
	var leg_z_scale: float = maxf(0.1, size.z * 0.5)
	var node_xform: Transform3D = global_transform if is_inside_tree() else Transform3D.IDENTITY
	var cross_axis_world: Vector3 = node_xform.basis.z.normalized()
	var legs_normal_world: Vector3 = floor_plane.normal.slide(cross_axis_world)
	if legs_normal_world.length_squared() < 1.0e-6:
		_remove_orphan_legs(keep)
		return
	legs_normal_world = legs_normal_world.normalized()
	for spec: Dictionary in specs:
		var leg_name: String = spec["name"]
		var x: float = spec["x"]
		var belt_bottom_local: Vector3 = Vector3(x, -size.y, 0.0)
		var belt_bottom_world: Vector3 = node_xform * belt_bottom_local
		var foot_v: Variant = floor_plane.intersects_ray(belt_bottom_world, -legs_normal_world)
		if foot_v == null:
			foot_v = floor_plane.intersects_ray(belt_bottom_world, legs_normal_world)
		if foot_v == null:
			continue
		var foot_world: Vector3 = foot_v
		var leg_height: float = (belt_bottom_world - foot_world).dot(legs_normal_world)
		if leg_height <= 0.05:
			continue
		var leg: Node3D = get_node_or_null(NodePath(leg_name)) as Node3D
		if leg == null:
			leg = leg_model_scene.instantiate() as Node3D
			if leg == null:
				continue
			leg.name = leg_name
			add_child(leg, false, Node.INTERNAL_MODE_FRONT)
		leg.visible = true
		var foot_local: Vector3 = node_xform.affine_inverse() * foot_world
		leg.position = foot_local
		leg.scale = Vector3(1.0, leg_height, leg_z_scale)
		keep[leg_name] = true
		_legs.append(leg)
	_remove_orphan_legs(keep)


func _remove_orphan_legs(keep: Dictionary) -> void:
	for child in get_children(true):
		var n: String = String(child.name)
		if not n.begins_with("Leg_"):
			continue
		if keep.has(n):
			continue
		remove_child(child)
		child.queue_free()


func _reposition_existing_legs() -> void:
	if not legs_enabled or leg_model_scene == null:
		return
	var leg_z_scale: float = maxf(0.1, size.z * 0.5)
	var node_xform: Transform3D = global_transform if is_inside_tree() else Transform3D.IDENTITY
	var cross_axis_world: Vector3 = node_xform.basis.z.normalized()
	var legs_normal_world: Vector3 = floor_plane.normal.slide(cross_axis_world)
	if legs_normal_world.length_squared() < 1.0e-6:
		return
	legs_normal_world = legs_normal_world.normalized()
	for spec: Dictionary in _compute_leg_specs(size.x):
		var leg: Node3D = get_node_or_null(NodePath(spec["name"])) as Node3D
		if leg == null:
			continue
		var x: float = spec["x"]
		var belt_bottom_local: Vector3 = Vector3(x, -size.y, 0.0)
		var belt_bottom_world: Vector3 = node_xform * belt_bottom_local
		var foot_v: Variant = floor_plane.intersects_ray(belt_bottom_world, -legs_normal_world)
		if foot_v == null:
			foot_v = floor_plane.intersects_ray(belt_bottom_world, legs_normal_world)
		if foot_v == null:
			leg.visible = false
			continue
		var foot_world: Vector3 = foot_v
		var leg_height: float = (belt_bottom_world - foot_world).dot(legs_normal_world)
		if leg_height <= 0.05:
			leg.visible = false
			continue
		leg.visible = true
		var foot_local: Vector3 = node_xform.affine_inverse() * foot_world
		leg.position = foot_local
		leg.scale = Vector3(1.0, leg_height, leg_z_scale)


func _compute_leg_specs(top_len: float) -> Array:
	var specs: Array = []
	var half_l: float = top_len * 0.5
	var coverage_min: float = -half_l + tail_end_attachment_offset if tail_end_leg_enabled else -half_l
	var coverage_max: float = half_l - head_end_attachment_offset if head_end_leg_enabled else half_l
	if tail_end_leg_enabled and coverage_min <= half_l and not _is_x_excluded(coverage_min, -half_l):
		specs.append({"name": _LEG_TAIL_NAME, "x": coverage_min})
	if middle_legs_enabled and middle_legs_spacing > 0.0:
		var tail_clear: float = tail_end_leg_clearance if tail_end_leg_enabled else 0.0
		var head_clear: float = head_end_leg_clearance if head_end_leg_enabled else 0.0
		# Snap to origin-centered grid so legs land at x=0 for symmetric lengths.
		var first: float = ceil((coverage_min + tail_clear) / middle_legs_spacing) * middle_legs_spacing
		var last: float = floor((coverage_max - head_clear) / middle_legs_spacing) * middle_legs_spacing
		var idx: int = 1
		var pos: float = first
		while pos <= last + 1.0e-6:
			if pos >= -half_l and pos <= half_l and not _is_x_excluded(pos, -half_l):
				specs.append({"name": "%s%d" % [_LEG_MIDDLE_PREFIX, idx], "x": pos})
				idx += 1
			pos += middle_legs_spacing
	if head_end_leg_enabled and coverage_max >= -half_l and coverage_max <= half_l \
			and not _is_x_excluded(coverage_max, -half_l):
		specs.append({"name": _LEG_HEAD_NAME, "x": coverage_max})
	return specs


func _is_x_excluded(x: float, tail_x: float) -> bool:
	if exclusion_start == 0.0 and exclusion_end == 0.0:
		return false
	return x >= tail_x + exclusion_start and x <= tail_x + exclusion_end


func _remove_orphans_with_prefix(prefixes: Array, keep: PackedStringArray) -> void:
	for child in get_children(true):
		var n: String = child.name
		if n in keep:
			continue
		for prefix: String in prefixes:
			if n.begins_with(prefix):
				remove_child(child)
				child.queue_free()
				break
