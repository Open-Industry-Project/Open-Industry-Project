@tool
class_name BeltConveyor
extends ResizableNode3D

signal speed_changed

## Belt texture options for visual appearance.
enum ConvTexture {
	## Typical industrial belt texture.
	STANDARD,
	## Modern pattern with flow direction indicators.
	ALTERNATE
}

## The color tint applied to the belt surface.
@export var belt_color: Color = Color(1, 1, 1, 1):
	set(value):
		belt_color = value
		_update_material_color()

## The texture style of the belt (standard or alternate pattern).
@export var belt_texture: ConvTexture = ConvTexture.STANDARD:
	set(value):
		belt_texture = value
		_update_material_texture()

## The linear speed of the belt in meters per second.
@export_custom(PROPERTY_HINT_NONE, "suffix:m/s") var speed: float = 2:
	set(value):
		if value == speed:
			return
		speed = value
		_update_belt_material_scale()
		speed_changed.emit()

		if _running_tag.is_ready():
			_running_tag.write_bit(value != 0.0)

## The physics material applied to the belt surface for friction control.
@export var belt_physics_material: PhysicsMaterial:
	get:
		var sb_node := get_node_or_null("StaticBody3D") as StaticBody3D
		if sb_node:
			return sb_node.physics_material_override
		return null
	set(value):
		var sb_node := get_node_or_null("StaticBody3D") as StaticBody3D
		if sb_node:
			sb_node.physics_material_override = value

@onready var _sb: StaticBody3D = get_node("StaticBody3D")
@onready var _mesh: MeshInstance3D = get_node("MeshInstance3D")
## When true, the parent assembly handles frame and belt end generation.
var frame_managed_externally: bool = false
## Close the left side (-Z) of the belt mesh with a wall.
var close_left_side: bool = false
## Close the right side (+Z) of the belt mesh with a wall.
var close_right_side: bool = false

var _belt_material: Material
var _metal_material: Material
var _frame_left: FrameRail
var _frame_right: FrameRail
var _shadow_plate: MeshInstance3D
@export_storage var _frame_rail_state: Dictionary = {}

static var _belt_texture: Texture2D = preload("res://assets/3DModels/Textures/4K-fabric_39-diffuse.jpg")
static var _belt_texture_alt: Texture2D = preload("res://assets/3DModels/Textures/ConvBox_Conv_text__arrows_1024.png")
var _flow_arrow: Node3D
var _belt_position: float = 0.0
var _speed_tag := OIPCommsTag.new()
var _running_tag := OIPCommsTag.new()
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


func _validate_property(property: Dictionary) -> void:
	if OIPCommsSetup.validate_tag_property(property, "speed_tag_group_name", "speed_tag_groups", "speed_tag_name"):
		return
	OIPCommsSetup.validate_tag_property(property, "running_tag_group_name", "running_tag_groups", "running_tag_name")


func _get_custom_preview_node() -> Node3D:
	var preview_scene := load("res://parts/BeltConveyor.tscn") as PackedScene
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


func _get_constrained_size(new_size: Vector3) -> Vector3:
	# Don't allow belt conveyors to be shorter than the total length of their ends.
	# Ends' length varies with height.
	var height := new_size.y
	var end_length := height / 2.0
	# For sanity, ensure that the middle's length is non-zero.
	var middle_min_length := 0.01
	var minimum_length := end_length * 2.0 + middle_min_length
	new_size.x = max(new_size.x, minimum_length)
	return new_size


func _init() -> void:
	super._init()
	size_default = Vector3(4, 0.5, 1.524)


func _enter_tree() -> void:
	super._enter_tree()

	speed_tag_group_name = OIPCommsSetup.default_tag_group(speed_tag_group_name)
	running_tag_group_name = OIPCommsSetup.default_tag_group(running_tag_group_name)
	SimulationManager.simulation_started.connect(_on_simulation_started)
	SimulationManager.simulation_stopped.connect(_on_simulation_ended)
	OIPCommsSetup.connect_comms(self, _tag_group_initialized, _tag_group_polled)


func _ready() -> void:
	_setup_materials()
	_setup_collision_shape()
	_update_material_texture()
	_update_material_color()
	_on_size_changed()
	_update_flow_arrow()


func _update_flow_arrow() -> void:
	if frame_managed_externally:
		return
	if _flow_arrow:
		FlowDirectionArrow.unregister(_flow_arrow)
		_flow_arrow.queue_free()
	_flow_arrow = FlowDirectionArrow.create(size)
	add_child(_flow_arrow, false, Node.INTERNAL_MODE_FRONT)
	FlowDirectionArrow.register(_flow_arrow)


