@tool
class_name Gantry
extends Node3D

## A 3-axis Cartesian gantry robot with vacuum gripper.
## Axis configuration:
## - X: Longitudinal travel (along frame length)
## - Y: Lateral travel (along frame width)
## - Z: Vertical travel (up/down)

const BEAM_THICKNESS := 0.08
const RAIL_THICKNESS := 0.06
const POST_RADIUS := 0.05
const CARRIAGE_BLOCK_SIZE := 0.12
const ACTUATOR_WIDTH := 0.08
const TOOL_MOUNT_HEIGHT := 0.08
const VACUUM_CUP_RADIUS := 0.15
const VACUUM_CUP_HEIGHT := 0.06

@export_tool_button("Set Home") var action_set_home = set_home_action
@export_tool_button("Go Home") var action_go_home = go_home_action
@export_tool_button("Train Waypoint") var action_train = train_waypoint_action
@export_tool_button("Go To Waypoint") var action_go_to = go_to_waypoint_action
@export_tool_button("Delete Waypoint") var action_delete = delete_waypoint_action

@export var home_position: Array[float] = [0.0, 0.0, 0.0]
@export var waypoints: Dictionary = {}
@export_range(0.1, 10.0, 0.1, "suffix:m/s") var motion_speed: float = 1.0
@export var selected_waypoint: String = ""
@export var new_waypoint_name: String = "Point1"

@export_category("Frame Size")
## Length of the gantry frame along the X axis
@export_range(0.5, 20.0, 0.01, "suffix:m") var frame_length: float = 2.0:
	set(value):
		frame_length = value
		_rebuild_geometry()

## Width of the gantry frame along the Y axis
@export_range(0.3, 10.0, 0.01, "suffix:m") var frame_width: float = 1.0:
	set(value):
		frame_width = value
		_rebuild_geometry()

## Height of the gantry frame
@export_range(0.5, 10.0, 0.01, "suffix:m") var frame_height: float = 1.5:
	set(value):
		frame_height = value
		z_position = clampf(z_position, 0.0, _get_max_z_travel())
		_rebuild_geometry()

@export_category("Axis Positions")
## X axis position (0 = center, range: -frame_length/2 to +frame_length/2)
@export_range(-10.0, 10.0, 0.001, "suffix:m") var x_position: float = 0.0:
	set(value):
		var half := (frame_length - CARRIAGE_BLOCK_SIZE) / 2.0
		x_position = clampf(value, -half, half)
		_update_axis_positions()

## Y axis position (0 = center, range: -frame_width/2 to +frame_width/2)
@export_range(-5.0, 5.0, 0.001, "suffix:m") var y_position: float = 0.0:
	set(value):
		var half := (frame_width - CARRIAGE_BLOCK_SIZE) / 2.0
		y_position = clampf(value, -half, half)
		_update_axis_positions()

## Z axis position (0 = fully retracted, positive = extended down)
@export_range(0.0, 10.0, 0.001, "suffix:m") var z_position: float = 0.0:
	set(value):
		z_position = clampf(value, 0.0, _get_max_z_travel())
		_update_axis_positions()

@export_category("Vacuum Gripper")
@export var vacuum_on: bool = false:
	set(value):
		vacuum_on = value
		_update_vacuum_state()

@export var holding_object: bool = false:
	set(value):
		holding_object = value
	get:
		return _held_object != null

@export_category("Settings")
@export var show_gizmos: bool = true:
	set(value):
		show_gizmos = value
		update_gizmos()

@export_category("Communications")
@export var enable_comms: bool = false
@export var tag_group_name: String
@export_custom(0, "tag_group_enum") var tag_groups:
	set(value):
		tag_group_name = value
		tag_groups = value
## Integer value selecting which waypoint to move to (0 = home, 1+ = waypoint by order).[br]Datatype: INT (16-bit integer)
@export var command_tag: String = ""
## Rising edge triggers movement to command waypoint.[br]Datatype: BOOL
@export var execute_tag: String = ""
## True when gantry has reached target position.[br]Datatype: BOOL
@export var done_tag: String = ""
## Vacuum gripper control.[br]Datatype: BOOL
@export var vacuum_tag: String = ""

var _register_tag_ok: bool = false
var _tag_group_init: bool = false
var _last_execute: bool = false

