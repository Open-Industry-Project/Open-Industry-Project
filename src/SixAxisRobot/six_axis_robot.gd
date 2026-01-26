@tool
class_name SixAxisRobot
extends Node3D

## A standard 6-axis articulated robot arm with vacuum gripper.
## Joint configuration:
## - J1: Base rotation (vertical axis)
## - J2: Shoulder (horizontal axis)
## - J3: Elbow (horizontal axis)
## - J4: Wrist rotation (forearm roll)
## - J5: Wrist pitch (horizontal axis)
## - J6: Tool rotation (end effector roll)

const BASE_SCALE := 3.0

@export_tool_button("Set Home") var action_set_home = set_home_action
@export_tool_button("Go Home") var action_go_home = go_home_action
@export_tool_button("Train Waypoint") var action_train = train_waypoint_action
@export_tool_button("Go To Waypoint") var action_go_to = go_to_waypoint_action
@export_tool_button("Delete Waypoint") var action_delete = delete_waypoint_action

@export var home_position: Array[float] = [0.0, -45.0, 90.0, 25.0, 75.0, 0.0]
@export var waypoints: Dictionary = {}
@export_range(1.0, 180.0, 1.0, "suffix:°/s") var motion_speed: float = 45.0
@export var selected_waypoint: String = ""
@export var new_waypoint_name: String = "Point1"

@export_category("Vacuum Gripper")
## Activates the vacuum gripper
@export var vacuum_on: bool = false:
	set(value):
		vacuum_on = value
		_update_vacuum_state()

## Whether an object is currently held (read-only)
@export var holding_object: bool = false:
	set(value):
		holding_object = value
	get:
		return _held_object != null

@export_category("Joint Angles")
## Base rotation
@export_range(-180, 180, 0.1, "suffix:°") var j1_angle: float = 0.0:
	set(value):
		j1_angle = value
		_update_joints()

## Shoulder angle
@export_range(-135, 135, 0.1, "suffix:°") var j2_angle: float = -45.0:
	set(value):
		j2_angle = value
		_update_joints()

## Elbow angle
@export_range(-160, 160, 0.1, "suffix:°") var j3_angle: float = 90.0:
	set(value):
		j3_angle = value
		_update_joints()

## Wrist rotation
@export_range(-180, 180, 0.1, "suffix:°") var j4_angle: float = 25.0:
	set(value):
		j4_angle = value
		_update_joints()

## Wrist pitch
@export_range(-120, 120, 0.1, "suffix:°") var j5_angle: float = 75.0:
	set(value):
		j5_angle = value
		_update_joints()

## Tool rotation
@export_range(-360, 360, 0.1, "suffix:°") var j6_angle: float = 0.0:
	set(value):
		j6_angle = value
		_update_joints()

@export_category("Settings")
## Scale factor for the entire robot
@export_range(0.1, 10.0, 0.1) var robot_scale: float = 3.0:
	set(value):
		robot_scale = value
		_update_scale()

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
## Waypoint index to move to (0 = home, 1+ = waypoint by order)
@export var command_tag: String = ""
## Rising edge triggers movement to command waypoint
@export var execute_tag: String = ""
## True when robot has reached target position
@export var done_tag: String = ""
## Vacuum gripper control
@export var vacuum_tag: String = ""

var _register_tag_ok: bool = false
var _tag_group_init: bool = false
var _tag_group_original: String
var _last_execute: bool = false

var _base_pivot: Node3D
var _upper_arm_pivot: Node3D
var _forearm_pivot: Node3D
var _wrist_rot_pivot: Node3D
var _wrist_pitch_pivot: Node3D
var _tool_pivot: Node3D

var _base_mesh: MeshInstance3D
var _shoulder_mesh: MeshInstance3D
var _shoulder_joint_mesh: MeshInstance3D
var _upper_arm_mesh: MeshInstance3D
var _elbow_mesh: MeshInstance3D
var _forearm_mesh: MeshInstance3D
var _wrist_joint_mesh: MeshInstance3D
var _wrist_mesh: MeshInstance3D
var _tool_mesh: MeshInstance3D
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


