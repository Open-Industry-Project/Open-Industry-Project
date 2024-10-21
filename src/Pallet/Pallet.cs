using Godot;

[Tool]
public partial class Pallet : Node3D
{	
	RigidBody3D rigidBody;
	Vector3 initialPos;
	public bool instanced = false;
    private bool _paused = false;

	Root Main;
	
	public override void _Ready()
	{
		rigidBody = GetNode<RigidBody3D>("RigidBody3D");

        if (Main != null)
        {
            rigidBody.Freeze = false;
        }
	}

    public override void _EnterTree()
    {
        Main = GetParent().GetTree().EditedSceneRoot as Root;

        if (Main != null)
        {
            Main.SimulationStarted += OnSimulationStarted;
            Main.SimulationEnded += OnSimulationEnded;
            Main.SimulationSetPaused += OnSimulationSetPaused;

            if (Main.simulationRunning)
            {
                instanced = true;
            }
        }
    }

    public override void _ExitTree()
    {
        if (Main != null)
        {
            Main.SimulationStarted -= OnSimulationStarted;
            Main.SimulationEnded -= OnSimulationEnded;
            Main.SimulationSetPaused -= OnSimulationSetPaused;

            if (instanced) QueueFree();
        }
    }

    public void Select()
    {
        if (_paused) return;
        if (rigidBody.Freeze)
        {
            rigidBody.TopLevel = false;

            if (rigidBody.Transform != Transform3D.Identity)
            {
                rigidBody.Transform = Transform3D.Identity;
            }
        }
        else
        {
            rigidBody.TopLevel = true;

            if (Transform != rigidBody.Transform)
            {
                Transform = rigidBody.Transform;
            }
        }
    }

    public void Use()
    {
        rigidBody.Freeze = !rigidBody.Freeze;
    }

    void OnSimulationStarted()
	{
		if (Owner == null) return;
		
		initialPos = GlobalPosition;
		rigidBody.TopLevel = true;
		rigidBody.Freeze = false;
	}
	
	void OnSimulationEnded()
	{
		if (instanced)
		{
			Main.SimulationStarted -= OnSimulationStarted;
			Main.SimulationEnded -= OnSimulationEnded;
			Main.SimulationSetPaused -= OnSimulationSetPaused;
			QueueFree();
		}
		else
		{
			rigidBody.TopLevel = false;

			rigidBody.Position = Vector3.Zero;
			rigidBody.Rotation = Vector3.Zero;
			rigidBody.Scale = Vector3.One;

			rigidBody.LinearVelocity = Vector3.Zero;
			rigidBody.AngularVelocity = Vector3.Zero;

			GlobalPosition = initialPos;
			Rotation = Vector3.Zero;
		}
	}

    void OnSimulationSetPaused(bool paused)
    {
        _paused = paused;
        rigidBody.TopLevel = true;
        rigidBody.Freeze = paused;
        Transform = rigidBody.Transform;
        rigidBody.TopLevel = !paused;
    }
}
