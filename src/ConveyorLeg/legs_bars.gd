@tool
extends Node3D
class_name LegBars

@export var legs_bar_scene: PackedScene
var bars_distance: float = 1.0

@export var parent_scale: Vector3 = Vector3.ONE:
	set(value):
		var rounded_scale: int = floor(value.y) + 1
		while (rounded_scale - 1 > get_child_count() and rounded_scale != 0):
			SpawnBar()
		while (get_child_count() > rounded_scale - 1 and get_child_count() > 1):
			RemoveBar()
		parent_scale = value
		set_process(true)

var bar_owner: ConveyorLeg
var prev_scale: Vector3

func _ready() -> void:
	bar_owner = get_owner() as ConveyorLeg
	FixBars()
	# Trigger the setter to adjust the bars based on the current parent_scale.
	parent_scale = parent_scale

func _process(delta: float) -> void:
	if owner:
		if parent_scale == prev_scale:
			return
		var new_scale: Vector3 = Vector3(1 / parent_scale.x, 1 / parent_scale.y, 1)
		if scale != new_scale:
			scale = new_scale
		prev_scale = parent_scale
	set_process(false)

func SpawnBar() -> void:
	var legs_bar: Node3D = legs_bar_scene.instantiate() as Node3D
	add_child(legs_bar)
	legs_bar.owner = self
	legs_bar.position = Vector3(0, bars_distance * get_child_count(), 0)
	FixBars()

func RemoveBar() -> void:
	var child = get_child(get_child_count() - 1)
	child.queue_free()
	remove_child(child)

func FixBars() -> void:
	if get_parent() == null:
		return
	var first_child: Node3D = get_child(0) as Node3D
	first_child.owner = get_parent()
	first_child.position = Vector3(0, bars_distance, 0)
