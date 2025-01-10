using Godot;

[Tool]
public partial class Box : Node3D
{
	[Export] public Vector3 InitialLinearVelocity = Vector3.Zero;
	RigidBody3D rigidBody;
	Transform3D initialTransform;
	public bool instanced = false;
	bool _paused = false;
	bool enable_inital_transform = false;

	Root Main;
	public override void _Ready()
	{
		rigidBody = GetNode<RigidBody3D>("RigidBody3D");

		if (Main != null)
		{
			if (Main.simulationRunning)
			{
				instanced = true;
			}

			rigidBody.Freeze = !Main.simulationRunning;
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
		if (_paused || (Main != null && !Main.simulationRunning)) return;
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
		if (Main == null) return;

		initialTransform = GlobalTransform;
		rigidBody.LinearVelocity = InitialLinearVelocity;
		rigidBody.TopLevel = true;
		rigidBody.Freeze = false;
		enable_inital_transform = true;
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

			rigidBody.Transform = Transform3D.Identity;

			rigidBody.LinearVelocity = Vector3.Zero;
			rigidBody.AngularVelocity = Vector3.Zero;

			//Work around for #83 
			if (enable_inital_transform)
			{
				GlobalTransform = initialTransform;
			}

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
