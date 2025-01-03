using Godot;
using System;
using System.Collections.Generic;
using System.Diagnostics;

[Tool]
public partial class ConveyorAssemblyLegStands : ConveyorAssemblyChild
{
	// Workarounds for renaming class
	private ConveyorAssembly assembly => GetParentOrNull<ConveyorAssembly>();
	private ConveyorAssemblyChild conveyors
	{
		get
		{
			if (IsInstanceValid(_conveyors)) return _conveyors;
			_conveyors = assembly?.GetNodeOrNull<ConveyorAssemblyChild>("Conveyors");
			if (IsInstanceValid(_conveyors))
			{
				_conveyors.TransformChanged += void (_) => LockLegStandsGroup();
				_conveyors.TransformChanged += void (_) => UpdateLegStandCoverage();
				UpdateLegStandCoverage();
			}
			return _conveyors;
		}
	}
	private ConveyorAssemblyChild _conveyors;
	// TODO actually cache
	private Transform3D _cachedConveyorsTransform => conveyors?.Transform ?? Transform3D.Identity;
	private Vector3 _cachedAssemblyScale => assembly?.Scale ?? Vector3.One;

	#region Leg Stands
	#region Leg Stands / Constants
	private const float LegStandsBaseWidth = 2f;
	private const string AUTO_LEG_STAND_NAME_PREFIX = "AutoLegsStand";
	private const string AUTO_LEG_STAND_NAME_FRONT = "AutoLegsStandFront";
	private const string AUTO_LEG_STAND_NAME_REAR = "AutoLegsStandRear";
	private enum LegIndex: int
	{
		Front = -1,
		Rear = -2,
		NonAuto = -3,
	}
	#endregion Leg Stands / Constants

	// Cached Transform properties
	private Transform3D _cachedLegStandsTransform = Transform3D.Identity;
	protected Vector3 _cachedLegStandsPosition = Vector3.Zero;
	private Basis _cachedLegStandsBasis = Basis.Identity;
	private Vector3 _cachedLegStandsRotation = Vector3.Zero;

	// Configuration change detection fields
	private Transform3D assemblyTransformPrev;
	private Transform3D conveyorsTransformPrev;
	private Transform3D legStandsTransformPrev;
	private float targetWidthPrev = float.NaN;
	private float conveyorAnglePrev = 0f;
	private bool autoLegStandsIntervalLegsEnabledPrev = false;
	private float autoLegStandsIntervalLegsIntervalPrev;
	private bool autoLegStandsEndLegFrontPrev = false;
	private bool autoLegStandsEndLegRearPrev = false;
	private float autoLegStandsMarginEndLegsPrev = 0.5f;
	private PackedScene autoLegStandsModelScenePrev;

	public float FloorOffset { get => GetFloorOffset(); set => SetFloorOffset(value); }
	public bool FloorOffsetLock { get; set; } = false;
	public float IntervalLegsOffset { get => GetIntervalLegsOffset(); set => SetIntervalLegsOffset(value); }

	public float GetFloorOffset()
	{
		return ApparentTransform.Origin.Y;
	}

	public void SetFloorOffset(float value)
	{
		var newApparentTransform = ApparentTransform;
		newApparentTransform.Origin.Y = value;
		ApparentTransform = newApparentTransform;
		SetNeedsUpdate(true);
	}

	public void SetFloorOffsetLock(bool value)
	{
		FloorOffsetLock = value;
	}

	public float GetIntervalLegsOffset()
	{
		return ApparentTransform.Origin.X;
	}

	public void SetIntervalLegsOffset(float value)
	{
		var newApparentTransform = ApparentTransform;
		newApparentTransform.Origin.X = value;
		ApparentTransform = newApparentTransform;
		UpdateLegStandCoverage();
	}

	protected bool legStandsPathChanged = true;

