using Godot;
using System;

[Tool]
public partial class Roller : Node3D
{
	private float _speed = 1.0f;
	public float Speed {
		get { return _speed; }
		set { _speed = value; if (running) { OnSimulationStarted(); } }
	}
	MeshInstance3D meshInstance;
	StaticBody3D staticBody;
	StandardMaterial3D material;
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
			material.Uv1Offset -= new Vector3(Speed * MathF.PI/4 * (float)delta, 0, 0);
		}
	}

	void OnSimulationStarted()
	{
		running = true;
		Vector3 localFront = GlobalTransform.Basis.Z.Normalized();
		staticBody.ConstantAngularVelocity = localFront * Speed * MathF.PI * 2;
	}

	void OnSimulationEnded()
	{
		running = false;
		staticBody.ConstantAngularVelocity = Vector3.Zero;
	}
}
