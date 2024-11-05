using Godot;

public static class NodeExtensions
{
	public static T GetValidNodeOrNull<T>(this Node node, NodePath path) where T : Node
	{
		T target = node.GetNodeOrNull<T>(path);
		return GodotObject.IsInstanceValid(target) ? target : null;
	}

	public static T GetCachedValidNodeOrNull<T>(this Node node, NodePath path, ref T cachedReference) where T : Node
	{
		return GodotObject.IsInstanceValid(cachedReference) ? cachedReference : GodotObject.IsInstanceValid(cachedReference = node.GetNodeOrNull<T>(path)) ? cachedReference : null;
	}
}