	public ConveyorAssemblyLegStands()
	{
		TransformChanged += void (value) => _cachedLegStandsTransform = value;
		PositionChanged += void (value) => _cachedLegStandsPosition = value;
		BasisChanged += void (value) =>
		{
			_cachedLegStandsBasis = value;
			_cachedLegStandsRotation = _cachedLegStandsBasis.GetEuler();
		};
		// Ensure cached values are up to date
		_cachedLegStandsTransform = Transform;
		_cachedLegStandsPosition = _cachedLegStandsTransform.Origin;
		_cachedLegStandsBasis = _cachedLegStandsTransform.Basis;
		_cachedLegStandsRotation = _cachedLegStandsBasis.GetEuler();

		TransformChanged += void (_) => UpdateLegStandCoverage();
		// For UpdateLegStandsHeightAndVisibility
		TransformChanged += void (_) => SetNeedsUpdate(true);
	}

	public override void _Ready()
	{
		assembly.ScaleChanged += void (_) => SetNeedsUpdate(true);
		conveyors.BasisChanged += void (_) => SetNeedsUpdate(true);

		// Apply the AutoLegStandsFloorOffset and AutoLegStandsIntervalLegsOffset properties if needed.
		Basis assemblyScale = Basis.Identity.Scaled(_cachedAssemblyScale);
		Vector3 legStandsStartingOffset = assemblyScale * _cachedLegStandsPosition;

		autoLegStandsIntervalLegsIntervalPrev = assembly.AutoLegStandsIntervalLegsInterval;
		autoLegStandsModelScenePrev = assembly.AutoLegStandsModelScene;

		Node editedScene = GetTree().GetEditedSceneRoot();
		foreach (Node legStand in GetChildren())
		{
			if (legStand.Owner != editedScene)
			{
				foreignLegStandsOwners[legStand.Name] = legStand.Owner;
			}
		}
	}

	public override void _Notification(int what)
	{
		if (what == NotificationParented)
		{
			// Can't use `assembly` because that property will return null if the node doesn't have its script attached yet.
			assemblyTransformPrev = GetParentOrNull<Node3D>().Transform;
		}
		base._Notification(what);
	}

	public override void _PhysicsProcess(double delta)
	{
		UpdateLegStands();
		SetNeedsUpdate(false);
	}

	internal void SetNeedsUpdate(bool value)
	{
		SetPhysicsProcess(value);
	}

	#region Fields / Leg stand coverage
	private float legStandCoverageMin;
	private float legStandCoverageMax;
	private float legStandCoverageMinPrev;
	private float legStandCoverageMaxPrev;
	private bool legStandsCoverageChanged = false;
	#endregion Fields / Leg stand coverage

	// This variable is used to store the names of the pre-existing leg stands that can't be owned by the edited scene.
	private Dictionary <StringName, Node> foreignLegStandsOwners = new();

	#region Leg Stands / Conveyor coverage extents
	public void UpdateLegStandCoverage() {
		// Should be called whenever any dependencies change:
		// - Conveyors reference ceases to be null
		// - Our local transform changes
		// - Conveyors local transform changes
		// - Conveyors children changes (assume this doesn't happen)
		// - Conveyors children's transforms change (assume only changes based on conveyorLineLength)
		// - Relevant auto leg stands config properties change:
		//   - AutoLegStandsMarginEnds
		//   - AutoLegStandsModelGrabsOffset
		(legStandCoverageMin, legStandCoverageMax) = GetLegStandCoverage();
		legStandsCoverageChanged = legStandCoverageMin != legStandCoverageMinPrev
								|| legStandCoverageMax != legStandCoverageMaxPrev;
		if (legStandsCoverageChanged)
		{
			SetNeedsUpdate(true);
		}
	}

