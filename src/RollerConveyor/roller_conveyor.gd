@tool
class_name RollerConveyor
extends ResizableNode3D

signal width_changed(width: float)
signal length_changed(length: float)
signal roller_skew_angle_changed(skew_angle_degrees: float)
signal speed_changed(speed: float)
signal roller_override_material_changed(material: Material)

const CIRCUMFERENCE: float = 2.0 * PI * Roller.RADIUS
const ROLLERS_Y_OFFSET: float = -0.08
## Linear speed of the rollers in meters per second.
@export_custom(PROPERTY_HINT_NONE, "suffix:m/s") var speed: float = 1.0:
	set(value):
		if value == speed:
			return
		speed = value
		speed_changed.emit(value)
		_update_conveyor_velocity()

		if _running_tag.is_ready():
			_running_tag.write_bit(value != 0.0)

## Angle of roller skew for angled product movement (-60 to 60 degrees).
@export_range(-60, 60, 1, "degrees") var skew_angle: float = 0.0:
	set(value):
		if skew_angle != value:
			skew_angle = value
			roller_skew_angle_changed.emit(skew_angle)
			_update_conveyor_velocity()
			_update_transfer_plates()

@export_category("Communications")
## Enable communication with external PLC/control systems.
@export var enable_comms: bool = false
@export var speed_tag_group_name: String
## The tag group for reading speed values from external systems.
@export_custom(0, "tag_group_enum") var speed_tag_groups:
	set(value):
		speed_tag_group_name = value
		speed_tag_groups = value
## The tag name for the speed value in the selected tag group.[br]Datatype: [code]REAL[/code] (32-bit float)[br][br]Format varies by protocol:[br][b]EIP:[/b] CIP tag names[br][b]Modbus:[/b] prefix+number (e.g. [code]hr0[/code])[br][b]OPC UA:[/b] full NodeId (e.g. [code]ns=2;s=MyVariable[/code] or [code]ns=2;i=12345[/code]).
@export var speed_tag_name: String = ""
@export var running_tag_group_name: String
## The tag group for the running state signal.
@export_custom(0, "tag_group_enum") var running_tag_groups:
	set(value):
		running_tag_group_name = value
		running_tag_groups = value
## The tag name for the running state in the selected tag group.[br]Datatype: [code]BOOL[/code][br][br]Format varies by protocol:[br][b]EIP:[/b] CIP tag names[br][b]Modbus:[/b] prefix+number (e.g. [code]co0[/code])[br][b]OPC UA:[/b] full NodeId (e.g. [code]ns=2;s=MyVariable[/code] or [code]ns=2;i=12345[/code]).
@export var running_tag_name: String = ""

var running: bool = false:
	set(value):
		running = value
		set_physics_process(running)

var _speed_tag := OIPCommsTag.new()
var _running_tag := OIPCommsTag.new()

## When true, a parent assembly owns the outer frame rails and flow arrow;
## `ConvRollerL`/`ConvRollerR` are hidden and the child's flow arrow is freed.
var frame_managed_externally: bool = false:
	set(value):
		if frame_managed_externally == value:
			return
		frame_managed_externally = value
		if is_node_ready():
			_update_component_positions()
			_update_flow_arrow()

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


func _get_custom_preview_node() -> Node3D:
	var preview_scene := load("res://parts/RollerConveyor.tscn") as PackedScene
	var preview_node = preview_scene.instantiate(PackedScene.GEN_EDIT_STATE_DISABLED) as Node3D

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
	_setup_conveyor_physics()
	_setup_collision_shape()
	_setup_roller_initialization()
	_setup_material()
	_setup_shadow_plate()
	_setup_transfer_plates()
	# Force initial component update regardless of size change detection.
	_last_size = Vector3.ZERO
	_on_size_changed()
	_update_flow_arrow()


func _update_flow_arrow() -> void:
	if _flow_arrow:
		FlowDirectionArrow.unregister(_flow_arrow)
		_flow_arrow.queue_free()
		_flow_arrow = null
	if frame_managed_externally:
		return
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
			if frame_managed_externally:
				left_side.visible = false
				right_side.visible = false
			else:
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


## Builds a transfer plate mesh: a horizontal triangle (v1-v2-v3) plus
## vertical skirts to conceal shortened roller ends.
## v1→v3: inner diagonal edge (facing rollers). v2→v3: end frame edge.
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
