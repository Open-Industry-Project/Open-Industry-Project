using Godot;
using System;
using System.Collections.Generic;
using System.Linq;
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
	public float Speed { get => speed; set { speed = value; SetAllRollersSpeed(); } }
	private float speed;
	[Export] // See _ValidateProperty for PropertyHint
	/// <summary>
	/// Distance from outer edge to measure Speed at.
	/// </summary>
	public float ReferenceDistance { get => referenceDistance; set { referenceDistance = value; SetAllRollersSpeed(); } }
	private float referenceDistance = 0.5f; // Assumes a 1m wide package.

	// Based on the CurvedRollerConveyor model geometry at scale=1
	const float CURVE_BASE_INNER_RADIUS = 0.25f;
	const float CURVE_BASE_OUTER_RADIUS = 1.25f;
	const float BASE_CONVEYOR_WIDTH = CURVE_BASE_OUTER_RADIUS - CURVE_BASE_INNER_RADIUS;
	// Based on the RollerCorner model geometry at scale=1
	const float BASE_ROLLER_LENGTH = 2f;
	const float ROLLER_INNER_END_RADIUS = 0.044587f;
	const float ROLLER_OUTER_END_RADIUS = 0.12f;

	private float AngularSpeedAroundCurve {
		get {
			float referenceRadius = Scale.X * CURVE_BASE_OUTER_RADIUS - ReferenceDistance;
			return referenceRadius == 0f ? 0f : Speed / referenceRadius;
		}
	}

	private float RollerAngularSpeed {
		get {
			if (Scale.X == 0f) return 0f;
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
						rollersLow?.SetVisible(true);
						rollersMid?.SetVisible(false);
						rollersHigh?.SetVisible(false);
						break;
					case Scales.Mid:
						rollersLow?.SetVisible(false);
						rollersMid?.SetVisible(true);
						rollersHigh?.SetVisible(false);
						break;
					case Scales.High:
						rollersLow?.SetVisible(false);
						rollersMid?.SetVisible(true);
						rollersHigh?.SetVisible(true);
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
	StandardMaterial3D rollerMaterial;

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
		rollerMaterial = TakeoverRollerMaterial();

		ends = GetNode<Node3D>("Ends");

		OnScaleChanged();
		SetAllRollersSpeed();
		SetNotifyLocalTransform(true);
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
		if (running)
		{
			float uvSpeed = RollerAngularSpeed / (2f*Mathf.Pi);
			Vector3 uvOffset = rollerMaterial.Uv1Offset;
			if(!Main.simulationPaused)
				uvOffset.X = (uvOffset.X % 1f + uvSpeed * (float)delta) % 1f;
			rollerMaterial.Uv1Offset = uvOffset;
		}
	}

	public override void _PhysicsProcess(double delta)
	{
		if (running)
		{
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
			OnScaleChanged();
		}
		base._Notification(what);
	}

	void OnScaleChanged()
	{
		ConstrainScale();

		// ReferenceDistance's PropertyHint depends on Scale.X
		if (prevScaleX != Scale.X) {
			NotifyPropertyListChanged();
		}

		if (Scale.X > 1f)
		{
			if (metalMaterial != null && Speed != 0)
				((ShaderMaterial)metalMaterial).SetShaderParameter("Scale", Scale.X / 2f);
		}

		if (ends != null)
		{
			foreach(MeshInstance3D end in ends.GetChildren())
			{
				end.Scale = new Vector3(1 / Scale.X, 1, 1);
			}
		}

		foreach (Node3D rollers in (Span<Node3D>)([rollersLow, rollersMid, rollersHigh]))
		{
			foreach (RollerCorner roller in rollers.GetChildren())
			{
				roller.Scale = new Vector3(BASE_ROLLER_LENGTH / BASE_CONVEYOR_WIDTH / Scale.X, 1, 1);
			}
		}

		RegenerateSimpleConveyorShape();

		SetCurrentScale();

		SetAllRollersSpeed();
	}

	void ConstrainScale()
	{
		Vector3 newScale = new(Scale.X, 1, Scale.X);
		if (Scale != newScale)
		{
			Scale = new Vector3(Scale.X, 1, Scale.X);
		}
	}

	void SetCurrentScale()
	{
		if (Scale.X < 1.5f)
		{
			CurrentScale = Scales.Low;
		}
		else if(Scale.X >= 1.5f && Scale.X < 3.2f)
		{
			CurrentScale = Scales.Mid;
		}
		else
		{
			CurrentScale = Scales.High;
		}
	}

	private StandardMaterial3D TakeoverRollerMaterial()
	{
		StandardMaterial3D dupMaterial = rollersLow.GetChild<RollerCorner>(0).GetMaterial().Duplicate() as StandardMaterial3D;
		foreach (Node3D rollers in (Span<Node3D>)([rollersLow, rollersMid, rollersHigh]))
		{
			foreach(RollerCorner roller in rollers.GetChildren())
			{
				roller.SetOverrideMaterial(dupMaterial);
			}
		}
		return dupMaterial;
	}

	private void SetAllRollersSpeed()
	{
		float speed = RollerAngularSpeed;
		SetRollersSpeed(rollersLow, speed);
		SetRollersSpeed(rollersMid, speed);
		SetRollersSpeed(rollersHigh, speed);
	}

	private void SetRollersSpeed(Node3D rollers, float speed)
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

	public float GetCurveInnerRadius()
	{
		return CURVE_BASE_INNER_RADIUS * Scale.X;
	}

	public float GetCurveOuterRadius()
	{
		return CURVE_BASE_OUTER_RADIUS * Scale.X;
	}

	void RegenerateSimpleConveyorShape()
	{
		Node3D simpleConveyorShapeBody = GetNode<Node3D>("SimpleConveyorShape");
		simpleConveyorShapeBody.Scale = Scale.Inverse();

		IEnumerable<ConvexPolygonShape3D> simpleConveyorShapes = simpleConveyorShapeBody.GetChildren().OfType<CollisionShape3D>().Select(x => x.Shape as ConvexPolygonShape3D);

		float innerRadius = GetCurveInnerRadius();
		float outerRadius = GetCurveOuterRadius();
		const float endSize = 0.125f;
		const float innerY = ROLLER_INNER_END_RADIUS;
		const float outerY = ROLLER_OUTER_END_RADIUS;

		const float arcAngle = Mathf.Pi / 2f;
		const int arcSplits = 20;
		const float splitAngle = arcAngle / arcSplits;
		const int pointCount = (arcSplits + 3) * 4;
		Vector3[] newPoints = new Vector3[pointCount];
		// First endcap
		newPoints[0] = new Vector3(endSize, innerY, innerRadius);
		newPoints[1] = new Vector3(endSize, outerY, outerRadius);
		newPoints[2] = new Vector3(endSize, -outerY, outerRadius);
		newPoints[3] = new Vector3(endSize, -innerY, innerRadius);
		for (int i = 0; i <= arcSplits; i++)
		{
			// Skip all the angles that we're going to throw away.
			// We end up reusing the first arc shape for all of the others, so we only need to calculate its points.
			// We also need the first and last angle's points for the end caps' shapes.
			if (1 < i && i < arcSplits) continue;

			// Radial edge loops
			float angle = splitAngle * i;
			float innerZ = Mathf.Cos(angle) * innerRadius;
			float innerX = -Mathf.Sin(angle) * innerRadius;
			float outerZ = Mathf.Cos(angle) * outerRadius;
			float outerX = -Mathf.Sin(angle) * outerRadius;
			newPoints[(i+1)*4+0] = new Vector3(innerX, innerY, innerZ);
			newPoints[(i+1)*4+1] = new Vector3(outerX, outerY, outerZ);
			newPoints[(i+1)*4+2] = new Vector3(outerX, -outerY, outerZ);
			newPoints[(i+1)*4+3] = new Vector3(innerX, -innerY, innerZ);
		}
		// Second endcap
		newPoints[pointCount - 4] = new Vector3(-innerRadius, innerY, -endSize);
		newPoints[pointCount - 3] = new Vector3(-outerRadius, outerY, -endSize);
		newPoints[pointCount - 2] = new Vector3(-outerRadius, -outerY, -endSize);
		newPoints[pointCount - 1] = new Vector3(-innerRadius, -innerY, -endSize);

		// Update shapes
		// arcSegmentShape is reused for all 20 arc segments.
		ConvexPolygonShape3D end1Shape = GetNode<CollisionShape3D>("SimpleConveyorShape/CollisionShape3DEnd1").Shape as ConvexPolygonShape3D;
		ConvexPolygonShape3D arcSegmentShape = GetNode<CollisionShape3D>("SimpleConveyorShape/CollisionShape3D1").Shape as ConvexPolygonShape3D;
		ConvexPolygonShape3D end2Shape = GetNode<CollisionShape3D>("SimpleConveyorShape/CollisionShape3DEnd2").Shape as ConvexPolygonShape3D;
		end1Shape.Points = newPoints[0..8];
		arcSegmentShape.Points = newPoints[4..12];
		end2Shape.Points = newPoints[^8..^0];
	}
}
