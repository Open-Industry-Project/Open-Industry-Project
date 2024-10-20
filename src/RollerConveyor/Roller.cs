using Godot;

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
	Root Main;
	bool running = false;

    const float radius = 0.12f;

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

		RollerConveyor rollerConveyor = GetParent().GetParent() as RollerConveyor ?? GetParent().GetParent().GetParent() as RollerConveyor;

        if (rollerConveyor != null)
		{
            StandardMaterial3D material = rollerConveyor.rollerMaterial;

            meshInstance.SetSurfaceOverrideMaterial(0, material);
        }

        if (Main != null && Main.simulationRunning)
		{
			OnSimulationStarted();
		}
	}

	public override void _Process(double delta)
	{
		if (running)
		{
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
