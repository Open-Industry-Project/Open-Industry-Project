@tool
class_name Despawner
extends Node3D

@onready var _area_3d: Area3D = $Area3D

@export var monitoring: bool = true:
	set(value):
		if _area_3d:
			_area_3d.monitoring = value
	get:
		return _area_3d.monitoring if _area_3d else true

func _ready() -> void:
	if _area_3d:
		_area_3d.body_entered.connect(_body_entered)

func _exit_tree() -> void:
	if _area_3d and is_instance_valid(_area_3d) and _area_3d.body_entered.is_connected(_body_entered):
		_area_3d.body_entered.disconnect(_body_entered)

func _body_entered(node: Node) -> void:
	var _parent = node.get_parent()
	if _parent.has_method("selected") and _parent.get("instanced"):
		_parent.queue_free()