var _frame: Node3D
var _x_carriage: Node3D
var _y_carriage: Node3D
var _z_actuator: Node3D

var _post_fl: MeshInstance3D
var _post_fr: MeshInstance3D
var _post_bl: MeshInstance3D
var _post_br: MeshInstance3D
var _beam_front: MeshInstance3D
var _beam_back: MeshInstance3D
var _rail_left: MeshInstance3D
var _rail_right: MeshInstance3D
var _cross_beam: MeshInstance3D
var _carriage_block: MeshInstance3D
var _actuator_rod: MeshInstance3D
var _tool_mount: MeshInstance3D
var _vacuum_cup_mesh: MeshInstance3D
var _vacuum_cup_rim: MeshInstance3D

var _vacuum_area: Area3D
var _held_object: Node3D = null
var _held_rigid_body: RigidBody3D = null
var _held_object_basis: Basis = Basis.IDENTITY
var _objects_in_range: Array[Node3D] = []

var _motion_tween: Tween = null
var _is_moving: bool = false
var _initialized: bool = false


func _enter_tree() -> void:
	if tag_group_name.is_empty() and OIPComms.get_tag_groups().size() > 0:
		tag_group_name = OIPComms.get_tag_groups()[0]

	_setup_node_references()

	if not SimulationEvents.simulation_started.is_connected(_on_simulation_started):
		SimulationEvents.simulation_started.connect(_on_simulation_started)
	if not SimulationEvents.simulation_ended.is_connected(_on_simulation_ended):
		SimulationEvents.simulation_ended.connect(_on_simulation_ended)
	if OIPComms:
		if not OIPComms.tag_group_initialized.is_connected(_tag_group_initialized):
			OIPComms.tag_group_initialized.connect(_tag_group_initialized)
		if not OIPComms.tag_group_polled.is_connected(_tag_group_polled):
			OIPComms.tag_group_polled.connect(_tag_group_polled)
		if not OIPComms.enable_comms_changed.is_connected(notify_property_list_changed):
			OIPComms.enable_comms_changed.connect(notify_property_list_changed)


func _exit_tree() -> void:
	if SimulationEvents.simulation_started.is_connected(_on_simulation_started):
		SimulationEvents.simulation_started.disconnect(_on_simulation_started)
	if SimulationEvents.simulation_ended.is_connected(_on_simulation_ended):
		SimulationEvents.simulation_ended.disconnect(_on_simulation_ended)
	if OIPComms:
		if OIPComms.tag_group_initialized.is_connected(_tag_group_initialized):
			OIPComms.tag_group_initialized.disconnect(_tag_group_initialized)
		if OIPComms.tag_group_polled.is_connected(_tag_group_polled):
			OIPComms.tag_group_polled.disconnect(_tag_group_polled)
		if OIPComms.enable_comms_changed.is_connected(notify_property_list_changed):
			OIPComms.enable_comms_changed.disconnect(notify_property_list_changed)


func _ready() -> void:
	_rebuild_geometry()
	_update_materials()
	new_waypoint_name = _get_next_waypoint_name()

	if _vacuum_area:
		if not _vacuum_area.body_entered.is_connected(_on_vacuum_area_body_entered):
			_vacuum_area.body_entered.connect(_on_vacuum_area_body_entered)
		if not _vacuum_area.body_exited.is_connected(_on_vacuum_area_body_exited):
			_vacuum_area.body_exited.connect(_on_vacuum_area_body_exited)


func _process(_delta: float) -> void:
	_update_held_object()