func _physics_process(delta: float) -> void:
	if SimulationManager.is_simulation_running():
		var local_left := _sb.global_transform.basis.x.normalized()
		var velocity := local_left * speed
		_sb.constant_linear_velocity = velocity
		if not SimulationManager.is_simulation_paused():
			_belt_position = fmod(_belt_position + speed * delta, 1.0)
		if speed != 0:
			(_belt_material as ShaderMaterial).set_shader_parameter("BeltPosition", _belt_position)


func _exit_tree() -> void:
	if _flow_arrow:
		FlowDirectionArrow.unregister(_flow_arrow)
	SimulationManager.simulation_started.disconnect(_on_simulation_started)
	SimulationManager.simulation_stopped.disconnect(_on_simulation_ended)
	OIPCommsSetup.disconnect_comms(self, _tag_group_initialized, _tag_group_polled)
	super._exit_tree()


func fix_material_overrides() -> void:
	if not _mesh or not _mesh.mesh or _mesh.mesh.get_surface_count() == 0:
		return
	if _mesh.get_surface_override_material(0) != _belt_material:
		_mesh.set_surface_override_material(0, _belt_material)


func _setup_materials() -> void:
	# Custom belt shader — we control the UV mapping.
	_belt_material = ShaderMaterial.new()
	_belt_material.shader = preload("res://src/Conveyor/belt_surface_shader.gdshader")
	_belt_material.set_shader_parameter("belt_texture", _belt_texture)
	_belt_material.set_shader_parameter("belt_texture_alt", _belt_texture_alt)

	# Procedural frame rails — skip when the parent assembly owns the rails.
	_metal_material = ConveyorFrameMesh.create_material()
	if not frame_managed_externally:
		_frame_left = get_node_or_null("FrameLeft") as FrameRail
		if not _frame_left:
			_frame_left = FrameRail.new()
			_frame_left.name = "FrameLeft"
			add_child(_frame_left)
		_frame_right = get_node_or_null("FrameRight") as FrameRail
		if not _frame_right:
			_frame_right = FrameRail.new()
			_frame_right.name = "FrameRight"
			add_child(_frame_right)
		_restore_frame_rail_state()
	_shadow_plate = get_node_or_null("ShadowPlate")
	if not _shadow_plate:
		_shadow_plate = MeshInstance3D.new()
		_shadow_plate.name = "ShadowPlate"
		_shadow_plate.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_SHADOWS_ONLY
		add_child(_shadow_plate)


func _setup_collision_shape() -> void:
	var collision_shape_node := _sb.get_node("CollisionShape3D") as CollisionShape3D
	if collision_shape_node and collision_shape_node.shape:
		collision_shape_node.shape = collision_shape_node.shape.duplicate() as BoxShape3D


func _update_material_texture() -> void:
	if not _belt_material:
		return
	_belt_material.set_shader_parameter("use_alternate_texture", belt_texture == ConvTexture.ALTERNATE)
	fix_material_overrides()


func _update_material_color() -> void:
	if not _belt_material:
		return
	_belt_material.set_shader_parameter("ColorMix", belt_color)
	fix_material_overrides()


func _update_belt_material_scale() -> void:
	if not _belt_material:
		return
	# Scale = texture repeats over the full belt loop.
	var radius: float = size.y / 2.0
	var middle_len: float = size.x - 2.0 * radius
	var total_belt: float = 2.0 * PI * radius + 2.0 * middle_len
	var scale_value: float = max(1.0, total_belt)
	(_belt_material as ShaderMaterial).set_shader_parameter("Scale", scale_value)
	fix_material_overrides()


