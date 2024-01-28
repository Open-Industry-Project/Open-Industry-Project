using Godot;

[Tool]
public partial class BoxSpawner : Node3D
{
	[Export]
	PackedScene scene;
	[Export]
	public bool SpawnRandomScale = false;
	[Export]
	public Vector2 spawnRandomSize = new(0.5f, 1f);
	[Export]
	public float spawnInterval = 1f;

	private float scan_interval = 0;

	Root Main;

	public override void _Ready()
	{
        Main = GetParent().GetTree().EditedSceneRoot as Root;

        if (Main != null)
        {
            Main.SimulationStarted += OnSimulationStarted;
            Main.SimulationEnded += OnSimulationEnded;
        }

        SetProcess(false);
	}

	public override void _Process(double delta)
	{
		if (Main == null) return;
		
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

		AddChild(box, forceReadableName:true);
		box.SetNewOwner(Main);
		box.SetPhysicsProcess(true);
		box.Position = Vector3.Zero;
	}
	
	void OnSimulationStarted()
	{
		if (Main == null) return;
		
		SetProcess(true);
		scan_interval = spawnInterval;
	}
	
	void OnSimulationEnded()
	{
		SetProcess(false);
	}
}
