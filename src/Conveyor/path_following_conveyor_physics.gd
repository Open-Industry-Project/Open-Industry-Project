@tool

extends Area3D
class_name PathFollowingConveyorPhysics

@onready var parent : PathFollowingConveyor = get_parent()

func _physics_process(_delta: float) -> void:
	if (not SimulationEvents.simulation_running) or SimulationEvents.simulation_paused:
		return

	for body in get_overlapping_bodies():
		if body is RigidBody3D:
			apply_force(body)

func apply_force(body: RigidBody3D) -> void:
	var curve = parent.path_to_follow.curve
	var path_length = curve.get_baked_length()
	var offset = clamp(curve.get_closest_offset(parent.path_to_follow.to_local(body.global_position)), 0, path_length)


	# Linear movement along the path
	var point = curve.sample_baked(offset - 0.001)
	var next_point = curve.sample_baked(offset + 0.001)
	var local_direction = (next_point - point).normalized()
	var global_direction = parent.path_to_follow.global_transform.basis * local_direction

	# Decompose body's velocity into path-aligned and perpendicular components
	var current_speed_along_path = body.linear_velocity.dot(global_direction)
	var velocity_perpendicular = body.linear_velocity - global_direction * current_speed_along_path

	# Set velocity along path to conveyor speed (same behavior as constant_linear_velocity)
	# Only speed up, don't slow down bodies already moving faster
	var new_speed_along_path = maxf(current_speed_along_path, parent.speed)
	
	# Reconstruct velocity: path component at conveyor speed + preserved perpendicular component
	body.linear_velocity = global_direction * new_speed_along_path + velocity_perpendicular

	# Calculate curvature for radial torque
	# Sample tangent vectors before and after current position
	var sample_delta: float = 0.1
	var prev_offset: float = max(offset - sample_delta, 0.0)
	var next_offset: float = min(offset + sample_delta, path_length)

	# Get tangent at previous position
	var prev_point: Vector3 = curve.sample_baked(prev_offset)
	var prev_next: Vector3 = curve.sample_baked(min(prev_offset + 0.01, path_length))
	var prev_tangent: Vector3 = (prev_next - prev_point).normalized()

	# Get tangent at next position
	var next_point_sample: Vector3 = curve.sample_baked(next_offset)
	var next_next: Vector3 = curve.sample_baked(min(next_offset + 0.01, path_length))
	var next_tangent: Vector3 = (next_next - next_point_sample).normalized()

	# Cross product gives rotation axis, angle gives curvature magnitude
	var rotation_axis: Vector3 = prev_tangent.cross(next_tangent)
	var angle: float = prev_tangent.angle_to(next_tangent)

	# Apply torque if there's significant curvature
	if rotation_axis.length_squared() > 0.0001 and abs(angle) > 0.001:
		# Torque strength proportional to speed and curvature
		# Adjust multiplier (10.0) to tune rotation responsiveness
		var torque_strength: float = parent.speed * angle * 10.0
		var global_rotation_axis = parent.path_to_follow.global_transform.basis * rotation_axis.normalized()
		body.apply_torque(global_rotation_axis * torque_strength)