func _init() -> void:
	_tag_group_original = tag_group_name


func _enter_tree() -> void:
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
	_update_scale()
	_update_joints()
	_update_materials()
	new_waypoint_name = _get_next_waypoint_name()
	
	if _vacuum_area:
		if not _vacuum_area.body_entered.is_connected(_on_vacuum_area_body_entered):
			_vacuum_area.body_entered.connect(_on_vacuum_area_body_entered)
		if not _vacuum_area.body_exited.is_connected(_on_vacuum_area_body_exited):
			_vacuum_area.body_exited.connect(_on_vacuum_area_body_exited)


func _process(delta: float) -> void:
	_update_held_object(delta)


func _setup_node_references() -> void:
	_base_pivot = get_node_or_null("BasePivot")
	if not _base_pivot:
		return
	
	_initialized = true
	
	var shoulder_pivot := _base_pivot.get_node_or_null("ShoulderPivot")
	_upper_arm_pivot = shoulder_pivot.get_node_or_null("UpperArmPivot") if shoulder_pivot else null
	
	var elbow_pivot := _upper_arm_pivot.get_node_or_null("ElbowPivot") if _upper_arm_pivot else null
	_forearm_pivot = elbow_pivot.get_node_or_null("ForearmPivot") if elbow_pivot else null
	
	_wrist_rot_pivot = _forearm_pivot.get_node_or_null("WristRotPivot") if _forearm_pivot else null
	_wrist_pitch_pivot = _wrist_rot_pivot.get_node_or_null("WristPitchPivot") if _wrist_rot_pivot else null
	_tool_pivot = _wrist_pitch_pivot.get_node_or_null("ToolPivot") if _wrist_pitch_pivot else null
	
	_base_mesh = _base_pivot.get_node_or_null("BaseMesh")
	_shoulder_mesh = shoulder_pivot.get_node_or_null("ShoulderMesh") if shoulder_pivot else null
	_shoulder_joint_mesh = shoulder_pivot.get_node_or_null("ShoulderJointMesh") if shoulder_pivot else null
	_upper_arm_mesh = _upper_arm_pivot.get_node_or_null("UpperArmMesh") if _upper_arm_pivot else null
	_elbow_mesh = elbow_pivot.get_node_or_null("ElbowMesh") if elbow_pivot else null
	_forearm_mesh = _forearm_pivot.get_node_or_null("ForearmMesh") if _forearm_pivot else null
	_wrist_joint_mesh = _forearm_pivot.get_node_or_null("WristJointMesh") if _forearm_pivot else null
	_wrist_mesh = _wrist_pitch_pivot.get_node_or_null("WristMesh") if _wrist_pitch_pivot else null
	_tool_mesh = _tool_pivot.get_node_or_null("ToolMesh") if _tool_pivot else null
	_vacuum_cup_mesh = _tool_pivot.get_node_or_null("VacuumCup") if _tool_pivot else null
	_vacuum_cup_rim = _tool_pivot.get_node_or_null("VacuumCupRim") if _tool_pivot else null
	_vacuum_area = _tool_pivot.get_node_or_null("VacuumArea") if _tool_pivot else null


func _update_held_object(_delta: float) -> void:
	if not _held_rigid_body or not is_instance_valid(_held_rigid_body):
		return
	if not _vacuum_area or not _vacuum_cup_mesh:
		return
	
	var tip_pos := _vacuum_area.global_position
	var cup_dir := _vacuum_cup_mesh.global_transform.basis.y.normalized()
	
	var box_offset := 0.1
	if _held_object and "size" in _held_object:
		box_offset = _held_object.size.y * 0.5
	
	var target_pos := tip_pos + cup_dir * box_offset
	_held_rigid_body.global_position = target_pos
	var cup_basis := _vacuum_cup_mesh.global_transform.basis.orthonormalized()
	_held_rigid_body.global_transform.basis = cup_basis * _held_object_basis


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


func _property_can_revert(property: StringName) -> bool:
	return property == "tag_groups"


