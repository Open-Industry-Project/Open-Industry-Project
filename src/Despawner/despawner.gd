@tool
extends Area3D

func _enter_tree() -> void:
	body_entered.connect(_body_entered)
	
func _exit_tree() -> void:
	body_entered.disconnect(_body_entered)

func _body_entered(node: Node) -> void:
		var _parent = node.get_parent()
		if(_parent.has_method("selected")):
			_parent.queue_free()
			
		
