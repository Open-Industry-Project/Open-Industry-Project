@tool
class_name Despawner
extends Node3D

@onready var _area_3d: Area3D = $Area3D

func _ready() -> void:
	_area_3d.body_entered.connect(_body_entered)

func _exit_tree() -> void:
	_area_3d.body_entered.disconnect(_body_entered)

func _body_entered(node: Node) -> void:
	var _parent = node.get_parent()
	if _parent.has_method("selected"):
		_parent.queue_free()
