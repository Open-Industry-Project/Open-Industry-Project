using Godot;
using System;
using System.Threading.Tasks;

[Tool]
public partial class Diverter : Node3D
{
	private bool enableComms;

	[ExportToolButton("Divert")]
	public Callable DivertButton => Callable.From(Divert);

	[Export]
	private bool EnableComms
	{
		get => enableComms;
		set
		{
			enableComms = value;
			NotifyPropertyListChanged();
		}
	}
	[Export]
	public string tag;
	[Export]
	private int updateRate = 100;
	[Export]
	float divertTime = 0.3f;
	[Export]
	float divertDistance = 1.5f;

	bool FireDivert = false;

	bool readSuccessful = false;
	bool running = false;
	double scan_interval = 0;

	bool cycled = false;
	bool divert = false;
	private bool previousFireDivertState = false;

	readonly Guid id = Guid.NewGuid();
	DiverterAnimator diverterAnimator;
	Root Main;

	public override void _ValidateProperty(Godot.Collections.Dictionary property)
	{
		string propertyName = property["name"].AsStringName();

		if (propertyName == PropertyName.updateRate || propertyName == PropertyName.tag)
		{
			property["usage"] = (int)(EnableComms ? PropertyUsageFlags.Default : PropertyUsageFlags.NoEditor);
		}
	}

	public override void _Ready()
	{
		diverterAnimator = GetNode<DiverterAnimator>("DiverterAnimator");
	}
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

	public void Use()
	{
		Divert();
	}

	public void Divert()
	{
		FireDivert = true;

		Task.Delay(updateRate * 3).ContinueWith(t => FireDivert = false);
	}

	public override void _PhysicsProcess(double delta)
	{
		if (FireDivert && !previousFireDivertState)
		{
			divert = true;
			cycled = false;
		}

		if (divert && !cycled)
		{
			diverterAnimator.Fire(divertTime, divertDistance);
			divert = false;
			cycled = true;
		}

		previousFireDivertState = FireDivert;

		if (enableComms && readSuccessful && running)
		{
			scan_interval += delta;
			if (scan_interval > (float)updateRate / 1000 && readSuccessful)
			{
				scan_interval = 0;
				Callable.From(ScanTag).CallDeferred();
			}
		}
	}
	void OnSimulationStarted()
	{
		running = true;
		if (enableComms)
		{
			readSuccessful = Main.Connect(id, Root.DataType.Bool, Name, tag);
		}
	}

	void OnSimulationEnded()
	{
		running = false;
		diverterAnimator.Disable();
	}

	async void ScanTag()
	{
		try
		{
			FireDivert = await Main.ReadBool(id);
		}
		catch
		{
			GD.PrintErr("Failure to read: " + tag + " in Node: " + Name);
			readSuccessful = false;
		}
	}
}