func _setup_node_references() -> void:
	_frame = get_node_or_null("Frame")
	if not _frame:
		return

	_initialized = true

	_post_fl = _frame.get_node_or_null("PostFrontLeft")
	_post_fr = _frame.get_node_or_null("PostFrontRight")
	_post_bl = _frame.get_node_or_null("PostBackLeft")
	_post_br = _frame.get_node_or_null("PostBackRight")
	_beam_front = _frame.get_node_or_null("BeamFront")
	_beam_back = _frame.get_node_or_null("BeamBack")
	_rail_left = _frame.get_node_or_null("RailLeft")
	_rail_right = _frame.get_node_or_null("RailRight")

	_x_carriage = get_node_or_null("XCarriage")
	_cross_beam = _x_carriage.get_node_or_null("CrossBeam") if _x_carriage else null
	_y_carriage = _x_carriage.get_node_or_null("YCarriage") if _x_carriage else null
	_carriage_block = _y_carriage.get_node_or_null("CarriageBlock") if _y_carriage else null
	_z_actuator = _y_carriage.get_node_or_null("ZActuator") if _y_carriage else null
	_actuator_rod = _z_actuator.get_node_or_null("ActuatorRod") if _z_actuator else null
	_tool_mount = _z_actuator.get_node_or_null("ToolMount") if _z_actuator else null
	_vacuum_cup_mesh = _z_actuator.get_node_or_null("VacuumCup") if _z_actuator else null
	_vacuum_cup_rim = _z_actuator.get_node_or_null("VacuumCupRim") if _z_actuator else null
	_vacuum_area = _z_actuator.get_node_or_null("VacuumArea") if _z_actuator else null


func _rebuild_geometry() -> void:
	if not _initialized:
		return

	var half_l := frame_length / 2.0
	var half_w := frame_width / 2.0

	# Posts (vertical cylinders at corners)
	_set_cylinder_mesh(_post_fl, POST_RADIUS, frame_height)
	_post_fl.position = Vector3(-half_l, frame_height / 2.0, -half_w)

	_set_cylinder_mesh(_post_fr, POST_RADIUS, frame_height)
	_post_fr.position = Vector3(half_l, frame_height / 2.0, -half_w)

	_set_cylinder_mesh(_post_bl, POST_RADIUS, frame_height)
	_post_bl.position = Vector3(-half_l, frame_height / 2.0, half_w)

	_set_cylinder_mesh(_post_br, POST_RADIUS, frame_height)
	_post_br.position = Vector3(half_l, frame_height / 2.0, half_w)

	# Top beams along X (front and back)
	_set_box_mesh(_beam_front, Vector3(frame_length, BEAM_THICKNESS, BEAM_THICKNESS))
	_beam_front.position = Vector3(0, frame_height - BEAM_THICKNESS / 2.0, -half_w)

	_set_box_mesh(_beam_back, Vector3(frame_length, BEAM_THICKNESS, BEAM_THICKNESS))
	_beam_back.position = Vector3(0, frame_height - BEAM_THICKNESS / 2.0, half_w)

	# Rails along X (where X carriage rides, slightly below top beams)
	var rail_y := frame_height - BEAM_THICKNESS - RAIL_THICKNESS / 2.0
	_set_box_mesh(_rail_left, Vector3(frame_length - POST_RADIUS * 2.0, RAIL_THICKNESS, RAIL_THICKNESS))
	_rail_left.position = Vector3(0, rail_y, -half_w)

	_set_box_mesh(_rail_right, Vector3(frame_length - POST_RADIUS * 2.0, RAIL_THICKNESS, RAIL_THICKNESS))
	_rail_right.position = Vector3(0, rail_y, half_w)

	# X carriage top position
	var carriage_y := rail_y - RAIL_THICKNESS / 2.0
	if _x_carriage:
		_x_carriage.position.y = carriage_y

	# Cross beam along Y (spans the width)
	_set_box_mesh(_cross_beam, Vector3(BEAM_THICKNESS, BEAM_THICKNESS, frame_width))
	_cross_beam.position = Vector3(0, 0, 0)

	# Carriage block on Y axis
	_set_box_mesh(_carriage_block, Vector3(CARRIAGE_BLOCK_SIZE, CARRIAGE_BLOCK_SIZE, CARRIAGE_BLOCK_SIZE))
	_carriage_block.position = Vector3(0, -BEAM_THICKNESS / 2.0 - CARRIAGE_BLOCK_SIZE / 2.0, 0)

	# Z actuator (fixed to carriage, does not move with z_position)
	var actuator_top_y := -BEAM_THICKNESS / 2.0 - CARRIAGE_BLOCK_SIZE
	if _z_actuator:
		_z_actuator.position = Vector3(0, actuator_top_y, 0)

	# Rod and tool sizes only — positions are set in _update_tool_position
	_set_box_mesh(_tool_mount, Vector3(CARRIAGE_BLOCK_SIZE * 1.5, TOOL_MOUNT_HEIGHT, CARRIAGE_BLOCK_SIZE * 1.5))
	_set_cylinder_mesh(_vacuum_cup_mesh, VACUUM_CUP_RADIUS, VACUUM_CUP_HEIGHT)

	if _vacuum_cup_rim:
		var rim_mesh := _vacuum_cup_rim.mesh as TorusMesh
		if rim_mesh:
			rim_mesh.inner_radius = VACUUM_CUP_RADIUS * 0.8
			rim_mesh.outer_radius = VACUUM_CUP_RADIUS * 1.05

	if _vacuum_area:
		var col_shape := _vacuum_area.get_node_or_null("VacuumCollision") as CollisionShape3D
		if col_shape and col_shape.shape is SphereShape3D:
			(col_shape.shape as SphereShape3D).radius = VACUUM_CUP_RADIUS * 3.0

	_update_axis_positions()
	update_gizmos()


