import os

# These models are being imported directly as Scenes.
# (Importing as Scene allows Godot to generate LODs.)
KEEP = [
    "ConveyorRollerBaseSplit",
    "ConveyorRollerEndSplit",
    "ConveyorRollerRollerSplit",
]

script_dir = os.path.dirname(os.path.abspath(__file__))

def delete_files(extension):
    for root, dirs, files in os.walk(script_dir):
        for file in files:
            if file.endswith(extension):
                file_path = os.path.join(root, file)
                if file.removesuffix(extension) in KEEP:
                    print(f"Skipping {file_path}")
                    continue
                print(f"Deleting {file_path}")
                os.remove(file_path)

delete_files(".glb")
delete_files(".glb.import")

print("Project has been trimmed.")
