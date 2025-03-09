@tool
extends Node3D

@export var opc_test := false:
	set(value): _opc_test()

@export var reg_tag := false:
	set(value): _reg_tag()

@export var read_test := false:
	set(value): _read_test()

@export var write_test := false:
	set(value): _write_test()

func _opc_test() -> void:
	#OIPComms.opc_ua_test()
	pass

func _reg_tag() -> void:
	OIPComms.register_tag("TagGroup1", "[TEST]TEST_SPEED_INOUT", 1)

func _read_test() -> void:
	print(OIPComms.read_float32("TagGroup1", "[TEST]TEST_SPEED_INOUT"))
	pass

func _write_test() -> void:
	OIPComms.write_float32("TagGroup1", "[TEST]TEST_SPEED_INOUT", 1.1)
	pass