func _update_axis_positions() -> void:
	if not _initialized:
		return

	if _x_carriage:
		_x_carriage.position.x = x_position

	if _y_carriage:
		_y_carriage.position.z = y_position

	_update_tool_position()
	update_gizmos()


func _update_tool_position() -> void:
	# Rod extends like a piston; tool mount is always at the bottom tip
	var rod_length := z_position + ACTUATOR_WIDTH
	_set_box_mesh(_actuator_rod, Vector3(ACTUATOR_WIDTH, rod_length, ACTUATOR_WIDTH))
	if _actuator_rod:
		_actuator_rod.position = Vector3(0, -rod_length / 2.0, 0)

	var tip_y := -rod_length
	if _tool_mount:
		_tool_mount.position = Vector3(0, tip_y - TOOL_MOUNT_HEIGHT / 2.0, 0)

	var cup_y := tip_y - TOOL_MOUNT_HEIGHT - VACUUM_CUP_HEIGHT / 2.0
	if _vacuum_cup_mesh:
		_vacuum_cup_mesh.position = Vector3(0, cup_y, 0)

	var rim_y := cup_y - VACUUM_CUP_HEIGHT / 2.0
	if _vacuum_cup_rim:
		_vacuum_cup_rim.position = Vector3(0, rim_y, 0)

	if _vacuum_area:
		_vacuum_area.position = Vector3(0, rim_y, 0)


func _set_box_mesh(mesh_inst: MeshInstance3D, size: Vector3) -> void:
	if not mesh_inst:
		return
	var box := mesh_inst.mesh as BoxMesh
	if box:
		box.size = size


func _set_cylinder_mesh(mesh_inst: MeshInstance3D, radius: float, height: float) -> void:
	if not mesh_inst:
		return
	var cyl := mesh_inst.mesh as CylinderMesh
	if cyl:
		cyl.top_radius = radius
		cyl.bottom_radius = radius
		cyl.height = height


func _update_materials() -> void:
	if not _initialized:
		return

	var frame_mat := _create_material(Color(0.35, 0.35, 0.4), 0.6, 0.4)
	var rail_mat := _create_material(Color(0.7, 0.7, 0.75), 0.7, 0.3)
	var carriage_mat := _create_material(Color(0.9, 0.5, 0.1), 0.4, 0.5)
	var actuator_mat := _create_material(Color(0.2, 0.2, 0.25), 0.5, 0.4)
	var vacuum_color := Color(0.2, 0.6, 0.2) if vacuum_on else Color(0.15, 0.15, 0.15)
	var vacuum_mat := _create_material(vacuum_color, 0.1, 0.9)

	_apply_material([_post_fl, _post_fr, _post_bl, _post_br, _beam_front, _beam_back], frame_mat)
	_apply_material([_rail_left, _rail_right], rail_mat)
	_apply_material([_cross_beam, _carriage_block], carriage_mat)
	_apply_material([_actuator_rod, _tool_mount], actuator_mat)
	_apply_material([_vacuum_cup_mesh, _vacuum_cup_rim], vacuum_mat)


func _create_material(color: Color, metallic: float, roughness: float) -> StandardMaterial3D:
	var mat := StandardMaterial3D.new()
	mat.albedo_color = color
	mat.metallic = metallic
	mat.roughness = roughness
	return mat


