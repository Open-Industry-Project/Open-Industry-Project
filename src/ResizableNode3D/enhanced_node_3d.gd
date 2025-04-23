class_name EnhancedNode3D
extends Node3D


func _notification(what: int):
	# Custom notification number.
	# This would be better implemented in the engine.
	const NOTIFICATION_OWNER_SCENE_INSTANTIATED = 9999
	match what:
		NOTIFICATION_SCENE_INSTANTIATED:
			_on_scene_instantiated()
			# Walk the tree to send NOTIFICATION_OWNER_SCENE_INSTANTIATED
			var nodes_remaining: Array[Node] = get_children(true)
			while nodes_remaining:
				var descendent = nodes_remaining.pop_front()
				nodes_remaining.append_array(descendent.get_children(true))
				if descendent.owner == self:
					descendent.notification(NOTIFICATION_OWNER_SCENE_INSTANTIATED)
		NOTIFICATION_OWNER_SCENE_INSTANTIATED:
			_on_owner_scene_instantiated()


func _on_scene_instantiated() -> void:
	_on_instantiated()


func _on_owner_scene_instantiated() -> void:
	_on_instantiated()


func _on_instantiated() -> void:
	pass