	protected virtual (float, float) GetLegStandCoverage() {
		if (conveyors == null) {
			return (0f, 0f);
		}
		float min = float.MaxValue;
		float max = float.MinValue;
		foreach (Node child in conveyors.GetChildren()) {
			Node3D conveyor = child as Node3D;
			if (ConveyorAssembly.IsConveyor(conveyor)) {
				// Conveyor's Transform in the legStands space.
				Transform3D localConveyorTransform = _cachedLegStandsTransform.AffineInverse() * _cachedConveyorsTransform * conveyor.Transform;

				// Extent and offset positions in unscaled conveyor space
				Vector3 conveyorExtentFront = new Vector3(-Mathf.Abs(localConveyorTransform.Basis.Scale.X * 0.5f), 0f, 0f);
				Vector3 conveyorExtentRear = new Vector3(Mathf.Abs(localConveyorTransform.Basis.Scale.X * 0.5f), 0f, 0f);

				Vector3 marginOffsetFront = new Vector3(assembly.AutoLegStandsMarginEnds, 0f, 0f);
				Vector3 marginOffsetRear = new Vector3(-assembly.AutoLegStandsMarginEnds, 0f, 0f);

				// The tip of the leg stand has a rotating grab model that isn't counted towards its height.
				// Because the grab will rotate towards the conveyor, we account for its reach here.
				Vector3 grabOffset = new Vector3(0f, -assembly.AutoLegStandsModelGrabsOffset, 0f);

				// Final grab points in legStands space
				Vector3 legGrabPointFront = localConveyorTransform.Orthonormalized() * (conveyorExtentFront + marginOffsetFront + grabOffset);
				Vector3 legGrabPointRear = localConveyorTransform.Orthonormalized() * (conveyorExtentRear + marginOffsetRear + grabOffset);

				// Update min and max.
				min = Mathf.Min(min, Mathf.Min(legGrabPointRear.X, legGrabPointFront.X));
				max = Mathf.Max(max, Mathf.Max(legGrabPointRear.X, legGrabPointFront.X));
			}
		}
		return (min, max);
	}
	#endregion Leg Stands / Conveyor coverage extents

	#region Leg Stands / Update "LegStands" node
	public override void OnAssemblyTransformChanged()
	{
		Vector3 assemblyTranslation = assembly.Transform.Origin - assemblyTransformPrev.Origin;
		assemblyTransformPrev = assembly.Transform;

		// Disable dynamically adjusting the FloorOffset when the assembly is outside the tree.
		// This covers the case when the assembly is being initialized for the first time.
		// The user wants to drop the assembly at a location with its default height.
		// This is different from placing the assembly at the world origin and dragging it there.
		if (!IsInsideTree() || FloorOffsetLock) return;

		var newTransform = ApparentTransform;
		newTransform.Origin.Y -= assemblyTranslation.Y;
		ApparentTransform = newTransform;
	}

	protected override Transform3D ConstrainApparentTransform(Transform3D apparentTransform)
	{
		return LockLegStandsGroup(apparentTransform);
	}

