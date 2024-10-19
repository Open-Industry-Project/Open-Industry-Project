using Godot;

[Tool]
public partial class Pallet : Node3D
{	
	RigidBody3D rigidBody;
	Vector3 initialPos;
	public bool instanced = false;
	bool selected = false;
	bool keyHeld = false;
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
                SetPhysicsProcess(true);
                instanced = true;
            }
            else
            {
                SetPhysicsProcess(false);
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

    public override void _Process(double delta)
    {
        if (Main == null) return;

        selected = Main.selectedNodes.Contains(this);

        if (selected)
        {
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
    }

    public override void _PhysicsProcess(double delta)
    {
        if (Main == null) return;

        if (selected && Input.IsPhysicalKeyPressed(Key.G) && !Main.paused)
        {
            if (!keyHeld)
            {
                keyHeld = true;
                rigidBody.Freeze = !rigidBody.Freeze;
            }
        }

        if (!Input.IsPhysicalKeyPressed(Key.G))
        {
            keyHeld = false;
        }
    }

    void OnSimulationStarted()
	{
		if (Owner == null) return;
		
		initialPos = GlobalPosition;
		rigidBody.TopLevel = true;
		rigidBody.Freeze = false;
		SetPhysicsProcess(true);
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
			SetPhysicsProcess(false);
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
		rigidBody.Freeze = paused;
	}
}
