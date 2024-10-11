using Godot;
using System;
using System.Threading.Tasks;

[Tool]
public partial class CurvedBeltConveyor : Node3D, IBeltConveyor
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
	public string tag;
	public string Tag { get => tag; set => tag = value; }
	[Export]
	private int updateRate = 100;
	public int UpdateRate { get => updateRate; set => updateRate = value; }

	Color beltColor = new Color(1, 1, 1, 1);
	[Export]
	public Color BeltColor
	{
		get
		{
			return beltColor;
		}
		set
		{
			beltColor = value;

			if (beltMaterial != null)
				((ShaderMaterial)beltMaterial).SetShaderParameter("ColorMix", beltColor);
			if (conveyorEnd1 != null)
				((ShaderMaterial)conveyorEnd1.beltMaterial).SetShaderParameter("ColorMix", beltColor);
			if (conveyorEnd2 != null)
				((ShaderMaterial)conveyorEnd2.beltMaterial).SetShaderParameter("ColorMix", beltColor);
		}
	}

	IBeltConveyor.ConvTexture beltTexture = IBeltConveyor.ConvTexture.Standard;
	[Export]
	public IBeltConveyor.ConvTexture BeltTexture
	{
		get
		{
			return beltTexture;
		}
		set
		{
			beltTexture = value;
			if (beltMaterial != null)
				((ShaderMaterial)beltMaterial).SetShaderParameter("BlackTextureOn", beltTexture == IBeltConveyor.ConvTexture.Standard);
			if (conveyorEnd1 != null)
				((ShaderMaterial)conveyorEnd1.beltMaterial).SetShaderParameter("BlackTextureOn", beltTexture == IBeltConveyor.ConvTexture.Standard);
			if (conveyorEnd2 != null)
				((ShaderMaterial)conveyorEnd2.beltMaterial).SetShaderParameter("BlackTextureOn", beltTexture == IBeltConveyor.ConvTexture.Standard);
		}
	}

	[Export(PropertyHint.None, "suffix:m/s")]
	public float Speed { get; set; }

	StaticBody3D sb;
	MeshInstance3D mesh;
	Material beltMaterial;
	Material metalMaterial;

	Vector3 origin;
	bool running = false;
	public double beltPosition = 0.0;

	readonly Guid id = Guid.NewGuid();
	double scan_interval = 0;
	bool readSuccessful = false;

	ConveyorEnd conveyorEnd1;
	ConveyorEnd conveyorEnd2;

	Root main;
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
		sb = GetNode<StaticBody3D>("StaticBody3D");
		mesh = GetNode<MeshInstance3D>("StaticBody3D/MeshInstance3D");
		mesh.Mesh = mesh.Mesh.Duplicate() as Mesh;
		metalMaterial = mesh.Mesh.SurfaceGetMaterial(0).Duplicate() as Material;
		beltMaterial = mesh.Mesh.SurfaceGetMaterial(1).Duplicate() as Material;
		mesh.Mesh.SurfaceSetMaterial(0, metalMaterial);
		mesh.Mesh.SurfaceSetMaterial(1, beltMaterial);

		conveyorEnd1 = GetNode<ConveyorEnd>("ConveyorEnd");
		conveyorEnd2 = GetNode<ConveyorEnd>("ConveyorEnd2");

		origin = sb.Position;

		((ShaderMaterial)beltMaterial).SetShaderParameter("BlackTextureOn", beltTexture == IBeltConveyor.ConvTexture.Standard);
		conveyorEnd1.beltMaterial.SetShaderParameter("BlackTextureOn", beltTexture == IBeltConveyor.ConvTexture.Standard);
		conveyorEnd2.beltMaterial.SetShaderParameter("BlackTextureOn", beltTexture == IBeltConveyor.ConvTexture.Standard);

		((ShaderMaterial)beltMaterial).SetShaderParameter("ColorMix", beltColor);
		conveyorEnd1.beltMaterial.SetShaderParameter("ColorMix", beltColor);
		conveyorEnd2.beltMaterial.SetShaderParameter("ColorMix", beltColor);
	}

    public override void _EnterTree()
    {
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

		Vector3 newScale = new(Scale.X, 1, Scale.X);
		if(Scale != newScale)
		{
			Scale = new Vector3(Scale.X, 1, Scale.X);
		}
	}

	public override void _PhysicsProcess(double delta)
	{
		if (Main == null) return;

		if (running)
		{
			var localUp = sb.GlobalTransform.Basis.Y.Normalized();
			var velocity = -localUp * Speed * MathF.PI * 0.25f * (1 / Scale.X);
			sb.ConstantAngularVelocity = velocity;

			beltPosition += Speed * delta;
			if (Speed != 0)
				((ShaderMaterial)beltMaterial).SetShaderParameter("BeltPosition", beltPosition * Mathf.Sign(Speed));
			if (beltPosition >= 1.0)
				beltPosition = 0.0;

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

		if (Scale.X > 0.5f)
		{
			if (beltMaterial != null && Speed != 0)
				((ShaderMaterial)beltMaterial).SetShaderParameter("Scale", Scale.X * Mathf.Sign(Speed));

			if (metalMaterial != null && Speed != 0)
				((ShaderMaterial)metalMaterial).SetShaderParameter("Scale", Scale.X);
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

		beltPosition = 0;
		((ShaderMaterial)beltMaterial).SetShaderParameter("BeltPosition", beltPosition);

		foreach (Node3D child in sb.GetChildren())
		{
			child.Position = Vector3.Zero;
			child.Rotation = Vector3.Zero;
		}
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
