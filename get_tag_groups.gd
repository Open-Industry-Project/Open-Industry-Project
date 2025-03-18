@tool
extends Node3D

@export var get_tag_groups := false:
	set(value):
		print(OIPComms.get_tag_groups())
