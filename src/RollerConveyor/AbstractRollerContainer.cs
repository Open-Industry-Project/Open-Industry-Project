using System.Collections.Generic;
using System.Linq;
using Godot;

[Tool]
public abstract partial class AbstractRollerContainer : Node3D
{
	internal float _width = 2f;
	internal float _length = 1f;
	internal float _rollerLength = 2f;
	internal float _rollerSkewAngleDegrees = 0f;

	[Signal]
	public delegate void WidthChangedEventHandler(float width);
	[Signal]
	public delegate void LengthChangedEventHandler(float length);
	[Signal]
	public delegate void RollerLengthChangedEventHandler(float length);
	[Signal]
	public delegate void RollerRotationChangedEventHandler(Vector3 rotationDegrees);
	[Signal]
	public delegate void RollerAddedEventHandler(Roller roller);
	[Signal]
	public delegate void RollerRemovedEventHandler(Roller roller);

	public AbstractRollerContainer()
	{
		RollerAdded += HandleRollerAdded;
		RollerRemoved += HandleRollerRemoved;
	}

	internal virtual void SetupExistingRollers()
	{
		foreach (Roller roller in GetRollers())
		{
			// If LengthChanged has already been fired, then we've already
			// added and subscribed some Rollers, but we still need to
			// subscribe the original ones. To ensure that each Roller is
			// only subscribed once, we're going to unsubscribe them all,
			// then then subscribe them.
			EmitSignalRollerRemoved(roller);
			EmitSignalRollerAdded(roller);
		}
	}

	public void OnOwnerScaleChanged(Vector3 scale)
	{
		RescaleInverse(scale);
	}

	private void RescaleInverse(Vector3 ownerScale)
	{
		Scale = new(1 / ownerScale.X, 1 / ownerScale.Y, 1 / ownerScale.Z);
	}

	public void SetWidth(float width)
	{
		bool changed = _width != width;
		_width = width;
		if (changed)
		{
			UpdateRollerLength();
			EmitSignal(SignalName.WidthChanged, _width);
		}
	}

	public void SetLength(float length)
	{
		bool changed = _length != length;
		_length = length;
		if (changed)
		{
			EmitSignal(SignalName.LengthChanged, _length);
		}
	}

	public void SetRollerSkewAngle(float skewAngleDegrees)
	{
		bool changed = _rollerSkewAngleDegrees % 360f != skewAngleDegrees % 360f;
		_rollerSkewAngleDegrees = skewAngleDegrees;
		if (changed)
		{
			EmitSignal(SignalName.RollerRotationChanged, GetRotationFromSkewAngle(_rollerSkewAngleDegrees));
			UpdateRollerLength();
		}
	}

	private void UpdateRollerLength()
	{
		if (Mathf.Abs(_rollerSkewAngleDegrees % 180f) == 90) return;
		float newLength = _width / Mathf.Cos(_rollerSkewAngleDegrees * 2f * Mathf.Pi / 360f);
		bool changed = newLength != _rollerLength;
		_rollerLength = newLength;
		if (changed)
		{
			EmitSignal(SignalName.RollerLengthChanged, _rollerLength);
		}
	}

	protected virtual IEnumerable<Roller> GetRollers()
	{
		return GetChildren().Cast<Roller>();
	}

	private void HandleRollerAdded(Roller roller)
	{
		roller.SetRotationDegrees(GetRotationFromSkewAngle(_rollerSkewAngleDegrees));
		roller.SetLength(_rollerLength);

		RollerRotationChanged += roller.SetRotationDegrees;
		RollerLengthChanged += roller.SetLength;
	}

	private void HandleRollerRemoved(Roller roller)
	{
		RollerRotationChanged -= roller.SetRotationDegrees;
		RollerLengthChanged -= roller.SetLength;
	}

	protected virtual Vector3 GetRotationFromSkewAngle(float angleDegrees)
	{
		return new Vector3(0f, angleDegrees, 0f);
	}
}

