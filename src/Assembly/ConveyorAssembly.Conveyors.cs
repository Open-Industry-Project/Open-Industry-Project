using Godot;
using System;
using System.Collections.Generic;

public partial class ConveyorAssembly : TransformMonitoredNode3D
{
	#region Conveyors
	protected virtual float ConveyorBaseLength => 1f;
	protected virtual float ConveyorBaseWidth => 2f;

	// Cached Transform properties
	protected Transform3D _cachedConveyorsTransform = Transform3D.Identity;
	protected Vector3 _cachedConveyorsPosition = Vector3.Zero;
	private Basis _cachedConveyorsBasis = Basis.Identity;
	private Vector3 _cachedConveyorsRotation = Vector3.Zero;

	private float conveyorLineLength = 0f;
	private float conveyorLineWidth = 0f;

	// This will become the constructor once this file is converted into its own class.
	private void SetupConveyors()
	{
		conveyors.TransformChanged += void (value) => _cachedConveyorsTransform = value;
		conveyors.PositionChanged += void (value) => _cachedConveyorsPosition = value;
		conveyors.BasisChanged += void (value) =>
		{
			_cachedConveyorsBasis = value;
			_cachedConveyorsRotation = _cachedConveyorsBasis.GetEuler();
		};
		// Ensure cached values are up to date
		//conveyors.SetTransform(conveyors.Transform);
		// The above commented line doesn't work, but should work once this is turned into a constructor.
		// The problem is OnTransformSet skips emitting all the on-change signals because it determines there is no change.
		// In a constructor, we would be guaranteed to be the the first caller of OnTransformSet.
		// In the meantime, set cache fields manually as a workaround.
		_cachedConveyorsTransform = conveyors.Transform;
		_cachedConveyorsPosition = _cachedConveyorsTransform.Origin;
		_cachedConveyorsBasis = _cachedConveyorsTransform.Basis;
		_cachedConveyorsRotation = _cachedConveyorsBasis.GetEuler();

		conveyors.TransformChanged += void (_) => UpdateSides();
	}

	#region Conveyors / Update "Conveyors" node
	private void UpdateConveyors()
	{
		if (conveyors == null)
		{
			return;
		}

		LockConveyorsGroup();
		SyncConveyorsAngle();

		float conveyorLineLengthPrev = conveyorLineLength;
		conveyorLineLength = GetConveyorLineLength();
		bool conveyorLineLengthChanged = conveyorLineLengthPrev != conveyorLineLength;

		float conveyorLineWidthPrev = conveyorLineWidth;
		conveyorLineWidth = GetConveyorLineWidth();
		bool conveyorLineWidthChanged = conveyorLineWidthPrev != conveyorLineWidth;

		// Assume no children added or removed, which we would also need to account for.
		bool conveyorScaleNeedsUpdate = conveyorLineLengthChanged || conveyorLineWidthChanged;
		if (conveyorScaleNeedsUpdate)
		{
			ScaleConveyorLine(conveyors, conveyorLineLength, conveyorLineWidth);

			// While we're here, let's update the things that depend on conveyors's children's Transforms.
			// UpdateLegStandCoverage depends on the extents of conveyor's children.
			legStands?.UpdateLegStandCoverage();
			// UpdateSide depends on conveyorLineLength, though it actually measures it from first conveyor child's Scale.X.
			UpdateSides();
		}

	}

	protected virtual void LockConveyorsGroup() {
		// Lock Z position
		Vector3 newPos = new Vector3(_cachedConveyorsPosition.X, _cachedConveyorsPosition.Y, 0f);
		if (_cachedConveyorsPosition != newPos) {
			conveyors.Position = newPos;
		}
		// Lock X and Y rotation
		if (_cachedConveyorsRotation.X > 0.001f || _cachedConveyorsRotation.X < -0.001f || _cachedConveyorsRotation.Y > 0.001f || _cachedConveyorsRotation.Y < -0.001) {
			// This seems to mess up scale, but at least that's fixed on the next frame.
			Vector3 newRot = new Vector3(0f, 0f, _cachedConveyorsRotation.Z);
			if (_cachedConveyorsRotation != newRot) {
				conveyors.Rotation = newRot;
			}
		}
	}

	/**
	 * Synchronize the angle of the conveyors with the assembly's ConveyorAngle property.
	 *
	 * If the property changes, the conveyors are rotated to match.
	 * If the conveyors are rotated manually, the property is updated.
	 * If both happen at the same time, the property wins.
	 */
	private void SyncConveyorsAngle() {
		Basis scale = Basis.Identity.Scaled(_cachedScale);
		Basis scalePrev = Basis.Identity.Scaled(_scalePrev);
		if (ConveyorAngle != conveyorAnglePrev) {
			Basis targetRot = new Basis(new Vector3(0, 0, 1), ConveyorAngle);
			conveyors.Basis = scale.Inverse() * targetRot;
		} else {
			float angle = (scale * _cachedConveyorsBasis).GetEuler().Z;
			float anglePrev = (scalePrev * conveyorsTransformPrev.Basis).GetEuler().Z;
			double angleDelta = Mathf.Abs(angle - anglePrev) % (2 * Math.PI);
			if (angleDelta > Math.PI / 360.0) {
				this.ConveyorAngle = (scale * _cachedConveyorsBasis).GetEuler().Z;
				NotifyPropertyListChanged();
			}
		};
	}
	#endregion Conveyors / Update "Conveyors" node