func _property_get_revert(property: StringName) -> Variant:
	if property == "tag_groups":
		return _tag_group_original
	return null


func _update_scale() -> void:
	if not _base_pivot:
		return
	var scale_factor := robot_scale / BASE_SCALE
	_base_pivot.scale = Vector3.ONE * scale_factor
	update_gizmos()


func _update_joints() -> void:
	if not _initialized:
		return
	
	if _base_pivot:
		_base_pivot.rotation.y = deg_to_rad(j1_angle)
	if _upper_arm_pivot:
		_upper_arm_pivot.rotation.z = deg_to_rad(j2_angle)
	if _forearm_pivot:
		_forearm_pivot.rotation.z = deg_to_rad(j3_angle)
	if _wrist_rot_pivot:
		_wrist_rot_pivot.rotation.y = deg_to_rad(j4_angle)
	if _wrist_pitch_pivot:
		_wrist_pitch_pivot.rotation.z = deg_to_rad(j5_angle)
	if _tool_pivot:
		_tool_pivot.rotation.y = deg_to_rad(j6_angle)
	
	update_gizmos()


func _update_materials() -> void:
	if not _initialized:
		return
	
	var base_mat := _create_material(Color(0.3, 0.3, 0.35), 0.3, 0.7)
	var arm_mat := _create_material(Color(0.9, 0.5, 0.1), 0.4, 0.5)
	var tool_mat := _create_material(Color(0.2, 0.2, 0.25), 0.5, 0.4)
	var vacuum_color := Color(0.2, 0.6, 0.2) if vacuum_on else Color(0.15, 0.15, 0.15)
	var vacuum_mat := _create_material(vacuum_color, 0.1, 0.9)
	
	_apply_material([_base_mesh, _shoulder_mesh], base_mat)
	_apply_material([_shoulder_joint_mesh, _upper_arm_mesh, _elbow_mesh, _forearm_mesh, _wrist_joint_mesh, _wrist_mesh], arm_mat)
	_apply_material([_tool_mesh], tool_mat)
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
		var cup_height: float = _vacuum_cup_mesh.mesh.height if _vacuum_cup_mesh.mesh else 0.09
		return _vacuum_cup_mesh.global_position + _vacuum_cup_mesh.global_transform.basis.y * (cup_height / 2.0)
	return global_position if is_inside_tree() else position


func get_tool_tip_transform() -> Transform3D:
	if _vacuum_cup_mesh and is_inside_tree():
		var tip_transform := _vacuum_cup_mesh.global_transform
		var cup_height: float = _vacuum_cup_mesh.mesh.height if _vacuum_cup_mesh.mesh else 0.09
		tip_transform.origin += tip_transform.basis.y * (cup_height / 2.0)
		return tip_transform
	return global_transform if is_inside_tree() else transform


func _update_vacuum_state() -> void:
	_update_materials()
	
	if vacuum_on:
		_try_pick_up()
	else:
		_release_object()


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


func set_joint_angles(angles: Array[float]) -> void:
	if angles.size() >= 1:
		j1_angle = angles[0]
	if angles.size() >= 2:
		j2_angle = angles[1]
	if angles.size() >= 3:
		j3_angle = angles[2]
	if angles.size() >= 4:
		j4_angle = angles[3]
	if angles.size() >= 5:
		j5_angle = angles[4]
	if angles.size() >= 6:
		j6_angle = angles[5]


func get_joint_angles() -> Array[float]:
	return [j1_angle, j2_angle, j3_angle, j4_angle, j5_angle, j6_angle]


func move_to_home() -> void:
	if home_position.size() >= 6:
		move_to_position(home_position)
	else:
		move_to_position([0.0, 0.0, 0.0, 0.0, 0.0, 0.0])


