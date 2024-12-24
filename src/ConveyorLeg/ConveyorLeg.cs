using Godot;
using System;

[Tool]
public partial class ConveyorLeg : Node3D
{
	float grabsRotation = 0.0f;
	[Export(PropertyHint.Range, "-60,60,0.1")]
	public float GrabsRotation
	{
		get
		{
			return grabsRotation;
		}
		set
		{
			grabsRotation = value;
			SetPhysicsProcess(true);
		}
	}

	float nodeScaleY = 1.0f;
	float nodeScaleZ = 1.0f;

	MeshInstance3D grab1;
	MeshInstance3D grab2;

	MeshInstance3D top;

	MeshInstance3D legsSidesMesh1;
	MeshInstance3D legsSidesMesh2;
	ShaderMaterial legsSidesMaterial;
	LegBars legsBars;
	Node3D ends;

	Vector3 prevScale;

	public override void _Ready()
	{
		grab1 = GetNode<MeshInstance3D>("Ends/LegsTop1/LegsGrab1");
		grab2 = GetNode<MeshInstance3D>("Ends/LegsTop2/LegsGrab2");

		legsSidesMesh1 = GetNode<MeshInstance3D>("Sides/LegsSide1");
		legsSidesMesh2 = GetNode<MeshInstance3D>("Sides/LegsSide2");
		legsSidesMaterial = legsSidesMesh1.Mesh.SurfaceGetMaterial(0) as ShaderMaterial;
		legsSidesMesh1.Mesh.SurfaceSetMaterial(0, legsSidesMaterial);
		legsBars = GetNode<LegBars>("LegsBars");
		ends = GetNode<Node3D>("Ends");

		SetNotifyLocalTransform(true);
	}

	public override void _Process(double delta)
	{
		if (Scale.Y >= 1.0f)
			nodeScaleY = Scale.Y;

		nodeScaleZ = Scale.Z;

		Vector3 newScale = new(1, nodeScaleY, nodeScaleZ);

		if(Scale != newScale)
		{
			Scale = new Vector3(1, nodeScaleY, nodeScaleZ);
		}
		SetProcess(false);
	}

	public override void _PhysicsProcess(double delta)
	{
		if(Scale == prevScale) return;

		if (legsSidesMaterial != null)
			legsSidesMaterial.SetShaderParameter("Scale", Scale.Y);

		if (legsBars != null && legsBars.ParentScale != Scale)
			legsBars.ParentScale = Scale;

		foreach (Node3D end in ends.GetChildren())
		{
			end.Scale = new Vector3(1 / Scale.X, 1 / Scale.Y, 1 / Scale.Z);
		}

		legsSidesMesh1.Scale = new Vector3(1 / Scale.X, 1, 1 / Scale.Z);
		legsSidesMesh2.Scale = new Vector3(1 / Scale.X, 1, 1 / Scale.Z);

		grab1.RotationDegrees = new Vector3(0, 0, grabsRotation);
		grab2.RotationDegrees = new Vector3(0, 0, -grabsRotation);

		grab1.Scale = Vector3.One;
		grab2.Scale = Vector3.One;

		prevScale = Scale;
		SetPhysicsProcess(false);
	}

	public override void _Notification(int what)
	{
		if (what == NotificationLocalTransformChanged)
		{
			SetProcess(true);
			SetPhysicsProcess(true);
		}
	}
}
