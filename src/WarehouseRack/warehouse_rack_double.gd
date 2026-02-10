@tool
class_name WarehouseRackDouble
extends WarehouseRack

## Double-deep warehouse rack for higher density storage
## Extends the basic WarehouseRack with double depth

func _init() -> void:
	# Set default double depth (2 pallets wide)
	depth = 2.4
	description = "Double-deep warehouse storage rack"
