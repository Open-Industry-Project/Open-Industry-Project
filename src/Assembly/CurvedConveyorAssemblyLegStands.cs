using System;
using Godot;

[Tool]
public partial class CurvedConveyorAssemblyLegStands : ConveyorAssemblyLegStands
{
	private CurvedConveyorAssembly assembly => GetParentOrNull<CurvedConveyorAssembly>();

	public override void _Ready()
	{
		base._Ready();
		assembly.ScaleXChanged += void (_) => legStandsPathChanged = true;
	}

	#region Leg Stands
	protected override (float, float) GetLegStandCoverage() {
		// Assume that conveyors and legStands have the same rotation.
		return (-90f + assembly.AutoLegStandsMarginEnds, 0f - assembly.AutoLegStandsMarginEnds);
	}
	protected override Transform3D LockLegStandsGroup(Transform3D apparentTransform) {
		// We should probably let this rotate around the Y axis, but that would require accounting for legStands rotation in GetLegStandsCoverage().
		// For now, we won't let it move at all except Y axis translation.
		var rotation = new Vector3(0, 0, 0);
		var position = new Vector3(0, apparentTransform.Origin.Y, 0);
		return new Transform3D(Basis.FromEuler(rotation), position);
	}

	protected override float GetPositionOnLegStandsPath(Vector3 position) {
		return (float) Math.Round(Mathf.RadToDeg(new Vector3(0, 0, 1).SignedAngleTo(position.Slide(Vector3.Up), Vector3.Up)));
	}

	protected override bool MoveLegStandToPathPosition(Node3D legStand, float pathPosition)
	{
		float pathRadius = assembly.MiddleRadius;
		float angle = Mathf.DegToRad(pathPosition);

		bool changed = false;
		Vector3 newPosition = new Vector3(0, legStand.Position.Y, pathRadius).Rotated(Vector3.Up, angle);
		if (legStand.Position != newPosition)
		{
			legStand.Position = newPosition;
			changed = true;
		}
		Vector3 newRotation = new Vector3(0f, angle, 0f);
		if (legStand.Rotation != newRotation)
		{
			legStand.Rotation = newRotation;
			changed = true;
		}
		return changed;
	}
	#endregion Leg Stands
}