func set_current_as_home() -> void:
	home_position = get_joint_angles()


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
		push_warning("SixAxisRobot: Cannot train waypoint with empty name")
		return
	var index := waypoints.size() + 1
	var indexed_name := "%d: %s" % [index, waypoint_name]
	waypoints[indexed_name] = get_joint_angles()
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
		push_warning("SixAxisRobot: No waypoint selected to delete")
		return
	if not waypoints.has(waypoint_name):
		push_warning("SixAxisRobot: Waypoint '%s' not found" % waypoint_name)
		return
	waypoints.erase(waypoint_name)
	if selected_waypoint == waypoint_name:
		selected_waypoint = waypoints.keys()[0] if waypoints.size() > 0 else ""
	notify_property_list_changed()


func get_waypoint_names() -> Array:
	return waypoints.keys()


func go_to_waypoint(waypoint_name: String) -> void:
	if not waypoints.has(waypoint_name):
		push_warning("SixAxisRobot: Waypoint '%s' not found" % waypoint_name)
		return
	
	var target_angles: Array = waypoints[waypoint_name]
	if target_angles.size() >= 6:
		move_to_position(target_angles)


func go_to_selected_waypoint() -> void:
	go_to_waypoint(selected_waypoint)


func move_to_position(target_angles: Array, instant: bool = false) -> void:
	if target_angles.size() < 6:
		push_warning("SixAxisRobot: Invalid target angles array")
		return
	
	if _motion_tween and _motion_tween.is_valid():
		_motion_tween.kill()
	
	if instant:
		j1_angle = target_angles[0]
		j2_angle = target_angles[1]
		j3_angle = target_angles[2]
		j4_angle = target_angles[3]
		j5_angle = target_angles[4]
		j6_angle = target_angles[5]
	else:
		_is_moving = true
		var current := get_joint_angles()
		
		var adjusted_targets: Array[float] = []
		for i in range(6):
			adjusted_targets.append(_shortest_angle_path(current[i], target_angles[i]))
		
		var max_diff: float = 0.0
		for i in range(6):
			max_diff = max(max_diff, abs(adjusted_targets[i] - current[i]))
		
		var duration: float = max(max_diff / motion_speed, 0.1)
		EditorInterface.mark_scene_as_unsaved()
		_motion_tween = create_tween()
		_motion_tween.set_parallel(true)
		_motion_tween.tween_property(self, "j1_angle", adjusted_targets[0], duration)
		_motion_tween.tween_property(self, "j2_angle", adjusted_targets[1], duration)
		_motion_tween.tween_property(self, "j3_angle", adjusted_targets[2], duration)
		_motion_tween.tween_property(self, "j4_angle", adjusted_targets[3], duration)
		_motion_tween.tween_property(self, "j5_angle", adjusted_targets[4], duration)
		_motion_tween.tween_property(self, "j6_angle", adjusted_targets[5], duration)
		_motion_tween.chain().tween_callback(_on_motion_complete)


func _shortest_angle_path(from_angle: float, to_angle: float) -> float:
	var diff := fmod(to_angle - from_angle + 180.0, 360.0) - 180.0
	if diff < -180.0:
		diff += 360.0
	return from_angle + diff


func _on_motion_complete() -> void:
	_is_moving = false


func is_moving() -> bool:
	return _is_moving


func stop_motion() -> void:
	if _motion_tween and _motion_tween.is_valid():
		_motion_tween.kill()
	_is_moving = false


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
	
	# Read vacuum control
	if not vacuum_tag.is_empty():
		vacuum_on = OIPComms.read_bit(tag_group_name, vacuum_tag)
	
	# Read execute signal and detect rising edge
	if not execute_tag.is_empty():
		var execute := OIPComms.read_bit(tag_group_name, execute_tag)
		var rising_edge := execute and not _last_execute
		_last_execute = execute
		
		if rising_edge and not _is_moving:
			_execute_command()
	
	# Write status back to PLC
	_write_status_tags()


func _execute_command() -> void:
	if command_tag.is_empty():
		return
	
	var cmd: int = OIPComms.read_int32(tag_group_name, command_tag)
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
			push_warning("SixAxisRobot: Invalid waypoint index %d" % cmd)


func _write_status_tags() -> void:
	if not done_tag.is_empty():
		OIPComms.write_bit(tag_group_name, done_tag, not _is_moving)
