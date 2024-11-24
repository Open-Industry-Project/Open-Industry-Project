using Godot;

[Tool]
public partial class PalletSpawner : Node3D
{
	[Export]
	PackedScene scene;
	private bool _disable = false;
	[Export]
	public bool Disable
	{
		get => _disable;
		set
		{
			_disable = value;
			if (!_disable)
			{
				scan_interval = spawnInterval;
			}
		}
	}
	[Export]
	public float spawnInterval = 3f;

	private float scan_interval = 0;

	Root Main;

	Vector3 _rotation;
	Vector3 _position;

	public override void _Ready()
	{
		if (Main != null)
		{
			SetPhysicsProcess(Main.simulationRunning);
		}
	}

	public override void _EnterTree()
	{
		SetNotifyLocalTransform(true);

		scan_interval = spawnInterval;

		Main = GetParent().GetTree().EditedSceneRoot as Root;

		if (Main != null)
		{
			Main.SimulationStarted += OnSimulationStarted;
			Main.SimulationEnded += OnSimulationEnded;
		}

		_rotation = GlobalRotation;
		_position = GlobalPosition;
	}

	public override void _ExitTree()
	{
		if (Main != null)
		{
			Main.SimulationStarted -= OnSimulationStarted;
			Main.SimulationEnded -= OnSimulationEnded;
		}
	}

	public override void _PhysicsProcess(double delta)
	{
		if (Main == null || Disable) return;

		scan_interval += (float)delta;
		if (scan_interval > spawnInterval)
		{
			scan_interval = 0;
			SpawnPallet();
		}
	}

	private void SpawnPallet()
	{
		var pallet = (Pallet)scene.Instantiate();

		pallet.Rotation = _rotation;
		pallet.Position = _position;
		pallet.instanced = true;

		AddChild(pallet, forceReadableName: true);
		pallet.Owner = Main;
	}

	void OnSimulationStarted()
	{
		SetPhysicsProcess(true);
		scan_interval = spawnInterval;
	}

	void OnSimulationEnded()
	{
		SetPhysicsProcess(false);
	}

	public override void _Notification(int what)
	{
		if (what == NotificationLocalTransformChanged)
		{
			_rotation = GlobalRotation;
			_position = GlobalPosition;
		}
	}
}
