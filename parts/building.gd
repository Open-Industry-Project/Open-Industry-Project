@tool
class_name Building
extends Node3D

@export_range(0, 20, 0.1) var brightness: float = 6:
	set(value):
		if not is_node_ready():
			return
		brightness = value
		for light: OmniLight3D in lights.get_children():
			light.light_energy = brightness

@onready var lights: Node3D = $Lights