func _apply_material(meshes: Array, mat: Material) -> void:
	for mesh in meshes:
		if mesh:
			mesh.material_override = mat


func get_tool_tip_position() -> Vector3:
	if _vacuum_cup_mesh and is_inside_tree():
		return _vacuum_cup_mesh.global_position - _vacuum_cup_mesh.global_transform.basis.y * (VACUUM_CUP_HEIGHT / 2.0)
	return global_position if is_inside_tree() else position


func get_tool_tip_transform() -> Transform3D:
	if _vacuum_cup_mesh and is_inside_tree():
		var tip_transform := _vacuum_cup_mesh.global_transform
		tip_transform.origin -= tip_transform.basis.y * (VACUUM_CUP_HEIGHT / 2.0)
		return tip_transform
	return global_transform if is_inside_tree() else transform


func get_axis_positions() -> Array[float]:
	return [x_position, y_position, z_position]


func set_axis_positions(positions: Array[float]) -> void:
	if positions.size() >= 1:
		x_position = positions[0]
	if positions.size() >= 2:
		y_position = positions[1]
	if positions.size() >= 3:
		z_position = positions[2]


func get_x_range() -> Vector2:
	var half := (frame_length - CARRIAGE_BLOCK_SIZE) / 2.0
	return Vector2(-half, half)


func get_y_range() -> Vector2:
	var half := (frame_width - CARRIAGE_BLOCK_SIZE) / 2.0
	return Vector2(-half, half)


func get_z_range() -> Vector2:
	return Vector2(0.0, _get_max_z_travel())


func _get_max_z_travel() -> float:
	# Carriage sits below the top beams and rails
	var overhead := BEAM_THICKNESS + RAIL_THICKNESS + CARRIAGE_BLOCK_SIZE + BEAM_THICKNESS / 2.0
	# Tool hangs below the rod
	var tool_hang := TOOL_MOUNT_HEIGHT + VACUUM_CUP_HEIGHT
	return maxf(frame_height - overhead - tool_hang, 0.1)


# --- Vacuum gripper ---


func _update_vacuum_state() -> void:
	_update_materials()
	if vacuum_on:
		_try_pick_up()
	else:
		_release_object()


func _update_held_object() -> void:
	if not _held_rigid_body or not is_instance_valid(_held_rigid_body):
		return
	if not _vacuum_area or not _vacuum_cup_mesh:
		return

	var tip_pos := _vacuum_area.global_position
	var cup_dir := -_vacuum_cup_mesh.global_transform.basis.y.normalized()

	var box_offset := 0.1
	if _held_object and "size" in _held_object:
		box_offset = _held_object.size.y * 0.5

	var target_pos := tip_pos + cup_dir * box_offset
	_held_rigid_body.global_position = target_pos
	var cup_basis := _vacuum_cup_mesh.global_transform.basis.orthonormalized()
	_held_rigid_body.global_transform.basis = cup_basis * _held_object_basis


func _try_pick_up() -> void:
	if _held_object != null:
		return

	var closest_obj: Node3D = null
	var closest_dist: float = INF
	var tip_pos := get_tool_tip_position()

	for obj in _objects_in_range:
		if not is_instance_valid(obj):
			continue

		var rigid_body: RigidBody3D = null
		if obj is RigidBody3D:
			rigid_body = obj
		elif obj.has_node("RigidBody3D"):
			rigid_body = obj.get_node("RigidBody3D")

		if rigid_body == null:
			continue

		var dist := tip_pos.distance_to(obj.global_position)
		if dist < closest_dist:
			closest_dist = dist
			closest_obj = obj

	if closest_obj:
		_attach_object(closest_obj)


func _attach_object(obj: Node3D) -> void:
	if _held_object != null:
		return

	var rigid_body: RigidBody3D = null
	var target_node: Node3D = obj

	if obj is RigidBody3D:
		rigid_body = obj
		target_node = obj.get_parent() if obj.get_parent() is Node3D else obj
	elif obj.has_node("RigidBody3D"):
		rigid_body = obj.get_node("RigidBody3D")
		target_node = obj

	_held_object = target_node
	_held_rigid_body = rigid_body

	if rigid_body and _vacuum_cup_mesh:
		var cup_basis := _vacuum_cup_mesh.global_transform.basis.orthonormalized()
		var obj_basis := rigid_body.global_transform.basis.orthonormalized()
		_held_object_basis = cup_basis.inverse() * obj_basis
	else:
		_held_object_basis = Basis.IDENTITY

	if rigid_body:
		rigid_body.gravity_scale = 0

	holding_object = true