	private void UpdateLegStands()
	{
		// If the leg stand scene changes, we need to regenerate everything.
		if (assembly.AutoLegStandsModelScene != autoLegStandsModelScenePrev) {
			DeleteAllAutoLegStands();
		}

		// Only bother repositioning leg stands if the user could manually edit them.
		// All the leg stands that we generated should already be in the right spots.
		var editedRoot = GetTree().EditedSceneRoot;
		bool legStandsIsEditable = editedRoot != null && (editedRoot == Owner || editedRoot.IsEditableInstance(Owner));
		if (legStandsIsEditable || legStandsPathChanged)
		{
			SnapAllLegStandsToPath();
		}
		legStandsPathChanged = false;

		float targetWidthNew = GetLegStandTargetWidth();
		bool targetWidthChanged = targetWidthPrev != targetWidthNew;
		targetWidthPrev = targetWidthNew;
		if (legStandsIsEditable || targetWidthChanged)
		{
			UpdateAllLegStandsWidth();
		}

		bool debugInvariants = true;
		float legStandCoverageMinValueForAssertion = 0;
		float legStandCoverageMaxValueForAssertion = 0;
		if (debugInvariants)
		{
			// debug: Prepare to assert that legStandCoverage has not changed in this code block
			legStandCoverageMinValueForAssertion = legStandCoverageMin;
			legStandCoverageMaxValueForAssertion = legStandCoverageMax;
		}

		var autoLegStandsUpdateIsNeeded = assembly.AutoLegStandsIntervalLegsEnabled != autoLegStandsIntervalLegsEnabledPrev
			|| assembly.AutoLegStandsIntervalLegsInterval != autoLegStandsIntervalLegsIntervalPrev
			|| assembly.AutoLegStandsEndLegFront != autoLegStandsEndLegFrontPrev
			|| assembly.AutoLegStandsEndLegRear != autoLegStandsEndLegRearPrev
			|| assembly.AutoLegStandsMarginEndLegs != autoLegStandsMarginEndLegsPrev
			|| assembly.AutoLegStandsModelScene != autoLegStandsModelScenePrev
			|| legStandsCoverageChanged;

		int numberOfLegStandsAdjusted = 0;
		bool didAddOrRemove = false;
		if (autoLegStandsUpdateIsNeeded) {
			//GD.Print("Updating leg stands. Reason: ", AutoLegStandsIntervalLegsEnabled != autoLegStandsIntervalLegsEnabledPrev
			//, AutoLegStandsIntervalLegsInterval != autoLegStandsIntervalLegsIntervalPrev
			//, AutoLegStandsEndLegFront != autoLegStandsEndLegFrontPrev
			//, AutoLegStandsEndLegRear != autoLegStandsEndLegRearPrev
			//, AutoLegStandsMarginEndLegs != autoLegStandsMarginEndLegsPrev
			//, AutoLegStandsModelScene != autoLegStandsModelScenePrev
			//, legStandCoverageMin != legStandCoverageMinPrev
			//, legStandCoverageMax != legStandCoverageMaxPrev);
			numberOfLegStandsAdjusted = AdjustAutoLegStandPositions();
			didAddOrRemove = CreateAndRemoveAutoLegStands();
		}

		// Dependencies
		bool legStandsChildrenChanged = numberOfLegStandsAdjusted != 0 || didAddOrRemove;
		// Actually, it's the relative transform of LegStands and Conveyors that we need to monitor,
		// specifically the conveyorPlane in UpdateLegStandsHeightAndVisibility,
		// but the individual Transforms are good enough for now, though overkill.
		bool conveyorsTransformChanged = _cachedConveyorsTransform != conveyorsTransformPrev;
		bool legStandsTransformChanged = _cachedLegStandsTransform != legStandsTransformPrev;
		if (legStandsChildrenChanged || conveyorsTransformChanged || legStandsTransformChanged || legStandsCoverageChanged)
		{
			UpdateLegStandsHeightAndVisibility();
		}

		// Record external state to detect any changes next run.
		conveyorsTransformPrev = _cachedConveyorsTransform;
		legStandsTransformPrev = _cachedLegStandsTransform;
		autoLegStandsIntervalLegsEnabledPrev = assembly.AutoLegStandsIntervalLegsEnabled;
		autoLegStandsEndLegFrontPrev = assembly.AutoLegStandsEndLegFront;
		autoLegStandsEndLegRearPrev = assembly.AutoLegStandsEndLegRear;
		autoLegStandsMarginEndLegsPrev = assembly.AutoLegStandsMarginEndLegs;
		autoLegStandsModelScenePrev = assembly.AutoLegStandsModelScene;
		(legStandCoverageMinPrev, legStandCoverageMaxPrev) = (legStandCoverageMin, legStandCoverageMax);

		if (debugInvariants)
		{
			System.Diagnostics.Debug.Assert(legStandCoverageMin == legStandCoverageMinValueForAssertion, "Unexpected change detected: legStandCoverateMin");
			System.Diagnostics.Debug.Assert(legStandCoverageMax == legStandCoverageMaxValueForAssertion, "Unexpected change detected: legStandCoverateMax");
		}
	}

