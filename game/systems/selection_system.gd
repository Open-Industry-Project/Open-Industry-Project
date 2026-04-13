extends Node
## In-game object selection, movement, rotation and deletion.
##
## Left-click to select (raycasts into physics world), G to grab/move,
## R to rotate 90°, Delete/Backspace to delete the selected object.

signal selection_changed(selected_node: Node3D)

var _camera: Camera3D = null
var _simulation_root: Node3D = null

var _selected: Node3D = null
var _moving: bool = false
var _move_origin: Vector3 = Vector3.ZERO
var _floor_y: float = 0.0
var _highlight_box: MeshInstance3D = null


func setup(camera: Camera3D, simulation_root: Node3D) -> void:
	_camera = camera
	_simulation_root = simulation_root


func get_selected() -> Node3D:
	return _selected


func select(node: Node3D) -> void:
	_clear_highlight()
	_selected = node
	if _selected:
		_add_highlight(_selected)
	selection_changed.emit(_selected)


func deselect() -> void:
	select(null)


func is_moving() -> bool:
	return _moving


# ── Input ────────────────────────────────────────────────────────────────────

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		if mb.pressed and mb.button_index == MOUSE_BUTTON_LEFT:
			if _moving:
				# Confirm move.
				_moving = false
				get_viewport().set_input_as_handled()
				return
			# Try to select under cursor.
			_try_select(mb.position)

	elif event is InputEventMouseMotion:
		if _moving and _selected:
			_update_move((event as InputEventMouseMotion).position)

	elif event is InputEventKey:
		var key := event as InputEventKey
		if key.pressed and not key.echo and _selected:
			match key.keycode:
				KEY_DELETE, KEY_BACKSPACE:
					_delete_selected()
					get_viewport().set_input_as_handled()
				KEY_G:
					if not _moving:
						_moving = true
						_move_origin = _selected.global_position
					get_viewport().set_input_as_handled()
				KEY_R:
					_selected.rotation_degrees.y = fmod(_selected.rotation_degrees.y + 90.0, 360.0)
					get_viewport().set_input_as_handled()
				KEY_ESCAPE:
					if _moving:
						_selected.global_position = _move_origin
						_moving = false
					else:
						deselect()
					get_viewport().set_input_as_handled()


# ── Helpers ──────────────────────────────────────────────────────────────────

func _try_select(screen_pos: Vector2) -> void:
	if not _camera:
		return

	var from := _camera.project_ray_origin(screen_pos)
	var to := from + _camera.project_ray_normal(screen_pos) * 500.0

	var space := _camera.get_world_3d().direct_space_state
	var query := PhysicsRayQueryParameters3D.create(from, to)
	query.collision_mask = 0xFFFFFFFF
	var result := space.intersect_ray(query)

	if result.is_empty():
		deselect()
		return

	var collider := result["collider"] as Node
	if collider:
		var top_level := _find_simulation_child(collider)
		if top_level:
			select(top_level)
			return

	deselect()


func _find_simulation_child(node: Node) -> Node3D:
	if not _simulation_root:
		return null
	var current := node
	while current:
		if current.get_parent() == _simulation_root:
			return current as Node3D
		current = current.get_parent()
	return null


func _update_move(screen_pos: Vector2) -> void:
	if not _camera or not _selected:
		return

	var from := _camera.project_ray_origin(screen_pos)
	var dir := _camera.project_ray_normal(screen_pos)

	if abs(dir.y) < 0.001:
		return

	var t := (_floor_y - from.y) / dir.y
	if t <= 0:
		return

	var hit := from + dir * t
	hit.x = snapped(hit.x, 0.25)
	hit.z = snapped(hit.z, 0.25)
	hit.y = _floor_y
	_selected.global_position = hit


func _delete_selected() -> void:
	if _selected:
		var node := _selected
		deselect()
		node.queue_free()


# ── Visual highlight (translucent bounding box) ─────────────────────────────

func _add_highlight(node: Node3D) -> void:
	_clear_highlight()

	var aabb := _get_combined_aabb(node)
	if aabb.size.length() < 0.001:
		return

	var box_mesh := BoxMesh.new()
	box_mesh.size = aabb.size + Vector3(0.08, 0.08, 0.08)

	var mat := StandardMaterial3D.new()
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.albedo_color = Color(0.3, 0.7, 1.0, 0.12)
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.no_depth_test = true
	box_mesh.material = mat

	_highlight_box = MeshInstance3D.new()
	_highlight_box.mesh = box_mesh
	# Centre the box on the AABB, expressed in the node's local space.
	_highlight_box.position = aabb.get_center()
	node.add_child(_highlight_box)


func _clear_highlight() -> void:
	if _highlight_box and is_instance_valid(_highlight_box):
		_highlight_box.queue_free()
	_highlight_box = null


func _get_combined_aabb(node: Node3D) -> AABB:
	var meshes: Array[MeshInstance3D] = []
	_collect_meshes(node, meshes)

	if meshes.is_empty():
		return AABB()

	var inv := node.global_transform.inverse()
	var first_mesh := meshes[0]
	var result := inv * (first_mesh.global_transform * first_mesh.get_aabb())

	for i in range(1, meshes.size()):
		var mi := meshes[i]
		var world_aabb := mi.global_transform * mi.get_aabb()
		result = result.merge(inv * world_aabb)

	return result


func _collect_meshes(node: Node, out: Array[MeshInstance3D]) -> void:
	if node is MeshInstance3D:
		out.append(node as MeshInstance3D)
	for child in node.get_children():
		_collect_meshes(child, out)
