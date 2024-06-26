using Godot;
using System;

[Tool]
public partial class CurvedConveyorAssembly : ConveyorAssembly
{
	#region Overriding default values and units
	public CurvedConveyorAssembly() {
		GD.Load<PackedScene>("res://parts/ConveyorLegCBC.tscn");
	}

	public override void _ValidateProperty(Godot.Collections.Dictionary property) {
		// Hide unused properties.
		if (property["name"].AsStringName() == PropertyName.ConveyorAngle
			|| property["name"].AsStringName() == PropertyName.AutoScaleConveyors
			|| property["name"].AsStringName() == PropertyName.AutoScaleGuards
			|| property["name"].AsStringName() == PropertyName.AutoLegStandsIntervalLegsOffset) {
			property["usage"] = (int) PropertyUsageFlags.NoEditor;
		}
		// This is a hack to change the unit of AutoLegStandsIntervalLegsInterval to degrees in the inspector.
		if (property["name"].AsStringName() == PropertyName.AutoLegStandsIntervalLegsInterval) {
			property["hint"] = (int) PropertyHint.Range;
			property["hint_string"] = "5,90,1,degrees";
		}
		// This is a hack to change the unit of AutoLegStandsMarginEnds to degrees in the inspector.
		if (property["name"].AsStringName() == PropertyName.AutoLegStandsMarginEnds) {
			property["hint"] = (int) PropertyHint.Range;
			property["hint_string"] = "0,90,1,degrees";
		}
		// This is a hack to change the unit of AutoLegStandsMarginEndLegs to degrees in the inspector.
		if (property["name"].AsStringName() == PropertyName.AutoLegStandsMarginEndLegs) {
			property["hint"] = (int) PropertyHint.Range;
			property["hint_string"] = "0,90,1,degrees";
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

	protected override void ApplyAssemblyScaleConstraints() {
		// Lock Z scale to be the same as X scale.
		(var scaleX, var scaleY, var scaleZ) = this.Transform.Basis.Scale;
		if (scaleX != scaleZ) {
			Basis rotBasis = this.Transform.Basis.Orthonormalized();
			rotBasis = new Basis(rotBasis.X * scaleX, rotBasis.Y * scaleY, rotBasis.Z * scaleX);
			this.Transform = new Transform3D(rotBasis, this.Transform.Origin);
		}
	}

	#region Conveyors and Side Guards
	protected override void LockConveyorsGroup() {
		// Just don't let it move at all, except Y axis translation.;
		conveyors.Rotation = new Vector3(0, 0, 0);
		conveyors.Position = new Vector3(0, conveyors.Position.Y, 0);
	}

	protected override void ScaleConveyor(Node3D conveyor, float conveyorLength) {
		// AutoScaleConveyors and conveyorLength have no effect on curved conveyors.
		conveyor.Scale = new Vector3(this.Scale.X, 1f, this.Scale.Z);
	}

	protected override void ScaleSideGuard(Node3D guard, float guardLength) {
		// AutoScaleGuards and guardLength have no effect on curved side guards.
		guard.Scale = new Vector3(this.Scale.X, 1f, this.Scale.Z);
	}
	#endregion Conveyors and Side Guards

	#region Leg Stands
	protected override (float, float) GetLegStandCoverage() {
		// Assume that conveyors and legStands have the same rotation.
		return (-90f + AutoLegStandsMarginEnds, 0f - AutoLegStandsMarginEnds);
	}
	protected override void LockLegStandsGroup() {
		// We should probably let this rotate around the Y axis, but that would require accounting for legStands rotation in GetLegStandsCoverage().
		// For now, we won't let it move at all except Y axis translation.
		legStands.Rotation = new Vector3(0, 0, 0);
		legStands.Position = new Vector3(0, legStands.Position.Y, 0);
	}

	protected override float GetPositionOnLegStandsPath(Vector3 position) {
		return (float) Math.Round(Mathf.RadToDeg(new Vector3(0, 0, 1).SignedAngleTo(position.Slide(Vector3.Up), Vector3.Up)));
	}

	protected override void MoveLegStandToPathPosition(Node3D legStand, float position) {
		float radius = this.Scale.X * 1.5f;
		float angle = Mathf.DegToRad(position);
		legStand.Position = new Vector3(0, legStand.Position.Y, radius).Rotated(Vector3.Up, angle);
		legStand.Rotation = new Vector3(0f, angle, 0f);
	}
	#endregion Leg Stands
}
