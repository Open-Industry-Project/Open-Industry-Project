using System;
using Godot;

[Tool]
public partial class CurvedConveyorAssemblyLegStands : ConveyorAssemblyLegStands
{
	private CurvedConveyorAssembly assembly => GetParentOrNull<CurvedConveyorAssembly>();

	#region Leg Stands
	protected override (float, float) GetLegStandCoverage() {
		// Assume that conveyors and legStands have the same rotation.
		return (-90f + assembly.AutoLegStandsMarginEnds, 0f - assembly.AutoLegStandsMarginEnds);
	}
	protected override void LockLegStandsGroup() {
		// We should probably let this rotate around the Y axis, but that would require accounting for legStands rotation in GetLegStandsCoverage().
		// For now, we won't let it move at all except Y axis translation.
		this.Rotation = new Vector3(0, 0, 0);
		this.Position = new Vector3(0, _cachedLegStandsPosition.Y, 0);
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
