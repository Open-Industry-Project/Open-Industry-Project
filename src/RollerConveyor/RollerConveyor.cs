using Godot;
using System;
using System.Threading.Tasks;

[Tool]
public partial class RollerConveyor : Node3D, IRollerConveyor
{
	private bool enableComms;

	[Export]
	public bool EnableComms
	{
		get => enableComms;
		set
		{
			enableComms = value;
			NotifyPropertyListChanged();
		}
	}
	[Export]
	private string tag;
	public string Tag { get => tag; set => tag = value; }
	[Export]
	private int updateRate = 100;
	public int UpdateRate { get => updateRate; set => updateRate = value; }
	[Export(PropertyHint.None, "suffix:m/s")]
	public float Speed { get; set; }

	float skewAngle = 0.0f;
	[Export]
	public float SkewAngle
	{
		get
		{
			return skewAngle;
		}
		set
		{
			skewAngle = value;
			SetRollersRotation();
		}
	}

	float nodeScaleX = 1.0f;
	float nodeScaleZ = 1.0f;
	float lastScale = 0.0f;

    const float radius = 0.12f;
    const float circumference = 2f * MathF.PI * radius;

    MeshInstance3D meshInstance;
	Material metalMaterial;
	Rollers rollers;
	Node3D ends;

	readonly Guid id = Guid.NewGuid();
	double scan_interval = 0;
	bool running = false;
	bool readSuccessful = false;

	Node3D rollersLow;
	Node3D rollersMid;
	Node3D rollersHigh;

	Root main;

	public StandardMaterial3D rollerMaterial;
	public Root Main
	{
		get
		{
			return main;
		}
		set
		{
			main = value;
		}
	}

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
		meshInstance = GetNode<MeshInstance3D>("ConvRoller");
		meshInstance.Mesh = meshInstance.Mesh.Duplicate() as Mesh;
		metalMaterial = meshInstance.Mesh.SurfaceGetMaterial(0).Duplicate() as Material;
		meshInstance.Mesh.SurfaceSetMaterial(0, metalMaterial);
		rollers = GetNodeOrNull<Rollers>("Rollers");
		ends = GetNodeOrNull<Node3D>("Ends");

		SetRollersSpeed();
		SetRollersRotation();
    }

	public override void _EnterTree()
	{
        rollerMaterial = (StandardMaterial3D)GD.Load("res://assets/3DModels/Materials/Metall2.tres").Duplicate(true);
        
		Main = GetParent().GetTree().EditedSceneRoot as Root;

        if (Main != null)
		{
			Main.SimulationStarted += OnSimulationStarted;
			Main.SimulationEnded += OnSimulationEnded;

			if (Main.simulationRunning)
			{
				running = true;
			}
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
		if (Scale.X >= 1.0f)
			nodeScaleX = Scale.X;

		nodeScaleZ = Scale.Z;

		Vector3 newScale = new(nodeScaleX, 1, nodeScaleZ);
		if (Scale != newScale)
		{
			Scale = new Vector3(nodeScaleX, 1, nodeScaleZ);
		}

        if (rollers != null && lastScale != Scale.X)
        {
            rollers.ChangeScale(Scale.X);
            lastScale = Scale.X;
        }
    }

	public override void _PhysicsProcess(double delta)
	{        
		if (metalMaterial != null)
			((ShaderMaterial)metalMaterial).SetShaderParameter("Scale", Scale.X);


		if (running)
		{
            rollerMaterial.Uv1Offset += new Vector3(4f * Speed / circumference * (float)delta, 0, 0);
            
			SetRollersSpeed();

			if (enableComms && running && readSuccessful)
			{
				scan_interval += delta;
				if (scan_interval > (float)updateRate / 1000 && readSuccessful)
				{
					scan_interval = 0;
					Task.Run(ScanTag);
				}
			}
		}
	}

	void SetRollersSpeed()
	{        
		if (rollers != null)
		{
			foreach (Roller roller in rollers.GetChildren())
			{
				roller.Speed = Speed;
			}
		}

		if (ends != null)
		{
			foreach(RollerConveyorEnd end in ends.GetChildren())
			{
				end.SetSpeed(Speed);
			}
		}
	}

	void SetRollersRotation()
	{
		if (rollers != null)
		{
			foreach (Roller roller in rollers.GetChildren())
			{
				roller.RotationDegrees = new Vector3(0, SkewAngle, 0);
			}
		}

		if (ends != null)
		{
			foreach(RollerConveyorEnd end in ends.GetChildren())
			{
				end.RotateRoller(new Vector3(end.RotationDegrees.X, SkewAngle, end.RotationDegrees.Z));
			}
		}
	}

	void OnSimulationStarted()
	{
		running = true;
		if (enableComms)
		{
			readSuccessful = Main.Connect(id, Root.DataType.Float, Name, tag);
		}
	}

	void OnSimulationEnded()
	{
		running = false;
	}

	async Task ScanTag()
	{
		try
		{
			Speed = await Main.ReadFloat(id);
		}
		catch
		{
			GD.PrintErr("Failure to read: " + tag + " in Node: " + Name);
			readSuccessful = false;
		}
	}
}