	private void LockLegStandsGroup() {
		var newTransform = LockLegStandsGroup(Transform);
		if (Transform == newTransform) return;
		ApparentTransform = newTransform;
	}

	protected virtual Transform3D LockLegStandsGroup(Transform3D apparentTransform) {
		// Always align LegStands group with Conveyors group.
		if (conveyors == null) return apparentTransform;
		var position = new Vector3(apparentTransform.Origin.X, apparentTransform.Origin.Y, conveyors.ApparentTransform.Origin.Z);
		// Conveyors can't rotate anymore, so this doesn't do much.
		var rotation = new Vector3(0f, conveyors.ApparentTransform.Basis.GetEuler().Y, 0f);
		// Lock Scale to 1, 1, 1
		var basis = Basis.FromEuler(rotation);
		return new Transform3D(basis, position);
	}

	private void DeleteAllAutoLegStands() {
		foreach (Node child in GetChildren()) {
			if (IsAutoLegStand(child)) {
				RemoveChild(child);
				child.QueueFree();
			}
		}
	}

	private bool IsAutoLegStand(Node node) {
		return GetAutoLegStandIndex(node.Name) != (int) LegIndex.NonAuto;
	}
	#endregion Leg Stands / Update "LegStands" node

	#region Leg Stands / Basic constraints
	private void SnapAllLegStandsToPath() {
		// Force legStand alignment with LegStands group.
		foreach (Node child in GetChildren()) {
			ConveyorLeg legStand = child as ConveyorLeg;
			if (legStand == null) {
				continue;
			}
			SnapToLegStandsPath(legStand);
		}
	}

	private void UpdateAllLegStandsWidth() {
		foreach (Node child in GetChildren()) {
			ConveyorLeg legStand = child as ConveyorLeg;
			if (legStand == null) {
				continue;
			}
			UpdateLegStandWidth(legStand);
		}
	}

	private void UpdateLegStandWidth(Node3D legStand)
	{
		float targetWidth = GetLegStandTargetWidth();
		legStand.Scale = new Vector3(1f, legStand.Scale.Y, targetWidth / LegStandsBaseWidth);
	}

	private float GetLegStandTargetWidth() {
		Node3D firstConveyor = null;
		foreach (Node child in conveyors.GetChildren()) {
			Node3D conveyor = child as Node3D;
			if (ConveyorAssembly.IsConveyor(conveyor)) {
				firstConveyor = conveyor;
				break;
			}
		}
		// This is a hack to account for the fact that CurvedRollerConveyors are slightly wider than other conveyors.
		if (firstConveyor is CurvedRollerConveyor) {
			return assembly.Width * 1.055f;
		}
		if (firstConveyor is RollerConveyor) {
			return assembly.Width + 0.051f * 2f;
		}
		return assembly.Width;
	}

	/**
	 * Snap a child leg stand to a position on the leg stands path.
	 *
	 * The leg stands path is a surface parallel to `legStands` Y axis.
	 * It represents any position that the conveyor line would be directly above or below at some length.
	 * For straight assemblies, this is `legStands` XY plane.
	 * For curved assemblies, this is overridden to be a cylinder centered on `legStands`.
	 *
	 * @param legStand The leg stand to reposition.
	 */
	private void SnapToLegStandsPath(Node3D legStand) {
		MoveLegStandToPathPosition(legStand, GetPositionOnLegStandsPath(legStand.Position));
	}

	/**
	 * Get the path position of a point projected onto the leg stands path.
	 *
	 * The path position is a linear representation of where a point is on the leg stands path.
	 * For straight assemblies, this is the X coordinate of the point.
	 * For curved assemblies, this is an angle of the point around the leg stands Y axis in degrees.
	 *
	 * @param position The point to project onto the leg stands path.
	 * @return The point's path position.
	 */
	protected virtual float GetPositionOnLegStandsPath(Vector3 position) {
		return position.X;
	}

