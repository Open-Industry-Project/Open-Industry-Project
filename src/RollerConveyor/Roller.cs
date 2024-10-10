using Godot;
using System;

[Tool]
public partial class Roller : Node3D
{
	private float _speed = 1.0f;
	public float speed {
		get { return _speed; }
		set { _speed = value; if (running) { OnSimulationStarted(); } }
	}
	MeshInstance3D meshInstance;
	StaticBody3D staticBody;
	Root Main;
	bool running = false;

	public override void _EnterTree()
	{
		Main = GetParent().GetTree().EditedSceneRoot as Root;

		if (Main != null)
		{
			Main.SimulationStarted += OnSimulationStarted;
			Main.SimulationEnded += OnSimulationEnded;
		}
	}

	public override void _ExitTree()
	{
		if (Main != null)
		{
			Main.SimulationStarted -= OnSimulationStarted;
			Main.SimulationEnded -= OnSimulationEnded;
		}
	}

	public override void _Ready()
	{
		meshInstance = GetNode<MeshInstance3D>("MeshInstance3D");
		staticBody = GetNode<StaticBody3D>("StaticBody3D");
	}

	public override void _Process(double delta)
	{
		if (running)
		{
			meshInstance.RotateZ(speed * MathF.PI * 2f * (float)delta);
		}
	}

	void OnSimulationStarted()
	{
		running = true;
		Vector3 localFront = GlobalTransform.Basis.Z.Normalized();
		staticBody.ConstantAngularVelocity = localFront * speed * MathF.PI * 2;
	}

	void OnSimulationEnded()
	{
		running = false;
		staticBody.ConstantAngularVelocity = Vector3.Zero;
	}
}
