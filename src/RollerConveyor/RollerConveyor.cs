using Godot;
using System;
using System.Threading.Tasks;

[Tool]
public partial class RollerConveyor : Node3D, IRollerConveyor
{
	private bool enableComms;

	[Signal]
	public delegate void WidthChangedEventHandler(float width);
	[Signal]
	public delegate void LengthChangedEventHandler(float length);
	[Signal]
	public delegate void ScaleChangedEventHandler(Vector3 scale);
	[Signal]
	public delegate void RollerSkewAngleChangedEventHandler(float skewAngleDegrees);
	[Signal]
	public delegate void SetSpeedEventHandler(float speed);
	[Signal]
	public delegate void RollerOverrideMaterialChangedEventHandler(Material material);

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
	public float Speed { get => _speed; set => SetRollersSpeed(value); }
	private float _speed = 2.0f;

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
			bool changed = skewAngle != value;
			skewAngle = value;
			if (changed) {
				EmitSignal(SignalName.RollerSkewAngleChanged, skewAngle);
			}
		}
	}

	float nodeScaleX = 1.0f;
	float nodeScaleZ = 1.0f;
	Vector3 lastScale = Vector3.One;
	float lastLength = 1f;
	float lastWidth = float.NaN;
	Transform3D previousTransform = Transform3D.Identity;

	const float radius = 0.12f;
	const float circumference = 2f * MathF.PI * radius;
	const float baseWidth = 1f;
	const float frameBaseWidth = 2f;

	Material metalMaterial;
	Rollers rollers;
	Node3D ends;

	readonly Guid id = Guid.NewGuid();
	double scan_interval = 0;
	bool running = false;
	bool readSuccessful = false;

	Root main;

	public BaseMaterial3D rollerMaterial;
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

	public RollerConveyor()
	{
		SetNotifyLocalTransform(true);
	}

	public override void _ValidateProperty(Godot.Collections.Dictionary property)
	{
		string propertyName = property["name"].AsStringName();

		if (propertyName == PropertyName.updateRate || propertyName == PropertyName.tag)
		{
			property["usage"] = (int)(EnableComms ? PropertyUsageFlags.Default : PropertyUsageFlags.NoEditor);
		}
	}

	public override void _EnterTree()
	{
		Main = GetParent().GetTree().EditedSceneRoot as Root;

		if (Main != null)
		{
			Main.SimulationStarted += OnSimulationStarted;
			Main.SimulationEnded += OnSimulationEnded;

			running = Main.simulationRunning;
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

	public override void _Ready()
	{
		var meshInstance1 = GetNode<MeshInstance3D>("ConvRoller/ConvRollerL");
		var meshInstance2 = GetNode<MeshInstance3D>("ConvRoller/ConvRollerR");
		meshInstance1.Mesh = meshInstance1.Mesh.Duplicate() as Mesh;
		metalMaterial = meshInstance1.Mesh.SurfaceGetMaterial(0).Duplicate() as Material;
		meshInstance1.Mesh.SurfaceSetMaterial(0, metalMaterial);
		meshInstance2.Mesh.SurfaceSetMaterial(0, metalMaterial);
		UpdateMetalMaterialScale();
	}

	public override void _PhysicsProcess(double delta)
	{
		if (running)
		{
			if (!Main.simulationPaused)
				rollerMaterial.Uv1Offset += new Vector3(4f * Speed / circumference * (float)delta, 0, 0);

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
			//bool transformActuallyChanged = ConstrainTransform();
			//if (!transformActuallyChanged) return;
			if (!IsTransformValid())
			{
				CallDeferred(MethodName.ConstrainTransform);
				return;
			}
			UpdateScale();
			UpdateWidth();
			UpdateLength();
			UpdateSize();
		}
		if (what == NotificationSceneInstantiated)
		{
			OnSceneInstantiated();
		}
	}

	void OnSceneInstantiated()
	{
		SetRollerOverrideMaterial((StandardMaterial3D)GD.Load("res://assets/3DModels/Materials/Metall2.tres").Duplicate(true));

		rollers = GetNodeOrNull<Rollers>("Rollers");
		ends = GetNodeOrNull<Node3D>("Ends");

		SetupRollerContainer(rollers);
		foreach (RollerConveyorEnd end in ends.GetChildren())
		{
			SetupRollerContainer(end);
		}

		// In case transform was changed before scene was instantiated somehow.
		UpdateScale();
		UpdateWidth();
		UpdateLength();
		UpdateSize();
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

	private void SetupRollerContainer(AbstractRollerContainer rollers) {
		rollers.RollerAdded += OnRollerAdded;
		rollers.RollerRemoved += OnRollerRemoved;

		RollerSkewAngleChanged += rollers.SetRollerSkewAngle;
		ScaleChanged += rollers.OnOwnerScaleChanged;
		WidthChanged += rollers.SetWidth;
		LengthChanged += rollers.SetLength;

		rollers.SetupExistingRollers();

		rollers.SetRollerSkewAngle(skewAngle);
		rollers.OnOwnerScaleChanged(Scale);
		rollers.SetWidth(Scale.Z * baseWidth);
		rollers.SetLength(Scale.X);
	}

	private void DisconnectRollerContainer(AbstractRollerContainer rollers) {
		rollers.RollerAdded -= OnRollerAdded;
		rollers.RollerRemoved -= OnRollerRemoved;

		RollerSkewAngleChanged -= rollers.SetRollerSkewAngle;
		ScaleChanged -= rollers.OnOwnerScaleChanged;
		WidthChanged -= rollers.SetWidth;
		LengthChanged -= rollers.SetLength;
	}

	private void OnRollerAdded(Roller roller)
	{
		SetSpeed += roller.SetSpeed;
		RollerOverrideMaterialChanged += roller.SetRollerOverrideMaterial;

		roller.SetSpeed(Speed);
		roller.SetRollerOverrideMaterial(rollerMaterial);
	}

	private void OnRollerRemoved(Roller roller)
	{
		SetSpeed -= roller.SetSpeed;
		RollerOverrideMaterialChanged -= roller.SetRollerOverrideMaterial;
	}

	private void ConstrainTransform()
	{
		Transform3D currentTransform = Transform;
		if (currentTransform != previousTransform) {
			Basis newBasis;
			// Ensure we're working with positive basis vectors.
			// Fall back to the previous basis if necessary.
			( float ScaleX, float ScaleY, float ScaleZ ) = currentTransform.Basis.Scale;
			if (ScaleX <= 0 || ScaleY <= 0 || ScaleZ <= 0)
			{
				newBasis = previousTransform.Basis;
			} else {
				newBasis = currentTransform.Basis;
			}
			newBasis.X = Mathf.Max(1.0f, Mathf.Abs(ScaleX)) * newBasis.X.Normalized();
			newBasis.Y = newBasis.Y.Normalized();
			newBasis.Z = Mathf.Max(0.1f, Mathf.Abs(ScaleZ)) * newBasis.Z.Normalized();
			Transform = new Transform3D(newBasis, currentTransform.Origin);
		}
		previousTransform = Transform;
	}

	private bool IsTransformValid()
	{
		return Scale.X >= 1.0f && Scale.Y == 1.0f && Scale.Z >= 0.1f;
	}

	private void UpdateScale()
	{
		if (lastScale != Scale)
		{
			EmitSignal(SignalName.ScaleChanged, Scale);
			lastScale = Scale;

			Node3D simpleConveyorShapeBody = GetNode<Node3D>("SimpleConveyorShape");
			simpleConveyorShapeBody.Scale = Scale.Inverse();

			UpdateMetalMaterialScale();
		}
	}

	private void UpdateWidth()
	{
		float newWidth = Scale.Z * baseWidth;
		if (lastWidth != newWidth)
		{
			UpdateSidesMeshScale(newWidth);
			EmitSignal(SignalName.WidthChanged, newWidth);
			lastWidth = newWidth;
		}
	}

	private void UpdateLength()
	{
		// Note: This length measurement doesn't include the extra 0.5m from Ends.
		float newLength = Scale.X;
		if (lastLength != newLength)
		{
			EmitSignal(SignalName.LengthChanged, newLength);
			lastLength = newLength;
		}
	}

	private void UpdateSize()
	{
		// Note: This length measurement includes the extra 0.5m from Ends.
		CollisionShape3D simpleConveyorShapeNode = GetNode<CollisionShape3D>("SimpleConveyorShape/CollisionShape3D");
		BoxShape3D simpleConveyorShape = simpleConveyorShapeNode.Shape as BoxShape3D;
		simpleConveyorShape.Size = GetSize();
	}

	private void SetRollersSpeed(float speed)
	{
		if (speed == prevSpeed) return;
		_speed = speed;
		EmitSignal(SignalName.SetSpeed, speed);
	}

	private void SetRollerOverrideMaterial(BaseMaterial3D material)
	{
		bool changed = rollerMaterial != material;
		rollerMaterial = material;
		if (changed)
		{
			EmitSignal(SignalName.RollerOverrideMaterialChanged, rollerMaterial);
		}
	}

	private void UpdateSidesMeshScale(float width)
	{
		// TODO does this need a unique? Might already be done in the inspector.
		var meshInstance1 = GetNode<Node3D>("ConvRoller/ConvRollerL");
		var meshInstance2 = GetNode<Node3D>("ConvRoller/ConvRollerR");
		meshInstance1.Scale = new Vector3(1f, 1f, frameBaseWidth * baseWidth / width);
		meshInstance2.Scale = new Vector3(1f, 1f, frameBaseWidth * baseWidth / width);
	}

	public Vector3 GetSize()
	{
		var length = Scale.X + 0.5f;
		var width = Scale.Z;
		var height = 0.24f;
		return new Vector3(length, height, width);
	}

	public void SetSize(Vector3 value)
	{
		Scale = new Vector3(value.X - 0.5f, 1f, value.Z);
		// NotificationLocalTransformChanged takes care of the rest.
	}

	private void UpdateMetalMaterialScale()
	{
		((ShaderMaterial)metalMaterial)?.SetShaderParameter("Scale", Scale.X);
	}
}