	#region Conveyors / ScaleConveyorLine
	/**
	 * Get the length of the conveyor line.
	 *
	 * If ConveyorAutomaticLength is enabled, this is the length required for the conveyor line, at its current angle, to span the assembly's x-axis one meter per unit of assembly x-scale.
	 *
	 * If ConveyorAutomaticLength is disabled, this is the sum of the lengths of all conveyors in the line.
	 * We assume that they're parallel and aligned end-to-end.
	 *
	 * @return The length of the conveyor line along its x-axis.
	 */
	// TODO override in CurvedConveyorAssembly
	private float GetConveyorLineLength() {
		if (conveyors == null) {
			return Length;
		}
		if (ConveyorAutomaticLength) {
			var cos = Mathf.Cos(_cachedConveyorsRotation.Z);
			return Length / (Mathf.Abs(cos) >= 0.01f ? cos : 0.01f);
		}
		// Add up the length of all conveyors.
		// Assume all conveyors are aligned end-to-end.
		var sum = 0f;
		foreach (Node child in conveyors.GetChildren()) {
			Node3D conveyor = child as Node3D;
			if (IsConveyor(conveyor)) {
				// Assume conveyor scale == length.
				sum += conveyor.Scale.X;
			}
		}
		return sum;
	}

	private float GetConveyorLineWidth() {
		return Width;
	}

	/**
	 * Scale all conveyor children of a given node.
	 *
	 * This would be a great place to implement proportional scaling and positioning of the conveyors,
	 * but currently, we just scale every conveyor to the length and width of the whole line and leave its position alone.
	 *
	 * @param conveyorLine The parent of the conveyors.
	 * @param conveyorLineLength The length of the conveyor line to scale to. Ignored if ConveyorAutomaticLength is false.
	 * @param conveyorLineWidth The width of the conveyor line to scale to.
	 */
	private void ScaleConveyorLine(Node3D conveyorLine, float conveyorLineLength, float conveyorLineWidth) {
		foreach (Node child in conveyorLine.GetChildren()) {
			Node3D child3d = child as Node3D;
			if (IsConveyor(child3d)) {
				ScaleConveyor(child3d, conveyorLineLength, conveyorLineWidth);
			}
		}
	}

	internal static bool IsConveyor(Node node) {
		return node as IConveyor != null || node as IBeltConveyor != null || node as IRollerConveyor != null;
	}

	protected virtual void ScaleConveyor(Node3D conveyor, float conveyorLength, float conveyorWidth) {
		Vector3 newScale;
		if (ConveyorAutomaticLength) {
			newScale = new Vector3(conveyorLength / ConveyorBaseLength, 1f, conveyorWidth / ConveyorBaseWidth);
		} else {
			// Always scale width.
			newScale = new Vector3(conveyor.Scale.X, conveyor.Scale.Y, conveyorWidth / ConveyorBaseWidth);
		}
		if (conveyor.Scale != newScale) {
			conveyor.Scale = newScale;
		}
	}
	#endregion Conveyors / ScaleConveyorLine

	#region Conveyors / Conveyor Extents
	/**
	 * Get the extents of all conveyors in the assembly.
	 *
	 * The extents are the (front, rear) X positions of each conveyor.
	 * They're used to determine where to place side guards.
	 *
	 * @return A list of (front, rear) extents of each conveyor.
	 */
	private List<(float, float)> GetAllConveyorExtents() {
		// Assume straight assembly.
		// Assume all conveyors are in the same reference frame, straight, aligned end-to-end, and parallel to the x-axis of that reference frame.
		// We will use the `conveyors` node's children, but this would work for any list that meets the above assumptions.

		// Additional thought: it would be neat to return extents as Vector3s instead, that way we could take any arbitrary arrangement of conveyors. As long as the gaps could still cut into it, it could work.
		// This approach would also bring us closer to automatic leg stands per conveyor instead of per conveyor line.

		List<(float, float)> results = new();
		if (conveyors == null) {
			return results;
		}
		foreach (Node3D node3D in conveyors.GetChildren()) {
			if (IsConveyor(node3D)) {
				// Assume conveyor length equal to X scale.
				// (Don't account for the end caps; they reach beyond the extents.)
				// This assumption is convenient because SideGuards' end caps overreach the same amount.
				float length = node3D.Scale.X;
				float extentFront = node3D.Position.X - length / 2f;
				float extentRear = node3D.Position.X + length / 2f;
				results.Add((extentFront, extentRear));
			}
		}
		return results;
	}
	#endregion Conveyors / Conveyor Extents
	#endregion Conveyors
}
