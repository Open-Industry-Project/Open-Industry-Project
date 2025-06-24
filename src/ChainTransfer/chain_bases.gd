@tool
class_name ChainTransferBases
extends Node3D

func set_chains_distance(distance: float) -> void:
	for chain_base: ChainTransferBase in get_children():
		chain_base.position = Vector3(0, 0, distance * chain_base.get_index())

func set_chains_speed(speed: float) -> void:
	for chain_base: ChainTransferBase in get_children():
		chain_base.speed = speed

func set_chains_popup_chains(popup_chains: bool) -> void:
	for chain_base: ChainTransferBase in get_children():
		chain_base.active = popup_chains

func turn_on_chains() -> void:
	for chain_base: ChainTransferBase in get_children():
		chain_base.turn_on()

func turn_off_chains() -> void:
	for chain_base: ChainTransferBase in get_children():
		chain_base.turn_off()

func remove_chains(count: int) -> void:
	for i in range(count):
		get_child(get_child_count() - 1 - i).queue_free()

func fix_chains(chains: int) -> void:
	var child_count: int = get_child_count()
	var difference: int = child_count - chains
	if difference <= 0:
		return
		
	for i in range(difference):
		get_child(get_child_count() - 1 - i).queue_free()