func _release_object() -> void:
	if _held_object == null:
		return

	if not is_instance_valid(_held_object):
		_held_object = null
		_held_rigid_body = null
		holding_object = false
		return

	if _held_rigid_body and is_instance_valid(_held_rigid_body):
		_held_rigid_body.gravity_scale = 1
		_held_rigid_body.linear_velocity = Vector3.ZERO
		_held_rigid_body.angular_velocity = Vector3.ZERO

	_held_object = null
	_held_rigid_body = null
	holding_object = false


func _on_vacuum_area_body_entered(body: Node3D) -> void:
	if body not in _objects_in_range:
		_objects_in_range.append(body)
	if vacuum_on and _held_object == null:
		_try_pick_up()


func _on_vacuum_area_body_exited(body: Node3D) -> void:
	_objects_in_range.erase(body)


# --- Waypoint system ---


func move_to_home() -> void:
	if home_position.size() >= 3:
		move_to_position(home_position)
	else:
		move_to_position([0.0, 0.0, 0.0])


func set_current_as_home() -> void:
	home_position = get_axis_positions()


func set_home_action() -> void:
	set_current_as_home()


func go_home_action() -> void:
	move_to_home()


func train_waypoint_action() -> void:
	train_waypoint(new_waypoint_name)
	new_waypoint_name = _get_next_waypoint_name()


func go_to_waypoint_action() -> void:
	go_to_selected_waypoint()


func delete_waypoint_action() -> void:
	delete_waypoint(selected_waypoint)


func train_waypoint(waypoint_name: String) -> void:
	if waypoint_name.is_empty():
		push_warning("Gantry: Cannot train waypoint with empty name")
		return
	var index := waypoints.size() + 1
	var indexed_name := "%d: %s" % [index, waypoint_name]
	waypoints[indexed_name] = get_axis_positions()
	selected_waypoint = indexed_name
	notify_property_list_changed()


func _get_next_waypoint_name() -> String:
	var base_name := "Point"
	var num := 1
	for wp_name: String in waypoints.keys():
		var colon_pos: int = wp_name.find(": ")
		if colon_pos != -1:
			var name_part: String = wp_name.substr(colon_pos + 2)
			if name_part.begins_with(base_name):
				var suffix: String = name_part.substr(base_name.length())
				if suffix.is_valid_int():
					num = max(num, int(suffix) + 1)
	return base_name + str(num)


func delete_waypoint(waypoint_name: String) -> void:
	if waypoint_name.is_empty():
		push_warning("Gantry: No waypoint selected to delete")
		return
	if not waypoints.has(waypoint_name):
		push_warning("Gantry: Waypoint '%s' not found" % waypoint_name)
		return
	waypoints.erase(waypoint_name)
	if selected_waypoint == waypoint_name:
		selected_waypoint = waypoints.keys()[0] if waypoints.size() > 0 else ""
	notify_property_list_changed()


func get_waypoint_names() -> Array:
	return waypoints.keys()


func go_to_waypoint(waypoint_name: String) -> void:
	if not waypoints.has(waypoint_name):
		push_warning("Gantry: Waypoint '%s' not found" % waypoint_name)
		return

	var target: Array = waypoints[waypoint_name]
	if target.size() >= 3:
		move_to_position(target)


func go_to_selected_waypoint() -> void:
	go_to_waypoint(selected_waypoint)