	/**
	 * Move a leg stand to a given position on the leg stands path.
	 *
	 * The leg stand is moved and rotated to align with the path.
	 * The leg stand keeps its Y position and Z rotation.
	 * Curved assemblies override this and don't keep the Z rotation.
	 *
	 * @param legStand The leg stand to move.
	 * @param position The path position to move the leg stand to.
	 */
	protected virtual bool MoveLegStandToPathPosition(Node3D legStand, float pathPosition)
	{
		bool changed = false;
		Vector3 newPosition = new Vector3(pathPosition, legStand.Position.Y, 0f);
		if (legStand.Position != newPosition)
		{
			legStand.Position = newPosition;
			changed = true;
		}
		Vector3 newRotation = new Vector3(0f, 0f, legStand.Rotation.Z);
		if (legStand.Rotation != newRotation)
		{
			legStand.Rotation = newRotation;
			changed = true;
		}
		return changed;
	}
	#endregion Leg Stands / Basic constraints

	#region Leg Stands / Managing auto-instanced leg stands
	/**
	 * Adjust the positions of all auto-instanced leg stands to match changed settings or coverage.
	 */
	private int AdjustAutoLegStandPositions() {
		// Don't allow tiny or negative intervals.
		assembly.AutoLegStandsIntervalLegsInterval = Mathf.Max(0.5f, assembly.AutoLegStandsIntervalLegsInterval);
		if (assembly.AutoLegStandsIntervalLegsInterval == autoLegStandsIntervalLegsIntervalPrev && legStandCoverageMax == legStandCoverageMaxPrev && legStandCoverageMin == legStandCoverageMinPrev) {
			return 0;
		}
		var changeCount = 0;
		foreach (Node child in GetChildren()) {
			if (child is not ConveyorLeg legStand) {
				continue;
			}
			int legStandIndex = GetAutoLegStandIndex(legStand.Name);
			switch (legStandIndex) {
				case (int) LegIndex.NonAuto:
					// Only adjust auto leg stands.
					break;
				default:
					// Update leg stand position to the new interval.
					if (MoveLegStandToPathPosition(legStand, GetAutoLegStandPosition(legStandIndex)))
					{
						changeCount++;
					}
					break;
			}
		}
		autoLegStandsIntervalLegsIntervalPrev = assembly.AutoLegStandsIntervalLegsInterval;
		return changeCount;
	}

	private int GetAutoLegStandIndex(StringName name) {
		if (name.Equals(new StringName(AUTO_LEG_STAND_NAME_FRONT))) {
			return (int) LegIndex.Front;
		}
		if (name.Equals(new StringName(AUTO_LEG_STAND_NAME_REAR))) {
			return (int) LegIndex.Rear;
		}
		if (name.ToString().StartsWith(AUTO_LEG_STAND_NAME_PREFIX) &&
			int.TryParse(name.ToString().AsSpan(AUTO_LEG_STAND_NAME_PREFIX.Length), out int legStandIndex)) {
			// Names start at 1, but indices start at 0.
			return legStandIndex - 1;
		}
		return (int) LegIndex.NonAuto;
	}

	/**
	 * Get the correct path position of an auto-instanced leg stand.
	 *
	 * If the index is high, it's possible that the position will be outside the coverage range.
	 *
	 * @param index The index of an interval aligned leg stand or LegIndex.Front or LegIndex.Rear for fixed legs.
	 */
	private float GetAutoLegStandPosition(int index) {
		if (index == (int) LegIndex.Front) {
			return legStandCoverageMin;
		}
		if (index == (int) LegIndex.Rear) {
			return legStandCoverageMax;
		}
		return GetIntervalLegStandPosition(index);
	}


