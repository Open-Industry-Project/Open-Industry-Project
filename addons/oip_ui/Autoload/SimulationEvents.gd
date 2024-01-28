@tool
extends Node

signal simulation_started
signal simulation_set_paused(paused)
signal simulation_ended


func _ready() -> void:
	if is_instance_valid(owner):
		await owner.ready
	
		EditorInterface.set_main_screen_editor("3D")
		EditorInterface.open_scene_from_path("res://Main/Main.tscn")
