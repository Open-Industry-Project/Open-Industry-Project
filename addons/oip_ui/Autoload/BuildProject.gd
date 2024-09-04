@tool
extends Node

var BuildNode: Node

func _ready():
	BuildNode = find_build_panel(get_parent())
	
func build():
	BuildNode.BuildProject()

func find_build_panel(node):
	# Iterate through each child of the current node
	for child in node.get_children():
		# Check if the child has the 'BuildProject' method
		if child.has_method("BuildProject"):
			return child  # Return the child if it has the method
		else:
			var found_child = find_build_panel(child)
			if found_child != null:
				return found_child  # Return the found child up the call stack
	return null  # Return None if no child with the method is found
