using Godot;

[Tool]
public partial class TransformMonitoredNode3D: Node3D
{
	[Signal]
	public delegate void TransformChangedEventHandler(Transform3D transform);

	[Signal]
	public delegate void BasisChangedEventHandler(Basis basis);

	[Signal]
	public delegate void BasisXChangedEventHandler(Vector3 basisX);

	[Signal]
	public delegate void BasisYChangedEventHandler(Vector3 basisY);

	[Signal]
	public delegate void BasisZChangedEventHandler(Vector3 basisZ);

	[Signal]
	public delegate void ScaleChangedEventHandler(Vector3 scale);

	[Signal]
	public delegate void ScaleXChangedEventHandler(float scaleX);

	[Signal]
	public delegate void ScaleYChangedEventHandler(float scaleY);

	[Signal]
	public delegate void ScaleZChangedEventHandler(float scaleZ);

	[Signal]
	public delegate void PositionChangedEventHandler(Vector3 position);

	[Signal]
	public delegate void PositionXChangedEventHandler(float positionX);

	[Signal]
	public delegate void PositionYChangedEventHandler(float positionY);

	[Signal]
	public delegate void PositionZChangedEventHandler(float positionZ);

	private Transform3D _transformPrev = Transform3D.Identity;
	private Basis _basisPrev = Basis.Identity;
	private Vector3 _scalePrev = Vector3.One;
	private Vector3 _positionPrev = Vector3.Zero;

	public TransformMonitoredNode3D()
	{
		SetNotifyLocalTransform(true);
	}

	public override void _Notification(int what)
	{
		if (what == NotificationLocalTransformChanged)
		{
			OnTransformSet(Transform);
		}
		base._Notification(what);
	}

	private void OnTransformSet(Transform3D transform)
	{
		// Assume transformPrev is already properly constrained
		bool changed = transform != _transformPrev;
		if (!changed) return;
		Transform3D constrainedTransform = ConstrainTransform(transform);
		bool constrained = constrainedTransform != transform;
		bool actuallyChanged = constrainedTransform != _transformPrev;
		if (constrained)
		{
			// Assigning to Transform will immediately call this method again,
			// but it will do nothing if we update transformPrev first.
			_transformPrev = constrainedTransform;
			Transform = constrainedTransform;
		}
		if (actuallyChanged)
		{
			_transformPrev = constrainedTransform;
			_OnTransformChanged(constrainedTransform);
		}
	}

	private void _OnTransformChanged(Transform3D transform)
	{
		bool basisChanged = transform.Basis != _basisPrev;
		bool basisXChanged = transform.Basis.X != _basisPrev.X;
		bool basisYChanged = transform.Basis.Y != _basisPrev.Y;
		bool basisZChanged = transform.Basis.Z != _basisPrev.Z;
		_basisPrev = transform.Basis;
		bool scaleChanged = transform.Basis.Scale != _scalePrev;
		bool scaleXChanged = transform.Basis.Scale.X != _scalePrev.X;
		bool scaleYChanged = transform.Basis.Scale.Y != _scalePrev.Y;
		bool scaleZChanged = transform.Basis.Scale.Z != _scalePrev.Z;
		_scalePrev = transform.Basis.Scale;
		bool positionChanged = transform.Origin != _positionPrev;
		bool positionXChanged = transform.Origin.X != _positionPrev.X;
		bool positionYChanged = transform.Origin.Y != _positionPrev.Y;
		bool positionZChanged = transform.Origin.Z != _positionPrev.Z;
		_positionPrev = transform.Origin;
		EmitSignalTransformChanged(transform);
		if (basisChanged) EmitSignalBasisChanged(transform.Basis);
		if (basisXChanged) EmitSignalBasisXChanged(transform.Basis.X);
		if (basisYChanged) EmitSignalBasisYChanged(transform.Basis.Y);
		if (basisZChanged) EmitSignalBasisZChanged(transform.Basis.Z);
		if (scaleChanged) EmitSignalScaleChanged(transform.Basis.Scale);
		if (scaleXChanged) EmitSignalScaleXChanged(transform.Basis.Scale.X);
		if (scaleYChanged) EmitSignalScaleYChanged(transform.Basis.Scale.Y);
		if (scaleZChanged) EmitSignalScaleZChanged(transform.Basis.Scale.Z);
		if (positionChanged) EmitSignalPositionChanged(transform.Origin);
		if (positionXChanged) EmitSignalPositionXChanged(transform.Origin.X);
		if (positionYChanged) EmitSignalPositionYChanged(transform.Origin.Y);
		if (positionZChanged) EmitSignalPositionZChanged(transform.Origin.Z);
	}

	protected virtual Transform3D ConstrainTransform(Transform3D transform)
	{
		return transform;
	}
}
