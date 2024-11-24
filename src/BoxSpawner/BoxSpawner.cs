using Godot;

[Tool]
public partial class BoxSpawner : Node3D
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
	public bool SpawnRandomScale = false;
	[Export]
	public Vector2 spawnRandomSize = new(0.5f, 1f);
	[Export]
	public float spawnInterval = 1f;

	private float scan_interval = 0;

	Root Main;

	Vector3 _rotation;
	Vector3 _position;
	Vector3 _scale;

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

		_scale = Scale;
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
			SpawnBox();
		}
	}

	private void SpawnBox()
	{
		var box = (Box)scene.Instantiate();

		if (SpawnRandomScale)
		{
			var x = (float)GD.RandRange(spawnRandomSize.X, spawnRandomSize.Y);
			var y = (float)GD.RandRange(spawnRandomSize.X, spawnRandomSize.Y);
			var z = (float)GD.RandRange(spawnRandomSize.X, spawnRandomSize.Y);
			box.Scale = new Vector3(x, y, z);
		}
		else
		{
			box.Scale = _scale;
		}

		box.Rotation = _rotation;
		box.Position = _position;
		box.instanced = true;

		AddChild(box, forceReadableName:true);
		box.Owner = Main;
	}

	public void Use()
	{
		Disable = !Disable;
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
			_scale = Scale;
			_rotation = GlobalRotation;
			_position = GlobalPosition;
		}
	}
}
