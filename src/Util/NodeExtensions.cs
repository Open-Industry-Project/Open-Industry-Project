using Godot;

public static class NodeExtensions
{
	public static T GetValidNodeOrNull<T>(this Node node, NodePath path) where T : Node
	{
		T target = node.GetNodeOrNull<T>(path);
		return GodotObject.IsInstanceValid(target) ? target : null;
	}

	public static void CacheValidNodeOrNull<T>(this Node node, NodePath path, ref T cachedReference) where T : Node
	{
		if (GodotObject.IsInstanceValid(cachedReference)) return;
		cachedReference = node.GetValidNodeOrNull<T>(path);
	}

	public static T GetCachedValidNodeOrNull<T>(this Node node, NodePath path, ref T cachedReference) where T : Node
	{
		CacheValidNodeOrNull(node, path, ref cachedReference);
		return cachedReference;
	}
}
