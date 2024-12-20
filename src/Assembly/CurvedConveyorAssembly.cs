using Godot;
using System;

[Tool]
public partial class CurvedConveyorAssembly : ConveyorAssembly
{
	#region Constants
	float BaseOuterRadius => 1.0f;
	float BaseInnerRadius => 0.25f;
	float BaseMiddleRadius => BaseOuterRadius - BaseInnerRadius;
	protected override float BaseLength => 1.0f;
	protected override float BaseWidth => 1.0f;
	protected override float ConveyorBaseLength => 1f;
	protected override float ConveyorBaseWidth => 1f;
	#endregion Constants

	public float MiddleRadius => Width / BaseWidth * BaseMiddleRadius;

	#region Overriding default values and units
	public CurvedConveyorAssembly() {
		GD.Load<PackedScene>("res://parts/ConveyorLegCBC.tscn");
	}

	public override void _ValidateProperty(Godot.Collections.Dictionary property) {
		string propertyName = property["name"].AsStringName();

		// Show SideGuardsBothSides.
		if (propertyName == PropertyName.SideGuardsBothSides) {
			// We don't want it stored. SideGuardsLeftSide and SideGuardsRightSide are the source of truth.
			property["usage"] = (int) PropertyUsageFlags.Editor;
		}
		// Hide unused properties.
		else if (propertyName == PropertyName.ConveyorAngle
			|| propertyName == PropertyName.ConveyorAutomaticLength
			|| propertyName == PropertyName.SideGuardsLeftSide
			|| propertyName == PropertyName.SideGuardsRightSide
			|| propertyName == PropertyName.SideGuardsGaps
			|| propertyName == PropertyName.AutoLegStandsIntervalLegsOffset) {
			property["usage"] = (int) PropertyUsageFlags.NoEditor;
		}
		// This is a hack to change the unit of AutoLegStandsIntervalLegsInterval to degrees in the inspector.
		else if (propertyName == PropertyName.AutoLegStandsIntervalLegsInterval) {
			property["hint"] = (int) PropertyHint.Range;
			property["hint_string"] = "5,90,1,degrees";
		}
		// This is a hack to change the unit of AutoLegStandsMarginEnds to degrees in the inspector.
		else if (propertyName == PropertyName.AutoLegStandsMarginEnds) {
			property["hint"] = (int) PropertyHint.Range;
			property["hint_string"] = "0,90,1,degrees";
		}
		// This is a hack to change the unit of AutoLegStandsMarginEndLegs to degrees in the inspector.
		else if (propertyName == PropertyName.AutoLegStandsMarginEndLegs) {
			property["hint"] = (int) PropertyHint.Range;
			property["hint_string"] = "0,90,1,degrees";
		}
		else
		{
			base._ValidateProperty(property);
		}
	}

	public override bool _PropertyCanRevert(StringName property) {
		// This is a hack to enable overriding the default value of these properties.
		return property == PropertyName.AutoLegStandsIntervalLegsEnabled
			|| property == PropertyName.AutoLegStandsIntervalLegsInterval
			|| property == PropertyName.AutoLegStandsMarginEnds
			|| property == PropertyName.AutoLegStandsMarginEndLegs
			|| property == PropertyName.AutoLegStandsModelGrabsOffset
			|| property == PropertyName.AutoLegStandsModelScene
			|| base._PropertyCanRevert(property);
	}

	public override Variant _PropertyGetRevert(StringName property) {
		// This is a hack to override the default value of AutoLegStandsIntervalLegsEnabled.
		if (property == PropertyName.AutoLegStandsIntervalLegsEnabled) {
			return false;
		}
		// This is a hack to override the default value of AutoLegStandsIntervalLegsInterval.
		if (property == PropertyName.AutoLegStandsIntervalLegsInterval) {
			return 45f;
		}
		// This is a hack to override the default value of AutoLegStandsMarginEnds.
		if (property == PropertyName.AutoLegStandsMarginEnds) {
			return 0f;
		}
		// This is a hack to override the default value of AutoLegStandsMarginEndLegs.
		if (property == PropertyName.AutoLegStandsMarginEndLegs) {
			return 0f;
		}
		// This is a hack to override the default value of AutoLegStandsModelGrabsOffset.
		if (property == PropertyName.AutoLegStandsModelGrabsOffset) {
			return 0.5f;
		}
		// This is a hack to override the default value of AutoLegStandsModelScene.
		if (property == PropertyName.AutoLegStandsModelScene) {
			return GD.Load<PackedScene>("res://parts/ConveyorLegCBC.tscn");
		}
		return base._PropertyGetRevert(property);
	}
	#endregion Overriding default values and units

	protected override Transform3D ConstrainTransform(Transform3D transform) {
		// Lock Z scale to be the same as X scale.
		(var scaleX, var scaleY, var scaleZ) = transform.Basis.Scale;
		if (scaleX != scaleZ) {
			Basis rotBasis = transform.Basis.Orthonormalized();
			rotBasis = new Basis(rotBasis.X * scaleX, rotBasis.Y * scaleY, rotBasis.Z * scaleX);
			return new Transform3D(rotBasis, transform.Origin);
		}
		return transform;
	}

	#region Conveyors and Side Guards
	internal override Transform3D LockConveyorsGroup(Transform3D transform) {
		// Just don't let it move at all, except Y axis translation.;
		var scale = transform.Basis.Scale;
		var position = new Vector3(0, transform.Origin.Y, 0);
		return new Transform3D(Basis.Identity.Scaled(scale), position);
	}

	protected override void LockSidePosition(Node3D side, bool isRight) {
		// Sides always snap onto the conveyor line
		// Just snap both sides to the center without any offset.
		side.Transform = _cachedConveyorsTransform;
	}

	protected override void ScaleConveyor(Node3D conveyor, float conveyorLength, float conveyorWidth) {
		// ConveyorAutomaticLength, conveyorLength, and conveyorWidth have no effect on curved conveyors.
		// TODO delete this override
		conveyor.Scale = new Vector3(Length / ConveyorBaseLength, 1f, Width / ConveyorBaseWidth);
	}

	protected override void ScaleSideGuard(Node3D guard, float guardLength) {
		// SideGuardsAutoScale and guardLength have no effect on curved side guards.
		float curvedSideGuardBaseLength = 2f;
		float curvedSideGuardBaseWidth = 2f;
		guard.Scale = new Vector3(Length / curvedSideGuardBaseLength, 1f, Width / curvedSideGuardBaseWidth);
	}
	#endregion Conveyors and Side Guards
}