	/**
	 * Get the correct path position of an interval aligned leg stand.
	 *
	 * If the index is high, it's possible that the position will be outside the coverage range.
	 *
	 * @param index The index of the leg stand, starting with the first covered one.
	 */
	private float GetIntervalLegStandPosition(int index) {
		Debug.Assert(index >= 0);
		float frontMargin = assembly.AutoLegStandsEndLegFront ? assembly.AutoLegStandsMarginEndLegs : 0f;
		float firstPosition = (float) Math.Ceiling((legStandCoverageMin + frontMargin) / assembly.AutoLegStandsIntervalLegsInterval) * assembly.AutoLegStandsIntervalLegsInterval;
		return firstPosition + index * assembly.AutoLegStandsIntervalLegsInterval;
	}

	private bool CreateAndRemoveAutoLegStands()
	{
		bool changed = false;
		// Don't allow negative margins.
		assembly.AutoLegStandsMarginEndLegs = Mathf.Max(0f, assembly.AutoLegStandsMarginEndLegs);
		// Enforce a margin from fixed front and rear legs if they exist.
		float firstPosition = GetIntervalLegStandPosition(0);
		float rearMargin = assembly.AutoLegStandsEndLegRear ? assembly.AutoLegStandsMarginEndLegs : 0f;
		float lastPosition = (float) Math.Floor((legStandCoverageMax - rearMargin) / assembly.AutoLegStandsIntervalLegsInterval) * assembly.AutoLegStandsIntervalLegsInterval;
		int intervalLegStandCount;
		if (!assembly.AutoLegStandsIntervalLegsEnabled) {
			intervalLegStandCount = 0;
		} else if (firstPosition > lastPosition) {
			// Invalid range implies zero interval-aligned leg stands are needed.
			intervalLegStandCount = 0;
		} else {
			intervalLegStandCount = (int) ((lastPosition - firstPosition) / assembly.AutoLegStandsIntervalLegsInterval) + 1;
		}
		// Inventory our existing leg stands and delete the ones we don't need.
		bool hasFrontLeg = false;
		bool hasRearLeg = false;
		bool[] legStandsInventory = new bool[intervalLegStandCount];
		foreach (Node child in GetChildren()) {
			if (child is not ConveyorLeg legStand) {
				continue;
			}
			int legStandIndex = GetAutoLegStandIndex(legStand.Name);
			switch ((LegIndex) legStandIndex) {
				case LegIndex.NonAuto:
					// Only manage auto leg stands.
					break;
				case LegIndex.Front:
					if (assembly.AutoLegStandsEndLegFront) {
						hasFrontLeg = true;
					} else {
						RemoveChild(legStand);
						legStand.QueueFree();
					}
					break;
				case LegIndex.Rear:
					if (assembly.AutoLegStandsEndLegRear) {
						hasRearLeg = true;
					} else {
						RemoveChild(legStand);
						legStand.QueueFree();
					}
					break;
				default:
					// Mark existing leg stands that are in the new interval.
					if (legStandIndex < intervalLegStandCount && assembly.AutoLegStandsIntervalLegsEnabled) {
						legStandsInventory[legStandIndex] = true;
						break;
					}
					// Delete leg stands that are outside the new interval.
					RemoveChild(legStand);
					legStand.QueueFree();
					changed = true;
					break;
			}
		}

		// Create the missing leg stands.
		if (assembly.AutoLegStandsModelScene == null) {
			return changed;
		}
		if (!hasFrontLeg && assembly.AutoLegStandsEndLegFront) {
			AddLegStandAtIndex((int) LegIndex.Front);
			changed = true;
		}
		for (int i = 0; i < intervalLegStandCount; i++) {
			if (!legStandsInventory[i]) {
				AddLegStandAtIndex(i);
				changed = true;
			}
		}
		if (!hasRearLeg && assembly.AutoLegStandsEndLegRear) {
			AddLegStandAtIndex((int) LegIndex.Rear);
			changed = true;
		}
		return changed;
	}

