@tool
class_name CurvedRollerConveyorLegsAssembly
extends CurvedConveyorLegsAssembly

# Base scale factors for roller conveyor legs
const BASE_HEIGHT_SCALE: float = 1.253
const BASE_WIDTH_SCALE: float = 0.822

## Override to apply custom scale adjustments for roller conveyor legs
func _update_individual_conveyor_leg_height_and_visibility(conveyor_leg: ConveyorLeg, conveyor_plane: Plane) -> void:
	# First, let the parent do its calculations
	super._update_individual_conveyor_leg_height_and_visibility(conveyor_leg, conveyor_plane)
	
	# Then apply our custom scale adjustments if the leg is visible
	if conveyor_leg.visible:
		# The parent already set the Y scale based on leg height calculation
		# We need to multiply it by our base height scale
		var calculated_height_scale = conveyor_leg.scale.y
		var adjusted_height_scale = calculated_height_scale * BASE_HEIGHT_SCALE
		
		# For Z scale, we use our base width scale adjusted by conveyor size
		var width_factor = conveyor.size.x / 1.524 if conveyor else 1.0  # 1.524 is default width
		var adjusted_width_scale = BASE_WIDTH_SCALE * width_factor
		
		# Apply the final scale
		conveyor_leg.scale = Vector3(1.0, adjusted_height_scale, adjusted_width_scale)


## Override to set initial scale when adding legs
func _add_or_get_conveyor_leg_instance(name: StringName) -> Node:
	var conveyor_leg = super._add_or_get_conveyor_leg_instance(name)
	
	# Set initial scale with our base values
	if conveyor_leg:
		conveyor_leg.scale = Vector3(1.0, BASE_HEIGHT_SCALE, BASE_WIDTH_SCALE)
	
	return conveyor_leg 