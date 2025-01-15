using Godot;

[Tool]
public partial class SideGuardCBC : MeshInstance3D
{
	MeshInstance3D meshInstance;
	ShaderMaterial shaderMaterial;

	public override void _Ready()
	{
		meshInstance = this;
		meshInstance.Mesh = meshInstance.Mesh.Duplicate() as Mesh;
		shaderMaterial = meshInstance.Mesh.SurfaceGetMaterial(0).Duplicate() as ShaderMaterial;
		meshInstance.Mesh.SurfaceSetMaterial(0, shaderMaterial);
		OnScaleChanged();
	}

	public SideGuardCBC()
	{
		SetNotifyLocalTransform(true);
	}

	public override void _Notification(int what)
	{
		if (what == NotificationLocalTransformChanged)
		{
			OnScaleChanged();
		}
		base._Notification(what);
	}

	private void OnScaleChanged()
	{
		var newScale = new Vector3(Scale.X, 1, Scale.X);
		if (Scale != newScale)
		{
			SetNotifyLocalTransform(false);
			Scale = newScale;
			SetNotifyLocalTransform(true);
		}
		if (Scale.X > 0.5f)
		{
			if (shaderMaterial != null)
				shaderMaterial.SetShaderParameter("Scale", Scale.X);
		}
	}
}