	private ConveyorLeg AddLegStandAtIndex(int index) {
		float position = GetAutoLegStandPosition(index);
		StringName name = (LegIndex) index switch
		{
			LegIndex.Front => (StringName)AUTO_LEG_STAND_NAME_FRONT,
			LegIndex.Rear => (StringName)AUTO_LEG_STAND_NAME_REAR,
			// Indices start at 0, but names start at 1.
			_ => (StringName)(AUTO_LEG_STAND_NAME_PREFIX + (index + 1).ToString()),
		};
		ConveyorLeg legStand = AddOrGetLegStandInstance(name) as ConveyorLeg;
		MoveLegStandToPathPosition(legStand, position);
		UpdateLegStandWidth(legStand);

		// It probably doesn't matter, but let's try to keep leg stands in order.
		int trueIndex = (LegIndex) index switch {
			LegIndex.Front => 0,
			LegIndex.Rear => -1,
			_ => assembly.AutoLegStandsEndLegFront ? index + 1 : index,
		};
		if (trueIndex < GetChildCount()) {
			MoveChild(legStand, trueIndex);
		}
		return legStand;
	}

	private Node AddOrGetLegStandInstance(StringName name) {
		Node legStand = GetNodeOrNull<Node>(new NodePath(name));
		if (legStand != null) {
			return legStand;
		}
		legStand = assembly.AutoLegStandsModelScene.Instantiate();
		legStand.Name = name;
		AddChild(legStand);
		// If the leg stand used to exist, restore its original owner.
		legStand.Owner = foreignLegStandsOwners.TryGetValue(name, out Node originalOwner)
			? originalOwner
			: GetTree().GetEditedSceneRoot();
		return legStand;
	}
	#endregion Leg Stands / Managing auto-instanced leg stands

	#region Leg Stands / Auto-height and visibility
	internal void UpdateLegStandsHeightAndVisibility() {
		// Extend LegStands to Conveyor line.

		// Dependencies:
		// - AutoLegStandsModelGrabsOffset (calls us by setter)
		// - conveyors.Transform
		// - legStands.Basis
		// - legStandCoverageMin
		// - legStandCoverageMax
		// - children of legStands
		//   - (Additions)
		//   - Transform
		// Effects:
		// - children of legStands
		//   - Scale
		//   - Visible
		//   - GrabsRotation
		if (conveyors == null)
		{
			return;
		}
		// Plane transformed from conveyors space into legStands space.
		Plane conveyorPlane = new Plane(Vector3.Up, new Vector3(0f, -assembly.AutoLegStandsModelGrabsOffset, 0f)) * _cachedConveyorsTransform.AffineInverse() * _cachedLegStandsTransform;

		foreach (Node child in GetChildren()) {
			ConveyorLeg legStand = child as ConveyorLeg;
			if (legStand == null) {
				continue;
			}
			UpdateIndividiualLegStandHeightAndVisibility(legStand, conveyorPlane);
		}
	}

	void UpdateIndividiualLegStandHeightAndVisibility(ConveyorLeg legStand, Plane conveyorPlane)
	{
		// Raycast from the minimum-height tip of the leg stand to the conveyor plane.
		Vector3? intersection = conveyorPlane.IntersectsRay(legStand.Position + legStand.Basis.Y.Normalized(), legStand.Basis.Y.Normalized());
		if (intersection == null) {
			legStand.Visible = false;
			// Set scale to minimum height.
			legStand.Scale = new Vector3(1f, 1f, legStand.Scale.Z);
			return;
		}
		float legHeight = intersection.Value.DistanceTo(legStand.Position);
		legStand.Scale = new Vector3(1f, legHeight, legStand.Scale.Z);
		legStand.GrabsRotation = Mathf.RadToDeg(legStand.Basis.Y.SignedAngleTo(conveyorPlane.Normal.Slide(legStand.Basis.Z), legStand.Basis.Z));
		// Only show leg stands that touch a conveyor.
		float tipPosition = GetPositionOnLegStandsPath(legStand.Position + legStand.Basis.Y);
		legStand.Visible = legStandCoverageMin <= tipPosition && tipPosition <= legStandCoverageMax;
	}
	#endregion Leg Stands / Auto-height and visibility
	#endregion Leg Stands
}
