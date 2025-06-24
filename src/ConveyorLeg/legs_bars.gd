@tool
class_name LegBars
extends Node3D

@export var legs_bar_scene: PackedScene

@export var parent_scale: Vector3 = Vector3.ONE:
	set(value):
		var rounded_scale: int = floor(value.y) + 1
		while (rounded_scale - 1 > get_child_count() and rounded_scale != 0):
			spawn_bar()
		while (get_child_count() > rounded_scale - 1 and get_child_count() > 1):
			remove_bar()
		parent_scale = value
		_update_scale()

var bars_distance: float = 1.0
var prev_scale: Vector3

func _ready() -> void:
	set_notify_transform(true)
	fix_bars()
	parent_scale = parent_scale

func _notification(what: int) -> void:
	if what == NOTIFICATION_TRANSFORM_CHANGED:
		if owner and parent_scale != prev_scale:
			_update_scale()

func spawn_bar() -> void:
	var legs_bar: Node3D = legs_bar_scene.instantiate() as Node3D
	add_child(legs_bar)
	legs_bar.owner = self
	legs_bar.position = Vector3(0, bars_distance * get_child_count(), 0)
	fix_bars()

func remove_bar() -> void:
	var child: Node = get_child(get_child_count() - 1)
	child.queue_free()
	remove_child(child)

func fix_bars() -> void:
	if get_parent() == null:
		return
	
	var first_child: Node3D = get_child(0) as Node3D
	first_child.owner = get_parent()
	first_child.position = Vector3(0, bars_distance, 0)

func _update_scale() -> void:
	if owner:
		var new_scale: Vector3 = Vector3(1 / parent_scale.x, 1 / parent_scale.y, 1)
		if scale != new_scale:
			scale = new_scale
		prev_scale = parent_scale
