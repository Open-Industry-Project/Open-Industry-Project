@tool
class_name ConveyorLeg
extends Node3D

@export_range(-60, 60, 0.1, "degrees") var grabs_rotation: float = 0.0:
	set(value):
		grabs_rotation = value
		on_grabs_updated()

var legs_sides_material: ShaderMaterial
var prev_scale: Vector3


func _init() -> void:
	set_notify_local_transform(true)


func _notification(what: int) -> void:
	if what == NOTIFICATION_LOCAL_TRANSFORM_CHANGED:
		var constrained_scale: Vector3 = constrain_scale()
		if constrained_scale != scale:
			scale = constrained_scale
		on_scale_changed()


func _ensure_material() -> void:
	if legs_sides_material != null:
		return
	var side1: MeshInstance3D = get_node_or_null("Sides/LegsSide1") as MeshInstance3D
	if side1 == null or side1.mesh == null:
		return
	var base_mat: ShaderMaterial = side1.mesh.surface_get_material(0) as ShaderMaterial
	if base_mat == null:
		return
	legs_sides_material = base_mat.duplicate() as ShaderMaterial
	side1.set_surface_override_material(0, legs_sides_material)
	var side2: MeshInstance3D = get_node_or_null("Sides/LegsSide2") as MeshInstance3D
	if side2:
		side2.set_surface_override_material(0, legs_sides_material)


func constrain_scale() -> Vector3:
	var node_scale_y: float = max(1.0, scale.y)
	var node_scale_z: float = scale.z
	return Vector3(1, node_scale_y, node_scale_z)


func on_scale_changed() -> void:
	if scale == prev_scale:
		return

	_ensure_material()
	if legs_sides_material:
		legs_sides_material.set_shader_parameter("Scale", scale.y)
	var legs_bars: LegBars = get_node_or_null("LegsBars") as LegBars
	if legs_bars and legs_bars.parent_scale != scale:
		legs_bars.parent_scale = scale
	var ends: Node3D = get_node_or_null("Ends") as Node3D
	if ends:
		var ends_inv := Vector3(1.0 / scale.x, 1.0 / scale.y, 1.0 / scale.z)
		for end in ends.get_children():
			if end is Node3D:
				(end as Node3D).scale = ends_inv
	var sides_inv := Vector3(1.0 / scale.x, 1.0, 1.0 / scale.z)
	var side1: Node3D = get_node_or_null("Sides/LegsSide1") as Node3D
	if side1:
		side1.scale = sides_inv
	var side2: Node3D = get_node_or_null("Sides/LegsSide2") as Node3D
	if side2:
		side2.scale = sides_inv
	prev_scale = scale


static func resolve_foot(conveyor: Node3D, belt_bottom_world: Vector3,
		legs_normal_world: Vector3, fallback_plane: Plane) -> Variant:
	if conveyor.is_inside_tree() and Engine.is_in_physics_frame():
		var world := conveyor.get_world_3d()
		if world != null and world.direct_space_state != null:
			var exclude_rids: Array[RID] = []
			_collect_collision_rids(conveyor, exclude_rids)
			var query := PhysicsRayQueryParameters3D.new()
			query.from = belt_bottom_world
			query.to = belt_bottom_world - legs_normal_world * 100.0
			query.exclude = exclude_rids
			var hit := world.direct_space_state.intersect_ray(query)
			if not hit.is_empty():
				var foot: Vector3 = hit.position
				return foot
	var foot_v: Variant = fallback_plane.intersects_ray(belt_bottom_world, -legs_normal_world)
	if foot_v == null:
		foot_v = fallback_plane.intersects_ray(belt_bottom_world, legs_normal_world)
	return foot_v


static func _collect_collision_rids(node: Node, out: Array[RID]) -> void:
	if node is CollisionObject3D:
		out.append((node as CollisionObject3D).get_rid())
	for child in node.get_children(true):
		_collect_collision_rids(child, out)


static func capture_leg_state(node: Node3D) -> Dictionary:
	var s: Dictionary = {"xform": node.global_transform}
	if &"size" in node:
		s["size"] = node.get(&"size")
	if &"floor_plane" in node:
		s["floor_plane"] = node.get(&"floor_plane")
	return s


static func legs_state_changed(node: Node3D, last: Dictionary) -> bool:
	if last.is_empty():
		return true
	if node.global_transform != last.get("xform"):
		return true
	if &"size" in node and node.get(&"size") != last.get("size"):
		return true
	if &"floor_plane" in node and node.get(&"floor_plane") != last.get("floor_plane"):
		return true
	return false


func on_grabs_updated() -> void:
	var grab1: MeshInstance3D = get_node_or_null("Ends/LegsTop1/LegsGrab1") as MeshInstance3D
	if grab1:
		grab1.rotation_degrees = Vector3(0, 0, grabs_rotation)
		grab1.scale = Vector3.ONE
	var grab2: MeshInstance3D = get_node_or_null("Ends/LegsTop2/LegsGrab2") as MeshInstance3D
	if grab2:
		grab2.rotation_degrees = Vector3(0, 0, -grabs_rotation)
		grab2.scale = Vector3.ONE
