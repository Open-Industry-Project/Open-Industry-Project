using Godot;

[Tool]
public partial class PalletSpawner : Node3D
{
	[Export]
	PackedScene scene;
	[Export]
	public float spawnInterval = 3f;

	private float scan_interval = 0;

	Root Main;

    public override void _EnterTree()
    {
        scan_interval = spawnInterval;

        Main = GetParent().GetTree().EditedSceneRoot as Root;

        if (Main != null)
        {
            Main.SimulationStarted += OnSimulationStarted;
            Main.SimulationEnded += OnSimulationEnded;
            SetProcess(Main.simulationRunning);
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

    public override void _Process(double delta)
	{
		if (Main == null) return;

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

        pallet.Rotation = Rotation;
        pallet.Position = GlobalPosition;
        pallet.instanced = true;

        AddChild(pallet, forceReadableName: true);
        pallet.Owner = Main;
    }

	void OnSimulationStarted()
	{
		SetProcess(true);
		scan_interval = spawnInterval;
	}

	void OnSimulationEnded()
	{
		SetProcess(false);
	}
}
