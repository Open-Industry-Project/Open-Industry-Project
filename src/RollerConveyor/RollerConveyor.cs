using Godot;
using System;
using System.Threading.Tasks;

[Tool]
public partial class RollerConveyor : Node3D, IRollerConveyor
{
	private bool enableComms;

	[Signal]
	public delegate void SetSpeedEventHandler(float speed);

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

	float prevSpeed = 0.0f;

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
	Vector3 lastScale = Vector3.One;
	Transform3D xformPrev = Transform3D.Identity;

    const float radius = 0.12f;
    const float circumference = 2f * MathF.PI * radius;
	const float baseWidth = 2f;

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
		var meshInstance1 = GetNode<MeshInstance3D>("ConvRoller/ConvRollerL");
		var meshInstance2 = GetNode<MeshInstance3D>("ConvRoller/ConvRollerR");
		meshInstance1.Mesh = meshInstance1.Mesh.Duplicate() as Mesh;
		metalMaterial = meshInstance1.Mesh.SurfaceGetMaterial(0).Duplicate() as Material;
		meshInstance1.Mesh.SurfaceSetMaterial(0, metalMaterial);
		meshInstance2.Mesh.SurfaceSetMaterial(0, metalMaterial);

		rollers = GetNodeOrNull<Rollers>("Rollers");
		ends = GetNodeOrNull<Node3D>("Ends");

		SetLength(Scale.X);
		SetWidth(Scale.Z * baseWidth);

		SetRollersRotation();
    }

	public override void _EnterTree()
	{
		rollerMaterial ??= (StandardMaterial3D)GD.Load("res://assets/3DModels/Materials/Metall2.tres").Duplicate(true);
        
		Main = GetParent().GetTree().EditedSceneRoot as Root;

        if (Main != null)
		{
			Main.SimulationStarted += OnSimulationStarted;
			Main.SimulationEnded += OnSimulationEnded;

            running = Main.simulationRunning;
        }

		SetNotifyLocalTransform(true);
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
		if (Transform != xformPrev) {
			Basis newBasis;
			// Ensure we're working with positive basis vectors.
			// Fall back to the previous basis if necessary.
			if (Scale.X <= 0 || Scale.Y <= 0 || Scale.Z <= 0)
			{
				newBasis = xformPrev.Basis;
			} else {
				newBasis = Transform.Basis;
			}
			newBasis.X = Mathf.Max(1.0f, Mathf.Abs(Scale.X)) * newBasis.X.Normalized();
			newBasis.Y = newBasis.Y.Normalized();
			newBasis.Z = Mathf.Max(0.1f, Mathf.Abs(Scale.Z)) * newBasis.Z.Normalized();
			Transform = new Transform3D(newBasis, Transform.Origin);
			xformPrev = Transform;

			if (rollers != null && lastScale != Scale)
			{
				rollers.ChangeScale(Scale);
				lastScale = Scale;
			}
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

	public override void _Notification(int what)
	{
		if (what == NotificationLocalTransformChanged)
		{
			SetLength(Scale.X);
			SetWidth(Scale.Z * 2f);
		}
	}

	void SetRollersSpeed()
	{
		if (Speed == prevSpeed) return;

		EmitSignal(SignalName.SetSpeed, Speed);
	}

	void SetRollersRotation()
	{
		if (rollers != null)
		{
			rollers.SetRollerSkewAngle(SkewAngle);
		}

		if (ends != null)
		{
			foreach(RollerConveyorEnd end in ends.GetChildren())
			{
				end.RotateRoller(new Vector3(end.RotationDegrees.X, SkewAngle, end.RotationDegrees.Z));
			}
		}
	}

	void SetLength(float length)
	{
		foreach(RollerConveyorEnd end in ends.GetChildren())
		{
			end.SetLength(length);
		}
	}

	void SetWidth(float width)
	{
		var meshInstance1 = GetNode<Node3D>("ConvRoller/ConvRollerL");
		var meshInstance2 = GetNode<Node3D>("ConvRoller/ConvRollerR");
		meshInstance1.Scale = new Vector3(1f, 1f, baseWidth / width);
		meshInstance2.Scale = new Vector3(1f, 1f, baseWidth / width);
		foreach(RollerConveyorEnd end in ends.GetChildren())
		{
			end.SetWidth(width);
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
