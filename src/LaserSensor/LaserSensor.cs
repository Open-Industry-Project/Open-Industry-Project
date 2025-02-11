using Godot;
using System;
using System.Threading.Tasks;

[Tool]
public partial class LaserSensor : Node3D
{
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
	string tag;
	[Export]
	private int updateRate = 100;
	[Export]
	float maxRange = 10.0f;
	int value = 0;

	bool debugBeam = true;

	[Export]
	bool ShowBeam
	{
		get
		{
			return debugBeam;
		}
		set
		{
			debugBeam = value;
			NotifyPropertyListChanged();
			if (rayMarker != null)
				rayMarker.Visible = value;
		}
	}

	[Export]
	Color beamBlockedColor;
	[Export]
	Color beamScanColor;

	readonly Guid id = Guid.NewGuid();
	double scan_interval = 0;
	bool readSuccessful = false;
	bool running = false;

	[Export]
	float distance = 0.0f;

	Marker3D rayMarker;
	MeshInstance3D rayMesh;
	CylinderMesh cylinderMesh;
	StandardMaterial3D rayMaterial;

	Root Main;
	public override void _ValidateProperty(Godot.Collections.Dictionary property)
	{
		string propertyName = property["name"].AsStringName();

		if (propertyName == PropertyName.updateRate || propertyName == PropertyName.tag)
		{
			property["usage"] = (int)(EnableComms ? PropertyUsageFlags.Default : PropertyUsageFlags.NoEditor);
		}
		else if(propertyName == PropertyName.beamBlockedColor || propertyName == PropertyName.beamScanColor)
		{
			property["usage"] = (int)(ShowBeam ? PropertyUsageFlags.Default : PropertyUsageFlags.NoEditor);
		}
		else if(propertyName == PropertyName.distance)
		{
			property["usage"] = (int)(PropertyUsageFlags.Default | PropertyUsageFlags.ReadOnly);
		}
	}
	public override void _Ready()
	{
		rayMarker = GetNode<Marker3D>("RayMarker");
		rayMesh = GetNode<MeshInstance3D>("RayMarker/MeshInstance3D");
		cylinderMesh = rayMesh.Mesh.Duplicate() as CylinderMesh;
		rayMesh.Mesh = cylinderMesh;
		rayMaterial = cylinderMesh.Material.Duplicate() as StandardMaterial3D;
		cylinderMesh.Material = rayMaterial;
		rayMarker.Visible = debugBeam;
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

	public override void _PhysicsProcess(double delta)
	{
		PhysicsDirectSpaceState3D spaceState = GetWorld3D().DirectSpaceState;
		PhysicsRayQueryParameters3D query = PhysicsRayQueryParameters3D.Create(rayMarker.GlobalPosition, rayMarker.GlobalPosition + GlobalTransform.Basis.Z * maxRange);
		var result = spaceState.IntersectRay(query);

		if (result.Count > 0)
		{
			cylinderMesh.Height = rayMarker.GlobalPosition.DistanceTo((Vector3)result["position"]);
			rayMaterial.AlbedoColor = beamBlockedColor;
			distance = cylinderMesh.Height;
		}
		else
		{
			cylinderMesh.Height = maxRange;
			rayMaterial.AlbedoColor = beamScanColor;
			distance = maxRange;
		}
		rayMesh.Position = new Vector3(0, 0, cylinderMesh.Height * 0.5f);

		if (enableComms && running && readSuccessful)
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
			readSuccessful = Main.Connect(id, Root.DataType.Float, Name, tag);
		}
	}

	void OnSimulationEnded()
	{
		running = false;
		cylinderMesh.Height = maxRange;
		rayMaterial.AlbedoColor = beamScanColor;
		rayMesh.Position = new Vector3(0, 0, cylinderMesh.Height * 0.5f);
	}

	async void ScanTag()
	{
		try
		{
			await Main.Write(id, distance);
		}
		catch
		{
			GD.PrintErr("Failure to write: " + tag + " in Node: " + Name);
		}
	}
}
