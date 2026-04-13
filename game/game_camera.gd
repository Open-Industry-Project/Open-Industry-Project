extends Camera3D
## Orbit camera with WASD pan, right-click orbit, scroll zoom.
## Designed for a Factory-IO-like top-down/isometric simulation view.

@export var orbit_sensitivity: float = 0.3   ## Degrees per mouse pixel.
@export var pan_speed: float = 20.0          ## Metres per second (keyboard).
@export var zoom_speed: float = 2.0          ## Distance per scroll notch.
@export var min_distance: float = 3.0
@export var max_distance: float = 120.0
@export var min_pitch: float = -89.0
@export var max_pitch: float = -5.0

const _ZOOM_SCALE_DIVISOR := 20.0   ## Zoom scales proportionally to distance.
const _PAN_SCALE_DIVISOR := 40.0    ## Mouse pan scales proportionally to distance.

## Current orbit state.
var _distance: float = 30.0
var _yaw_deg: float = -45.0
var _pitch_deg: float = -45.0
var _target: Vector3 = Vector3(0, 0, 0)

var _orbiting: bool = false
var _panning_mouse: bool = false


func _ready() -> void:
	_update_transform()


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		match mb.button_index:
			MOUSE_BUTTON_RIGHT:
				_orbiting = mb.pressed
			MOUSE_BUTTON_MIDDLE:
				_panning_mouse = mb.pressed
			MOUSE_BUTTON_WHEEL_UP:
				if mb.pressed:
					_distance = max(_distance - zoom_speed * (_distance / _ZOOM_SCALE_DIVISOR), min_distance)
					_update_transform()
			MOUSE_BUTTON_WHEEL_DOWN:
				if mb.pressed:
					_distance = min(_distance + zoom_speed * (_distance / _ZOOM_SCALE_DIVISOR), max_distance)
					_update_transform()

	elif event is InputEventMouseMotion:
		var mm := event as InputEventMouseMotion
		if _orbiting:
			_yaw_deg -= mm.relative.x * orbit_sensitivity
			_pitch_deg = clamp(
				_pitch_deg - mm.relative.y * orbit_sensitivity,
				min_pitch, max_pitch
			)
			_update_transform()
		elif _panning_mouse:
			var right := global_transform.basis.x
			var forward := Vector3(-global_transform.basis.z.x, 0, -global_transform.basis.z.z).normalized()
			var factor := _distance / _PAN_SCALE_DIVISOR
			_target -= right * mm.relative.x * 0.05 * factor
			_target -= forward * mm.relative.y * 0.05 * factor
			_update_transform()


func _process(delta: float) -> void:
	# Skip keyboard panning when a UI control (e.g. search bar) has focus.
	if get_viewport().gui_get_focus_owner() is LineEdit:
		return

	# Keyboard panning (WASD / arrow keys).
	var dir := Vector3.ZERO
	if Input.is_key_pressed(KEY_A) or Input.is_key_pressed(KEY_LEFT):
		dir.x -= 1.0
	if Input.is_key_pressed(KEY_D) or Input.is_key_pressed(KEY_RIGHT):
		dir.x += 1.0
	if Input.is_key_pressed(KEY_W) or Input.is_key_pressed(KEY_UP):
		dir.z -= 1.0
	if Input.is_key_pressed(KEY_S) or Input.is_key_pressed(KEY_DOWN):
		dir.z += 1.0

	if dir != Vector3.ZERO:
		var speed := pan_speed
		if Input.is_key_pressed(KEY_SHIFT):
			speed *= 2.5

		var right := global_transform.basis.x
		right.y = 0.0
		right = right.normalized()
		var forward := Vector3(-global_transform.basis.z.x, 0, -global_transform.basis.z.z).normalized()

		_target += (right * dir.x + forward * dir.z) * speed * delta
		_update_transform()


func _update_transform() -> void:
	var yaw_rad := deg_to_rad(_yaw_deg)
	var pitch_rad := deg_to_rad(_pitch_deg)

	var offset := Vector3(
		_distance * cos(pitch_rad) * sin(yaw_rad),
		-_distance * sin(pitch_rad),
		_distance * cos(pitch_rad) * cos(yaw_rad),
	)

	global_position = _target + offset
	look_at(_target, Vector3.UP)
