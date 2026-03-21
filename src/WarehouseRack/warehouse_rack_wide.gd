@tool
class_name WarehouseRackWide
extends WarehouseRack

## Wide warehouse rack for longer pallets or items
## Extends the basic WarehouseRack with increased width

func _init() -> void:
	# Set default wide width (2 pallets wide)
	width = 4.8
	description = "Wide warehouse storage rack for longer items"
