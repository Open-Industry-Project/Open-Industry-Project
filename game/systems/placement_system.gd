extends Node3D
## Handles placing equipment into the simulation.
##
## When activated with a scene path, it shows a semi-transparent preview that
## follows the mouse cursor on the floor plane.  Left-click places the object,
## right-click / Escape cancels, R rotates 90 degrees.

signal object_placed(instance: Node3D)
signal placement_cancelled

var _active: bool = false
var _scene_path: String = ""
var _preview: Node3D = null
var _rotation_y: float = 0.0
var _camera: Camera3D = null
var _simulation_root: Node3D = null
var _floor_y: float = 0.0


func setup(camera: Camera3D, simulation_root: Node3D) -> void:
	_camera = camera
	_simulation_root = simulation_root


func activate(scene_path: String) -> void:
	# Quietly clear any existing preview (without emitting cancelled signal).
	_clear_preview()
	_scene_path = scene_path
	_rotation_y = 0.0
	_active = true

	var scene := load(scene_path) as PackedScene
	if not scene:
		_active = false
		return

	_preview = scene.instantiate()
	_make_preview(_preview)
	add_child(_preview)


func deactivate() -> void:
	var was_active := _active
	_clear_preview()
	_active = false
	_scene_path = ""
	if was_active:
		placement_cancelled.emit()


## Stop placing without emitting the cancelled signal (e.g. when switching
## toolbar modes).
func cancel_silently() -> void:
	_clear_preview()
	_active = false
	_scene_path = ""


func _clear_preview() -> void:
	if _preview:
		_preview.queue_free()
		_preview = null


func is_active() -> bool:
	return _active


# ── Input handling ───────────────────────────────────────────────────────────

func _unhandled_input(event: InputEvent) -> void:
	if not _active:
		return

	if event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		if mb.pressed:
			match mb.button_index:
				MOUSE_BUTTON_LEFT:
					_place_object()
					get_viewport().set_input_as_handled()
				MOUSE_BUTTON_RIGHT:
					deactivate()
					get_viewport().set_input_as_handled()

	elif event is InputEventKey:
		var key := event as InputEventKey
		if key.pressed and not key.echo:
			if key.keycode == KEY_R:
				_rotation_y = fmod(_rotation_y + 90.0, 360.0)
				if _preview:
					_preview.rotation_degrees.y = _rotation_y
				get_viewport().set_input_as_handled()
			elif key.keycode == KEY_ESCAPE:
				deactivate()
				get_viewport().set_input_as_handled()


func _process(_delta: float) -> void:
	if _active and _preview:
		_update_preview_position(get_viewport().get_mouse_position())


# ── Internals ────────────────────────────────────────────────────────────────

func _update_preview_position(screen_pos: Vector2) -> void:
	if not _camera or not _preview:
		return

	var from := _camera.project_ray_origin(screen_pos)
	var dir := _camera.project_ray_normal(screen_pos)

	# Intersect with horizontal floor plane.
	if abs(dir.y) < 0.001:
		return

	var t := (_floor_y - from.y) / dir.y
	if t <= 0:
		return

	var hit := from + dir * t
	# Snap to 0.25 m grid.
	hit.x = snapped(hit.x, 0.25)
	hit.z = snapped(hit.z, 0.25)
	hit.y = _floor_y
	_preview.global_position = hit


func _place_object() -> void:
	if not _preview or _scene_path.is_empty():
		return

	var scene := load(_scene_path) as PackedScene
	if not scene:
		return

	var instance := scene.instantiate()
	instance.global_position = _preview.global_position
	instance.rotation_degrees.y = _rotation_y
	_simulation_root.add_child(instance)
	instance.owner = _simulation_root

	object_placed.emit(instance)


## Make all meshes transparent and disable physics so the preview doesn't
## interfere with the simulation.
func _make_preview(node: Node) -> void:
	if node is MeshInstance3D:
		(node as MeshInstance3D).transparency = 0.6
	if node is CollisionShape3D:
		(node as CollisionShape3D).disabled = true
	if node is RigidBody3D:
		(node as RigidBody3D).freeze = true
	if node is PhysicsBody3D:
		var body := node as PhysicsBody3D
		body.collision_layer = 0
		body.collision_mask = 0
	if node is AnimatableBody3D:
		(node as AnimatableBody3D).collision_layer = 0
		(node as AnimatableBody3D).collision_mask = 0

	for child in node.get_children():
		_make_preview(child)
