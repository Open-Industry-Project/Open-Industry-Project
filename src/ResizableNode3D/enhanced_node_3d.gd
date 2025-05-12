class_name EnhancedNode3D
extends Node3D

# Custom notification number.
# This would be better implemented in the engine.
## Sent to all owned descendents of an [EnhancedNode3D] in tree order when it receives [constant NOTIFICATION_SCENE_INSTANTIATED].
const NOTIFICATION_OWNER_SCENE_INSTANTIATED = 9999

var _instance_ready := false


func _notification(what: int) -> void:
	match what:
		NOTIFICATION_SCENE_INSTANTIATED:
			_instance_ready = true
			_on_scene_instantiated()
			# Walk descendents in tree order to send NOTIFICATION_OWNER_SCENE_INSTANTIATED.
			var nodes_remaining: Array[Node] = get_children(true)
			nodes_remaining.reverse()
			while nodes_remaining:
				var descendent = nodes_remaining.pop_back()
				if descendent.owner == self:
					descendent.notification(NOTIFICATION_OWNER_SCENE_INSTANTIATED)
				var children: Array[Node] = descendent.get_children(true)
				children.reverse()
				nodes_remaining.append_array(children)
		NOTIFICATION_OWNER_SCENE_INSTANTIATED:
			if not _instance_ready:
				_instance_ready = true
				_on_instantiated()
			_on_owner_scene_instantiated()


## Called for this node after its [PackedScene] is instantiated, but only if it is the root node of that scene.
## (Identical to [constant NOTIFICATION_SCENE_INSTANTIATED].)
func _on_scene_instantiated() -> void:
	_on_instantiated()


## Called for this node when its [member owner] receives [constant NOTIFICATION_SCENE_INSTANTIATED].
## Nodes are processed in tree order (top down, depth first), as in [method _enter_tree].
## Requires the [member owner] to be an [EnhancedNode3D].
func _on_owner_scene_instantiated() -> void:
	pass


## Called once for this node the first time it or its [member owner] receive [constant NOTIFICATION_SCENE_INSTANTIATED].
## Nodes are processed in tree order (top down, depth first), as in [method _enter_tree].
## Requires the [member owner] to be an [EnhancedNode3D] for [member owner]-initiated behavior.
func _on_instantiated() -> void:
	pass
