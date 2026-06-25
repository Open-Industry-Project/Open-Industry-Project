extends Node3D
const CT := preload("res://src/Conveyor/conveyor_transport.gd")
const SPUR := preload("res://parts/BeltSpurConveyor.tscn")
var _spur: Node3D
var _frame := 0
func _ready() -> void:
	_spur = SPUR.instantiate()
	add_child(_spur)
func _physics_process(_d: float) -> void:
	_frame += 1
	if _frame < 5:
		return
	var found := 0
	for b: Node in get_tree().get_nodes_in_group(CT.SURFACE_GROUP):
		if _spur.is_ancestor_of(b):
			found += 1
	print("SPURCHECK surface_bodies_in_group=%d (expect >=1)" % found)
	get_tree().quit()
