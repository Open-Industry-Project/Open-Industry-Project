using Godot;
using System;

[Tool]
public partial class Roller : Node3D
{
	private float _speed = 1.0f;
	public float Speed
	{
		get { return _speed; }
		set { _speed = value; }
	}
	MeshInstance3D meshInstance;
	StaticBody3D staticBody;
	StandardMaterial3D material;
	Root Main;
	bool running = false;
	// TODO calculate from collision shape and model
	const float radius = 0.12f;
	const float circumference = 2f * MathF.PI * radius;

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
		staticBody = GetNode<StaticBody3D>("StaticBody3D");
		meshInstance = GetNode<MeshInstance3D>("MeshInstance3D");
		material = meshInstance.Mesh.SurfaceGetMaterial(0) as StandardMaterial3D;

		if (Main != null && Main.simulationRunning)
		{
			OnSimulationStarted();
		}
	}

	public override void _Process(double delta)
	{
		if (running)
		{
			// Factor of four is probably for the four faces of the roller.
			material.Uv1Offset += new Vector3(4f * Speed / circumference * (float)delta, 0, 0);
			Vector3 localFront = GlobalTransform.Basis.Z.Normalized();
			staticBody.ConstantAngularVelocity = -localFront * Speed / radius;
		}
	}


	void OnSimulationStarted()
	{
		running = true;
	}

	void OnSimulationEnded()
	{
		running = false;
		staticBody.ConstantAngularVelocity = Vector3.Zero;
	}
}
