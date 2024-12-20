using Godot;
using System.Collections.Generic;

[Tool]
public partial class RollerConveyorEnd : AbstractRollerContainer
{
	[Export]
	bool flipped { get => _flipped; set {
		if (_flipped != value) {
			_flipped = value;
			EmitSignal(SignalName.RollerRotationChanged, GetRotationFromSkewAngle(_rollerSkewAngleDegrees));
		}
	}}
	bool _flipped = false;
	Roller roller;

	const float baseWidth = 2f;

	public RollerConveyorEnd()
	{
		WidthChanged += SetEndsSeparation;
	}

	protected override void OnSceneInstantiated()
	{
		roller = GetNode<Roller>("Roller");
		base.OnSceneInstantiated();
	}

	~RollerConveyorEnd()
	{
		WidthChanged -= SetEndsSeparation;
	}

	protected override IEnumerable<Roller> GetRollers()
	{
		return [roller];
	}

	private void SetEndsSeparation(float width)
	{
		Node3D end = GetNode<Node3D>("ConveyorRollerEnd");
		end.Scale = new(1f, 1f, width / baseWidth);
		foreach (MeshInstance3D endMesh in end.GetChildren())
		{
			endMesh.Scale = new(1f, 1f, baseWidth / width);
		}
	}

	protected override Vector3 GetRotationFromSkewAngle(float angleDegrees)
	{
		Vector3 rot = base.GetRotationFromSkewAngle(angleDegrees);
		return flipped ? rot + new Vector3(0, 180, 0) : rot;
	}
}