func move_to_position(target_positions: Array, instant: bool = false) -> void:
	if target_positions.size() < 3:
		push_warning("Gantry: Invalid target positions array")
		return

	if _motion_tween and _motion_tween.is_valid():
		_motion_tween.kill()

	if instant:
		x_position = target_positions[0]
		y_position = target_positions[1]
		z_position = target_positions[2]
	else:
		_is_moving = true
		var current := get_axis_positions()

		var max_dist: float = 0.0
		for i in range(3):
			max_dist = max(max_dist, abs(target_positions[i] - current[i]))

		var duration: float = max(max_dist / motion_speed, 0.1)
		EditorInterface.mark_scene_as_unsaved()
		_motion_tween = create_tween()
		_motion_tween.set_parallel(true)
		_motion_tween.tween_property(self, "x_position", target_positions[0], duration)
		_motion_tween.tween_property(self, "y_position", target_positions[1], duration)
		_motion_tween.tween_property(self, "z_position", target_positions[2], duration)
		_motion_tween.chain().tween_callback(_on_motion_complete)


func _on_motion_complete() -> void:
	_is_moving = false


func is_moving() -> bool:
	return _is_moving


func stop_motion() -> void:
	if _motion_tween and _motion_tween.is_valid():
		_motion_tween.kill()
	_is_moving = false


# --- Validation ---


func _validate_property(property: Dictionary) -> void:
	if property.name == "holding_object":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_READ_ONLY

	if property.name == "selected_waypoint":
		property.hint = PROPERTY_HINT_ENUM
		property.hint_string = ",".join(waypoints.keys()) if waypoints.size() > 0 else "(no waypoints)"

	if not OIPComms:
		return

	var global_comms := OIPComms.get_enable_comms()

	if property.name == "enable_comms":
		property.usage = PROPERTY_USAGE_DEFAULT if global_comms else PROPERTY_USAGE_STORAGE
	elif property.name == "tag_group_name":
		property.usage = PROPERTY_USAGE_STORAGE
	elif property.name == "tag_groups":
		property.usage = PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_NO_INSTANCE_STATE if global_comms else PROPERTY_USAGE_NONE
	elif property.name in ["command_tag", "execute_tag", "done_tag", "vacuum_tag"]:
		property.usage = PROPERTY_USAGE_DEFAULT if global_comms else PROPERTY_USAGE_STORAGE


# --- Simulation / Comms ---


func _on_simulation_ended() -> void:
	stop_motion()
	if _held_object != null:
		_release_object()
	_objects_in_range.clear()
	vacuum_on = false
	_last_execute = false


func _on_simulation_started() -> void:
	if not enable_comms or tag_group_name.is_empty():
		return

	_register_tag_ok = true
	_last_execute = false

	if not command_tag.is_empty():
		_register_tag_ok = _register_tag_ok and OIPComms.register_tag(tag_group_name, command_tag, 1)
	if not execute_tag.is_empty():
		_register_tag_ok = _register_tag_ok and OIPComms.register_tag(tag_group_name, execute_tag, 1)
	if not done_tag.is_empty():
		_register_tag_ok = _register_tag_ok and OIPComms.register_tag(tag_group_name, done_tag, 1)
	if not vacuum_tag.is_empty():
		_register_tag_ok = _register_tag_ok and OIPComms.register_tag(tag_group_name, vacuum_tag, 1)


func _tag_group_initialized(group_name: String) -> void:
	if group_name == tag_group_name:
		_tag_group_init = true
		_write_status_tags()


func _tag_group_polled(group_name: String) -> void:
	if not _tag_group_init or not _register_tag_ok:
		return
	if group_name != tag_group_name:
		return

	if not vacuum_tag.is_empty():
		vacuum_on = OIPComms.read_bit(tag_group_name, vacuum_tag)

	if not execute_tag.is_empty():
		var execute := OIPComms.read_bit(tag_group_name, execute_tag)
		var rising_edge := execute and not _last_execute
		_last_execute = execute

		if rising_edge and not _is_moving:
			_execute_command()

	_write_status_tags()


func _execute_command() -> void:
	if command_tag.is_empty():
		return

	var cmd: int = OIPComms.read_int16(tag_group_name, command_tag)
	if cmd == null:
		return

	if cmd == 0:
		move_to_home()
	elif cmd > 0:
		var waypoint_names := waypoints.keys()
		var waypoint_index := cmd - 1
		if waypoint_index < waypoint_names.size():
			go_to_waypoint(waypoint_names[waypoint_index])
		else:
			push_warning("Gantry: Invalid waypoint index %d" % cmd)


func _write_status_tags() -> void:
	if not done_tag.is_empty():
		OIPComms.write_bit(tag_group_name, done_tag, not _is_moving)
