using Godot;
using System;

[Tool]
public partial class BeltConveyor : Node3D, IBeltConveyor
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
	int updateRate = 100;
	public int UpdateRate { get => updateRate; set => updateRate = value; }

	Color beltColor = new(1, 1, 1, 1);
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
				((ShaderMaterial)conveyorEnd1.beltMaterial)?.SetShaderParameter("ColorMix", beltColor);
			if (conveyorEnd2 != null)
				((ShaderMaterial)conveyorEnd2.beltMaterial)?.SetShaderParameter("ColorMix", beltColor);
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
			((ShaderMaterial)beltMaterial)?.SetShaderParameter("BlackTextureOn", beltTexture == IBeltConveyor.ConvTexture.Standard);
			((ShaderMaterial)conveyorEnd1?.beltMaterial)?.SetShaderParameter("BlackTextureOn", beltTexture == IBeltConveyor.ConvTexture.Standard);
			((ShaderMaterial)conveyorEnd2?.beltMaterial)?.SetShaderParameter("BlackTextureOn", beltTexture == IBeltConveyor.ConvTexture.Standard);
		}
	}

	[Export(PropertyHint.None, "suffix:m/s")]
	public float Speed
	{
		get { return _speed; }
		set
		{
			if (value == _speed) return;

			_speed = value;

			if (Main == null || !Main.simulationRunning || !EnableComms)
			{
				return;
			}

			if (conveyorEnd1 != null)
			{
				conveyorEnd1.Speed = Speed;
			}
			if (conveyorEnd2 != null)
			{
				conveyorEnd2.Speed = Speed;
			}
			UpdateBeltMaterialScale();
			Callable.From(WriteTag).CallDeferred();

		}
	}
	private float _speed;

	[Export]
	public PhysicsMaterial BeltPhysicsMaterial
	{
		get => GetNodeOrNull<StaticBody3D>("StaticBody3D")?.PhysicsMaterialOverride;
		set
		{
			GetNodeOrNull<StaticBody3D>("StaticBody3D")?.SetPhysicsMaterialOverride(value);
			GetNodeOrNull<StaticBody3D>("ConveyorEnd/StaticBody3D")?.SetPhysicsMaterialOverride(value);
			GetNodeOrNull<StaticBody3D>("ConveyorEnd2/StaticBody3D")?.SetPhysicsMaterialOverride(value);
		}
	}

	readonly Guid id = Guid.NewGuid();
	double scan_interval = 0;
	bool readSuccessful = false;

	StaticBody3D sb;
	MeshInstance3D mesh;
	Material beltMaterial;
	Material metalMaterial;

	bool running = false;
	public double beltPosition = 0.0;
	Vector3 boxSize;

	ConveyorEnd conveyorEnd1 => GetNodeOrNull<ConveyorEnd>("ConveyorEnd");
	ConveyorEnd conveyorEnd2 => GetNodeOrNull<ConveyorEnd>("ConveyorEnd2");

	public Root Main { get; set; }

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
		beltMaterial = mesh.Mesh.SurfaceGetMaterial(0).Duplicate() as Material;
		metalMaterial = mesh.Mesh.SurfaceGetMaterial(1).Duplicate() as Material;
		mesh.Mesh.SurfaceSetMaterial(0, beltMaterial);
		mesh.Mesh.SurfaceSetMaterial(1, metalMaterial);
		mesh.Mesh.SurfaceSetMaterial(2, metalMaterial);

		((ShaderMaterial)beltMaterial).SetShaderParameter("BlackTextureOn", beltTexture == IBeltConveyor.ConvTexture.Standard);
		conveyorEnd1.beltMaterial.SetShaderParameter("BlackTextureOn", beltTexture == IBeltConveyor.ConvTexture.Standard);
		conveyorEnd2.beltMaterial.SetShaderParameter("BlackTextureOn", beltTexture == IBeltConveyor.ConvTexture.Standard);

		((ShaderMaterial)beltMaterial).SetShaderParameter("ColorMix", beltColor);
		conveyorEnd1.beltMaterial.SetShaderParameter("ColorMix", beltColor);
		conveyorEnd2.beltMaterial.SetShaderParameter("ColorMix", beltColor);

		conveyorEnd1.Speed = Speed;
		conveyorEnd2.Speed = Speed;

		conveyorEnd1.GetNode<StaticBody3D>("StaticBody3D").PhysicsMaterialOverride = sb.PhysicsMaterialOverride;
		conveyorEnd2.GetNode<StaticBody3D>("StaticBody3D").PhysicsMaterialOverride = sb.PhysicsMaterialOverride;
	}

	public override void _EnterTree()
	{
		Main = GetParent().GetTree().EditedSceneRoot as Root;

		if (Main != null)
		{
			Main.SimulationStarted += OnSimulationStarted;
			Main.SimulationEnded += OnSimulationEnded;
			Main.ValueChanged += OnValueChanged;

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

	public BeltConveyor()
	{
		SetNotifyLocalTransform(true);
	}

	public override void _Notification(int what)
	{
		if (what == NotificationLocalTransformChanged)
		{
			if (Scale.Y != 1)
			{
				Scale = new Vector3(Scale.X, 1, Scale.Z);
				return;
			}
			OnScaleChanged();
		}
		base._Notification(what);
	}

	private void OnScaleChanged()
	{
		UpdateBeltMaterialScale();
		UpdateMetalMaterialScale();
		conveyorEnd1.OnOwnerScaleChanged(Scale);
		conveyorEnd2.OnOwnerScaleChanged(Scale);
	}

	public override void _PhysicsProcess(double delta)
	{
		if (Main == null) return;

		if (running)
		{
			var localLeft = sb.GlobalTransform.Basis.X.Normalized();
			var velocity = localLeft * Speed;
			sb.ConstantLinearVelocity = velocity;

			if (!Main.simulationPaused)
				beltPosition += Speed * delta;
			if (Speed != 0)
				((ShaderMaterial)beltMaterial).SetShaderParameter("BeltPosition", beltPosition * Mathf.Sign(Speed));
			if (beltPosition >= 1.0)
				beltPosition = 0.0;

			if (EnableComms && Main.Protocol != Root.Protocols.opc_ua && running && readSuccessful)
			{
				scan_interval += delta;
				if (scan_interval > (float)updateRate / 1000 && readSuccessful)
				{
					scan_interval = 0;
					Callable.From(ReadTag).CallDeferred();
				}
			}
		}
	}

	void UpdateBeltMaterialScale()
	{
		if (beltMaterial != null && Speed != 0)
		{
			((ShaderMaterial)beltMaterial).SetShaderParameter("Scale", Scale.X * Mathf.Sign(Speed));
		}
	}

	void UpdateMetalMaterialScale()
	{
		if (metalMaterial != null)
		{
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

		sb.ConstantLinearVelocity = Vector3.Zero;

		foreach (Node3D child in sb.GetChildren())
		{
			child.Position = Vector3.Zero;
			child.Rotation = Vector3.Zero;
		}
	}

	void OnValueChanged(string tag, Godot.Variant value)
	{
		if (tag != this.tag) return;

		if ((float)value == Speed) return;

		Speed = (float)value;
	}

	async void ReadTag()
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

	async void WriteTag()
	{
		try
		{
			await Main.Write(id, Speed);
		}
		catch
		{
			GD.PrintErr("Failure to write: " + tag + " in Node: " + Name);
		}
	}
}
