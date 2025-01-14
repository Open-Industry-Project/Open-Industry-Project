using Godot;
using System;
using System.Threading.Tasks;

[Tool]
public partial class ChainTransfer : Node3D
{
	const float BASE_LENGTH = 2.0f;

	ChainTransferBases ChainTransferBases => GetNode<ChainTransferBases>("ChainBases");

	PackedScene chainTransferBaseScene = (PackedScene)ResourceLoader.Load("res://src/ChainTransfer/Base.tscn");

	private bool enableComms;
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
	public string speedTag;
	[Export]
	public string popupTag;
	[Export]
	private int updateRate = 100;

	readonly Guid speedId = Guid.NewGuid();
	readonly Guid popupId = Guid.NewGuid();

	double scan_interval = 0;
	bool readSuccessful = false;

	int chains = 2;
	[Export] int Chains
	{
		get
		{
			return chains;
		}
		set
		{
			int new_value = Mathf.Clamp(value, 2, 6);
			if (new_value > chains)
			{
				SpawnChains(new_value - chains);
			}
			else
			{
				RemoveChains(chains - new_value);
			}

			chains = new_value;
			FixChains(chains);
			UpdateSimpleShape();
		}
	}

	float distance = 0.33f;
	[Export(PropertyHint.Range, "0.25,1,or_less,or_greater,suffix: m")] float Distance
	{
		get
		{
			return distance;
		}
		set
		{
			distance = Mathf.Clamp(value, 0.03f, 5.0f);
			SetChainsDistance(distance);
		}
	}

	float speed = 2.0f;
	[Export(PropertyHint.None, "suffix: m/s")] float Speed
	{
		get
		{
			return speed;
		}
		set
		{
			speed = value;
		}
	}


	bool popupChains = false;
	[Export] bool PopupChains
	{
		get
		{
			return popupChains;
		}
		set
		{
			popupChains = value;
		}
	}

	bool running = false;

	Vector3 prevScale;

	bool keyHeld = false;
	bool keyPressed = false;

	public Root Main { get; set; }

	public override void _ValidateProperty(Godot.Collections.Dictionary property)
	{
		string propertyName = property["name"].AsStringName();

		if (propertyName == PropertyName.updateRate || propertyName == PropertyName.speedTag || propertyName == PropertyName.popupTag)
		{
			property["usage"] = (int)(EnableComms ? PropertyUsageFlags.Default : PropertyUsageFlags.NoEditor);
		}
	}

	public ChainTransfer()
	{
		SetNotifyLocalTransform(true);
	}

	public override void _Notification(int what)
	{
		if (what == NotificationLocalTransformChanged)
		{
			if(Scale != prevScale)
			{
				Rescale();
			}
		}
		base._Notification(what);
	}

	public override void _Ready()
	{
		SpawnChains(chains - GetChildCount());
		SetChainsDistance(distance);
		SetChainsSpeed(speed);
		SetChainsPopupChains(popupChains);

		Rescale();
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
		popupChains = !popupChains;
	}

	public override void _PhysicsProcess(double delta)
	{
		SetChainsPopupChains(popupChains);

		if (running)
		{
			SetChainsSpeed(speed);

			if (EnableComms && readSuccessful)
			{
				scan_interval += delta;
				if (scan_interval > (float)updateRate/1000 && readSuccessful)
				{
					scan_interval = 0;
					Task.Run(ScanTag);
				}
			}
		}
	}

	void Rescale()
	{
		prevScale = new Vector3(Scale.X, 1, 1);
		Scale = prevScale;
		UpdateSimpleShape();
	}

	void SetChainsDistance(float distance)
	{
		ChainTransferBases.SetChainsDistance(distance);
	}

	void SetChainsSpeed(float speed)
	{
		ChainTransferBases.SetChainsSpeed(speed);
	}

	void SetChainsPopupChains(bool popupChains)
	{
		ChainTransferBases.SetChainsPopupChains(popupChains);
	}

	void TurnOnChains()
	{
		ChainTransferBases.TurnOnChains();
	}

	void TurnOffChains()
	{
		ChainTransferBases.TurnOffChains();
	}

	void SpawnChains(int count)
	{
		if (chains <= 0) return;
		for (int i = 0; i < count; i++)
		{
			ChainTransferBase chainBase = chainTransferBaseScene.Instantiate() as ChainTransferBase;
			ChainTransferBases.AddChild(chainBase, forceReadableName: true);
			chainBase.Owner = this;
			chainBase.Position = new Vector3(0, 0, distance * chainBase.GetIndex());
			chainBase.Active = popupChains;
			chainBase.Speed = speed;
			if (running) {
				chainBase.TurnOn();
			}
		}
	}

	void RemoveChains(int count)
	{
		ChainTransferBases.RemoveChains(count);
	}

	void FixChains(int chains)
	{
		ChainTransferBases.FixChains(chains);
	}

	async Task ScanTag()
	{
		try
		{
			Speed = await Main.ReadFloat(speedId);
		}
		catch
		{
			GD.PrintErr("Failure to read: " + speedTag + " in Node: " + Name);
			readSuccessful = false;
		}

		try
		{
			PopupChains = await Main.ReadBool(popupId);
		}
		catch
		{
			GD.PrintErr("Failure to write: " + popupTag + " in Node: " + Name);
			readSuccessful = false;
		}
	}

	void OnSimulationStarted()
	{
		running = true;
		TurnOnChains();
		if (enableComms)
		{
			readSuccessful = Main.Connect(speedId, Root.DataType.Float, Name, speedTag) && Main.Connect(popupId, Root.DataType.Bool, Name, popupTag);

		}
	}

	void OnSimulationEnded()
	{
		this.PopupChains = false;
		TurnOffChains();
		running = false;
	}

	void UpdateSimpleShape()
	{
		Node3D simpleConveyorShapeBody = GetNode<Node3D>("SimpleConveyorShape");
		simpleConveyorShapeBody.Scale = Scale.Inverse();
		CollisionShape3D simpleConveyorShapeNode = simpleConveyorShapeBody.GetNode<CollisionShape3D>("CollisionShape3D");
		simpleConveyorShapeNode.Position = new Vector3(0, -0.094f, (Chains - 1) * Distance / 2f);
		BoxShape3D simpleConveyorShape = simpleConveyorShapeNode.Shape as BoxShape3D;
		simpleConveyorShape.Size = new Vector3(Scale.X * BASE_LENGTH + 0.25f, 0.2f, (Chains - 1) * Distance + 0.042f * 2f);
	}
}
