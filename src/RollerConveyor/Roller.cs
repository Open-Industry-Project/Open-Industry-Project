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

    public bool flipped = false;


    MeshInstance3D meshInstance;
	StaticBody3D staticBody;
	StandardMaterial3D material;
    Root Main;
	bool running = false;
	float reverse = 0;
	float direction = 0;

    public override void _EnterTree()
	{
		Main = GetParent().GetTree().EditedSceneRoot as Root;

		if (Main != null)
		{
			Main.SimulationStarted += OnSimulationStarted;
			Main.SimulationEnded += OnSimulationEnded;
        }

		RotationDegrees = flipped ? new Vector3(0, 180, 0) : new Vector3(0, 0, 0);
        direction = flipped ? -1.0f : 1.0f;
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
            material.Uv1Offset -= new Vector3(direction * Speed * MathF.PI / 2 * (float)delta, 0, 0);
            Vector3 localFront = GlobalTransform.Basis.Z.Normalized();
            staticBody.ConstantAngularVelocity = direction * localFront * Speed * MathF.PI * 2;
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