func _on_size_changed() -> void:
	var length := size.x
	var height := size.y
	var width := size.z

	var middle_body := _sb
	var middle_mesh := _mesh
	var middle_collision_shape := get_node_and_resource("StaticBody3D/CollisionShape3D:shape")[1] as BoxShape3D
	if not (is_instance_valid(middle_body)
			and is_instance_valid(middle_mesh)
			and is_instance_valid(middle_collision_shape)):
		return

	middle_collision_shape.size = Vector3(length, height, width)

	# Unified procedural belt mesh.
	# When frame is managed externally (spur assembly), always close both sides
	# so adjacent belts aren't see-through. Outermost edges (close_* flags) get
	# flat rectangular walls; inner sides between belts follow the belt contour.
	var wall_left: bool = close_left_side or frame_managed_externally
	var wall_right: bool = close_right_side or frame_managed_externally
	middle_mesh.mesh = BeltConveyorMesh.create_belt(length, height, width,
			wall_left, wall_right, close_left_side, close_right_side)
	middle_mesh.scale = Vector3.ONE
	middle_mesh.position = Vector3.ZERO
	middle_mesh.set_surface_override_material(0, _belt_material)
	if wall_left or wall_right:
		middle_mesh.set_surface_override_material(1, _metal_material)
	middle_mesh.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF

	if _shadow_plate:
		var box := BoxMesh.new()
		box.size = Vector3(length, 0.01, width)
		_shadow_plate.mesh = box
		_shadow_plate.position = Vector3(0, -height, 0)

	_update_belt_material_scale()

	middle_body.position = Vector3(0, -height / 2.0, 0)

	# Procedural frame rails (only exist when not externally managed).
	if _frame_left and _frame_right:
		var half_width := width / 2.0
		var wt := ConveyorFrameMesh.WALL_THICKNESS
		var old_hl: float = _resize_old_size.x / 2.0 if _resize_old_size.x > 0 else length / 2.0
		# Compute how much non-anchored edges should shift to maintain global position.
		# handle 0 (+X fixed): center moved +X, edges shift -X
		# handle 1 (-X fixed): center moved -X, edges shift +X
		# no handle (-1): no shift
		var offset_x: float = 0.0
		if _resize_handle == 0:
			offset_x = -(length - _resize_old_size.x) / 2.0
		elif _resize_handle == 1:
			offset_x = (length - _resize_old_size.x) / 2.0

		_update_frame_rail(_frame_left, length, height, -half_width - wt, Vector3.ZERO, offset_x, old_hl)
		_update_frame_rail(_frame_right, length, height, half_width + wt, Vector3(0, PI, 0), offset_x, old_hl)
		_save_frame_rail_state()

	_update_flow_arrow()


func _update_frame_rail(rail: FrameRail, conveyor_length: float, h: float, z: float, rot: Vector3, offset_x: float, old_half_length: float) -> void:
	rail.height = h
	var half_length: float = conveyor_length / 2.0
	var rail_front: float = rail.position.x + rail.length / 2.0
	var rail_back: float = rail.position.x - rail.length / 2.0
	if rail.front_anchored:
		rail_front = half_length
	elif rail.front_boundary_tracking and half_length > old_half_length + 0.001:
		rail.front_anchored = true
		rail.front_boundary_tracking = false
		rail_front = half_length
	else:
		rail_front = minf(rail_front + offset_x, half_length)
	if rail.back_anchored:
		rail_back = -half_length
	elif rail.back_boundary_tracking and half_length > old_half_length + 0.001:
		rail.back_anchored = true
		rail.back_boundary_tracking = false
		rail_back = -half_length
	else:
		rail_back = maxf(rail_back + offset_x, -half_length)
	var new_length: float = max(0.01, rail_front - rail_back)
	var new_center: float = (rail_front + rail_back) / 2.0
	rail.length = new_length
	rail.position = Vector3(new_center, -h, z)
	rail.rotation = rot


func _save_frame_rail_state() -> void:
	var state: Dictionary = {}
	for entry in [["left", _frame_left], ["right", _frame_right]]:
		var rail: FrameRail = entry[1]
		if not rail:
			continue
		state[entry[0]] = {
			"pos_x": rail.position.x,
			"length": rail.length,
			"front_anchored": rail.front_anchored,
			"back_anchored": rail.back_anchored,
			"front_boundary_tracking": rail.front_boundary_tracking,
			"back_boundary_tracking": rail.back_boundary_tracking,
		}
	_frame_rail_state = state


func _restore_frame_rail_state() -> void:
	if _frame_rail_state.is_empty():
		return
	for entry in [["left", _frame_left], ["right", _frame_right]]:
		var rail: FrameRail = entry[1]
		if not rail or not _frame_rail_state.has(entry[0]):
			continue
		var s: Dictionary = _frame_rail_state[entry[0]]
		rail.position.x = float(s["pos_x"])
		rail.length = float(s["length"])
		rail.front_anchored = bool(s["front_anchored"])
		rail.back_anchored = bool(s["back_anchored"])
		rail.front_boundary_tracking = bool(s["front_boundary_tracking"])
		rail.back_boundary_tracking = bool(s["back_boundary_tracking"])


func _on_simulation_started() -> void:
	if enable_comms:
		_speed_tag.register(speed_tag_group_name, speed_tag_name)
		_running_tag.register(running_tag_group_name, running_tag_name)


func _on_simulation_ended() -> void:
	_belt_position = 0.0
	if _belt_material:
		(_belt_material as ShaderMaterial).set_shader_parameter("BeltPosition", _belt_position)
	if _sb:
		_sb.constant_linear_velocity = Vector3.ZERO


func _tag_group_initialized(tag_group_name_param: String) -> void:
	_speed_tag.on_group_initialized(tag_group_name_param)
	_running_tag.on_group_initialized(tag_group_name_param)


func _tag_group_polled(tag_group_name_param: String) -> void:
	if not enable_comms:
		return

	if _speed_tag.matches_group(tag_group_name_param):
		speed = _speed_tag.read_float32()
