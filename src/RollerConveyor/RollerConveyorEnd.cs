using Godot;

[Tool]
public partial class RollerConveyorEnd : Node3D
{
	[Export]
	bool flipped = false;
	Roller roller;
	Node3D owner;

	const float baseWidth = 2f;

	public override void _EnterTree()
	{
		roller = GetNode<Roller>("Roller");
    }

	public void SetLength(float length) {
		Scale = new(1f / length, 1f, Scale.Z);
	}

	public void SetWidth(float width)
	{
		Scale = new(Scale.X, 1f, baseWidth / width);
		Node3D end = GetNode<Node3D>("ConveyorRollerEnd");
		end.Scale = new(1f, 1f, width / baseWidth);
		foreach (MeshInstance3D endMesh in end.GetChildren())
		{
			endMesh.Scale = new(1f, 1f, baseWidth / width);
		}
		// Do we need to do some math here when the roller is at an angle?
		roller.SetLength(width);
    }

	public void RotateRoller(Vector3 angle)
	{
		roller.RotationDegrees = flipped ? angle + new Vector3(0, 180, 0) : angle;
	}
}
