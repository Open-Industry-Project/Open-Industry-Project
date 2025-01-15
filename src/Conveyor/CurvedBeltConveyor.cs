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
			((ShaderMaterial)beltMaterial)?.SetShaderParameter("BlackTextureOn", beltTexture == IBeltConveyor.ConvTexture.Standard);
			((ShaderMaterial)conveyorEnd1?.beltMaterial)?.SetShaderParameter("BlackTextureOn", beltTexture == IBeltConveyor.ConvTexture.Standard);
			((ShaderMaterial)conveyorEnd2?.beltMaterial)?.SetShaderParameter("BlackTextureOn", beltTexture == IBeltConveyor.ConvTexture.Standard);
		}
	}

	// Based on the model geometry at scale=1
	const float BASE_INNER_RADIUS = 0.25f;
	const float BASE_OUTER_RADIUS = 1.25f;
	const float BASE_CONVEYOR_WIDTH = BASE_OUTER_RADIUS - BASE_INNER_RADIUS;

	[Export(PropertyHint.None, "suffix:m/s")]
	public float Speed
	{
		get { return _speed; }
		set
		{
			_speed = value;
			RecalculateSpeeds();
			UpdateBeltMaterialScale();
		}
	}
	private float _speed;
	private float AngularSpeed;
	// The speed measured from the center of the belt, for the sake of animating the belt material.
	private float LinearSpeed;
	private float prevScaleX;

	[Export] // See _ValidateProperty for PropertyHint
	/// <summary>
	/// Distance from outer edge to measure Speed at.
	/// </summary>
	public float ReferenceDistance
	{
		get { return _referenceDistance; }
		set
		{
			_referenceDistance = value;
			RecalculateSpeeds();
		}
	}
	private float _referenceDistance = 0.5f; // Assumes a 1m wide package.

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

	ConveyorEnd conveyorEnd1 => GetNodeOrNull<ConveyorEnd>("ConveyorEnd");
	ConveyorEnd conveyorEnd2 => GetNodeOrNull<ConveyorEnd>("ConveyorEnd2");

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
		// Dynamically update maximum as Scale changes.
		else if (propertyName == PropertyName.ReferenceDistance) {
			property["hint"] = (int) PropertyHint.Range;
			property["hint_string"] = $"0,{Scale.X * BASE_CONVEYOR_WIDTH},suffix:m";
		}
		else
		{
			base._ValidateProperty(property);
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

		origin = sb.Position;

		((ShaderMaterial)beltMaterial).SetShaderParameter("BlackTextureOn", beltTexture == IBeltConveyor.ConvTexture.Standard);
		conveyorEnd1.beltMaterial.SetShaderParameter("BlackTextureOn", beltTexture == IBeltConveyor.ConvTexture.Standard);
		conveyorEnd2.beltMaterial.SetShaderParameter("BlackTextureOn", beltTexture == IBeltConveyor.ConvTexture.Standard);

		((ShaderMaterial)beltMaterial).SetShaderParameter("ColorMix", beltColor);
		conveyorEnd1.beltMaterial.SetShaderParameter("ColorMix", beltColor);
		conveyorEnd2.beltMaterial.SetShaderParameter("ColorMix", beltColor);

		conveyorEnd1.Speed = LinearSpeed;
		conveyorEnd2.Speed = LinearSpeed;

		conveyorEnd1.GetNode<StaticBody3D>("StaticBody3D").PhysicsMaterialOverride = sb.PhysicsMaterialOverride;
		conveyorEnd2.GetNode<StaticBody3D>("StaticBody3D").PhysicsMaterialOverride = sb.PhysicsMaterialOverride;

		prevScaleX = Scale.X;
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

	public CurvedBeltConveyor()
	{
		SetNotifyLocalTransform(true);
	}

	public override void _Notification(int what)
	{
		if (what == NotificationLocalTransformChanged)
		{
			SetNotifyLocalTransform(false);
			Scale = new Vector3(Scale.X, 1, Scale.X);
			SetNotifyLocalTransform(true);
			OnScaleChanged();
		}
		base._Notification(what);
	}

	private void OnScaleChanged()
	{
		if (prevScaleX != Scale.X) {
			RecalculateSpeeds();
			NotifyPropertyListChanged();
			if (Scale.X > 1f)
			{
				UpdateBeltMaterialScale();
				UpdateMetalMaterialScale();
			}
			conveyorEnd1.OnOwnerScaleChanged(Scale);
			conveyorEnd2.OnOwnerScaleChanged(Scale);
			prevScaleX = Scale.X;
		}
	}

	private void RecalculateSpeeds() {
			float referenceRadius = Scale.X * BASE_OUTER_RADIUS - ReferenceDistance;
			AngularSpeed = referenceRadius == 0f ? 0f : Speed / referenceRadius;
			LinearSpeed = AngularSpeed * (Scale.X * (BASE_OUTER_RADIUS + BASE_INNER_RADIUS) / 2f);

			if (conveyorEnd1 != null) {
				conveyorEnd1.Speed = LinearSpeed;
			}
			if (conveyorEnd2 != null) {
				conveyorEnd2.Speed = LinearSpeed;
			}
	}

	public override void _PhysicsProcess(double delta)
	{
		if (Main == null) return;

		if (running)
		{
			var localUp = sb.GlobalTransform.Basis.Y.Normalized();
			var velocity = -localUp * AngularSpeed;
			sb.ConstantAngularVelocity = velocity;

			if(!Main.simulationPaused)
				beltPosition += LinearSpeed * delta;
			if (LinearSpeed != 0)
				((ShaderMaterial)beltMaterial).SetShaderParameter("BeltPosition", beltPosition * Mathf.Sign(LinearSpeed));
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
	}

	void UpdateBeltMaterialScale()
	{
		if (beltMaterial != null && Speed != 0)
		{
			((ShaderMaterial)beltMaterial).SetShaderParameter("Scale", Scale.X / 2f * Mathf.Sign(Speed));
		}
	}

	void UpdateMetalMaterialScale()
	{
		if (metalMaterial != null)
		{
			((ShaderMaterial)metalMaterial).SetShaderParameter("Scale", Scale.X / 2f);
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
