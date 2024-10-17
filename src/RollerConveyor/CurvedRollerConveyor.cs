using Godot;
using System;
using System.Threading.Tasks;

[Tool]
public partial class CurvedRollerConveyor : Node3D, IRollerConveyor
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
	string tag;
	public string Tag { get => tag; set => tag = value; }
	[Export]
	private int updateRate = 100;
	public int UpdateRate { get => updateRate; set => updateRate = value; }
	[Export(PropertyHint.None, "suffix:m/s")]
	public float Speed { get; set; }
	[Export] // See _ValidateProperty for PropertyHint
	/// <summary>
	/// Distance from outer edge to measure Speed at.
	/// </summary>
	public float ReferenceDistance = 0.5f; // Assumes a 1m wide package.

	// Based on the CurvedRollerConveyor model geometry at scale=1
	const float CURVE_BASE_INNER_RADIUS = 0.5f;
	const float CURVE_BASE_OUTER_RADIUS = 2.5f;
	const float BASE_CONVEYOR_WIDTH = CURVE_BASE_OUTER_RADIUS - CURVE_BASE_INNER_RADIUS;

	private float AngularSpeedAroundCurve {
		get {
			float referenceRadius = Scale.X * CURVE_BASE_OUTER_RADIUS - ReferenceDistance;
			return referenceRadius == 0f ? 0f : Speed / referenceRadius;
		}
	}

	private float RollerAngularSpeed {
		get {
			if (Scale.X == 0f) return 0f;
			// Based on RollerCorner model geometry.
			const float ROLLER_INNER_END_RADIUS = 0.044587f;
			const float ROLLER_OUTER_END_RADIUS = 0.12f;

			const float BASE_ROLLER_LENGTH = BASE_CONVEYOR_WIDTH;
			float referencePointAlongRoller = BASE_ROLLER_LENGTH - ReferenceDistance / Scale.X;
			float rollerRadiusAtReferencePoint = ROLLER_INNER_END_RADIUS + referencePointAlongRoller * (ROLLER_OUTER_END_RADIUS - ROLLER_INNER_END_RADIUS) / BASE_ROLLER_LENGTH;
			return rollerRadiusAtReferencePoint == 0f ? 0f : Speed / rollerRadiusAtReferencePoint;
		}
	}

	enum Scales { Low, Mid, High }
	Scales currentScale = Scales.Mid;
	Scales CurrentScale
	{
		get
		{
			return currentScale;
		}
		set
		{
			if (value != currentScale)
			{
				currentScale = value;
				switch (currentScale)
				{
					case Scales.Low:
						rollersLow.Visible = true;
						rollersMid.Visible = false;
						rollersHigh.Visible = false;
						break;
					case Scales.Mid:
						rollersLow.Visible = false;
						rollersMid.Visible = true;
						rollersHigh.Visible = false;
						break;
					case Scales.High:
						rollersLow.Visible = false;
						rollersMid.Visible = true;
						rollersHigh.Visible = true;
						break;
				}
			}
		}
	}

	bool run = true;

	readonly Guid id = Guid.NewGuid();
	double scan_interval = 0;
	bool running = false;
	bool readSuccessful = false;

	MeshInstance3D meshInstance;
	Material metalMaterial;

	Node3D rollersLow;
	Node3D rollersMid;
	Node3D rollersHigh;

	Node3D ends;

	Root Main;

	private float prevScaleX;

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
			prevScaleX = Scale.X;
		}
		else
		{
			base._ValidateProperty(property);
		}
	}
	public override void _Ready()
	{
		meshInstance = GetNode<MeshInstance3D>("MeshInstance3D");
		meshInstance.Mesh = meshInstance.Mesh.Duplicate() as Mesh;
		metalMaterial = meshInstance.Mesh.SurfaceGetMaterial(0).Duplicate() as Material;
		meshInstance.Mesh.SurfaceSetMaterial(0, metalMaterial);

		rollersLow = GetNode<Node3D>("RollersLow");
		rollersMid = GetNode<Node3D>("RollersMid");
		rollersHigh = GetNode<Node3D>("RollersHigh");

		ends = GetNode<Node3D>("Ends");

		SetCurrentScale();

		SetRollersSpeed(rollersLow, RollerAngularSpeed);
		SetRollersSpeed(rollersMid, RollerAngularSpeed);
		SetRollersSpeed(rollersHigh, RollerAngularSpeed);
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
        if (Scale != newScale)
        {
            Scale = new Vector3(Scale.X, 1, Scale.X);
        }

		// ReferenceDistance's PropertyHint depends on Scale.X
		if (prevScaleX != Scale.X) {
			NotifyPropertyListChanged();
		}
    }

    public override void _PhysicsProcess(double delta)
	{
		if (Scale.X > 0.5f)
		{
			if (metalMaterial != null && Speed != 0)
				((ShaderMaterial)metalMaterial).SetShaderParameter("Scale", Scale.X);
		}

		if (ends != null)
		{
			foreach(MeshInstance3D end in ends.GetChildren())
			{
				end.Scale = new Vector3(1 / Scale.X, 1, 1);
			}
		}

		if (running)
		{
			SetRollersSpeed(rollersLow, RollerAngularSpeed);
			SetRollersSpeed(rollersMid, RollerAngularSpeed);
			SetRollersSpeed(rollersHigh, RollerAngularSpeed);

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

		SetCurrentScale();
	}

	void SetCurrentScale()
	{
		if (Scale.X < 0.8f)
		{
			CurrentScale = Scales.Low;
		}
		else if(Scale.X >= 0.8f && Scale.X < 1.6f)
		{
			CurrentScale = Scales.Mid;
		}
		else
		{
			CurrentScale = Scales.High;
		}
	}

	void SetRollersSpeed(Node3D rollers, float speed)
	{
		if (rollers != null)
		{
			foreach(RollerCorner roller in rollers.GetChildren())
			{
				roller.SetSpeed(speed);
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
