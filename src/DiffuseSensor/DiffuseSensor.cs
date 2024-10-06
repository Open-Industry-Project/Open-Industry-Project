using Godot;
using System;
using System.Threading.Tasks;

[Tool]
public partial class DiffuseSensor : Node3D
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
	float maxRange = 6.0f;

	readonly Guid id = Guid.NewGuid();
	double scan_interval = 0;
	bool readSuccessful = false;
	bool running = false;

	bool showBeam = true;
	[Export]
	bool ShowBeam
	{
		get
		{
			return showBeam;
		}
		set
		{
			showBeam = value;
			NotifyPropertyListChanged();
			if (rayMarker != null)
				rayMarker.Visible = value;
		}
	}
	
	[Export]
	Color beamBlockedColor;
	[Export]
	Color beamScanColor;

	[Export]
	bool blocked = false;

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
		else if (propertyName == PropertyName.beamBlockedColor || propertyName == PropertyName.beamScanColor)
		{
			property["usage"] = (int)(ShowBeam ? PropertyUsageFlags.Default : PropertyUsageFlags.NoEditor);
		}
		else if (propertyName == PropertyName.blocked)
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
		rayMarker.Visible = showBeam;
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
		query.CollisionMask = 8;
		var result = spaceState.IntersectRay(query);
		
		if (result.Count > 0)
		{
			blocked = true;
			float resultDistance = rayMarker.GlobalPosition.DistanceTo((Vector3)result["position"]);
			if (cylinderMesh.Height != resultDistance)
				cylinderMesh.Height = resultDistance;
			if (rayMaterial.AlbedoColor != beamBlockedColor)
				rayMaterial.AlbedoColor = beamBlockedColor;
		}
		else
		{
			blocked = false;
			if (cylinderMesh.Height != maxRange)
				cylinderMesh.Height = maxRange;
			if (rayMaterial.AlbedoColor != beamScanColor)
				rayMaterial.AlbedoColor = beamScanColor;
		}

		if (enableComms && running && readSuccessful)
		{
			scan_interval += delta;
			if (scan_interval > (float)updateRate / 1000 && readSuccessful)
			{
				scan_interval = 0;
				Task.Run(ScanTag);
			}
		}


		rayMesh.Position = new Vector3(0, 0, cylinderMesh.Height * 0.5f);
	}
	
	void OnSimulationStarted()
	{
		running = true;
		if (enableComms)
		{
			readSuccessful = Main.Connect(id, Root.DataType.Bool, Name, tag);
		}
	}
	
	void OnSimulationEnded()
	{
		running = false;
		cylinderMesh.Height = maxRange;
		rayMaterial.AlbedoColor = beamScanColor;
		rayMesh.Position = new Vector3(0, 0, cylinderMesh.Height * 0.5f);
	}

	async Task ScanTag()
	{
		try
		{
			await Main.Write(id, blocked);
		}
		catch
		{
			GD.PrintErr("Failure to write: " + tag + " in Node: " + Name);
		}
	}
}
