# OpenIndustryProject

Free and Open-source warehouse/manufacturing simulator made with [Godot](https://github.com/godotengine), [JoltPhysics](https://github.com/jrouwe/JoltPhysics), [OPC UA .NET](https://github.com/OPCFoundation/UA-.NETStandard), and [libplctag](https://github.com/libplctag/libplctag). 

The goal is to provide an open platform for developers to contribute to the creation of virtual industrial equipment/devices and for people to be able to test their ideas or simply educate themselves while using standard industrial platforms.

Scroll down to the **Getting Started** section for information on how to work with this project. 

Join our discord group: [Open Industry Project](https://discord.gg/ACRPr6sBpH)

Supported Communication Protocols:

- OPC UA 
- Ethernet/IP via libplctag
- Modbus TCP via libplctag

## Demo

This demo is located at: [Demos](https://github.com/Open-Industry-Project/Demos)

https://github.com/Open-Industry-Project/Open-Industry-Project/assets/105675984/695450b7-c98b-4691-b3ce-3f3b2781f127

## Getting Started

**Requirements:** https://dotnet.microsoft.com/en-us/download

**.NET SDK is required for this project for the compilation of C# code**

The contents of this repo are parts of a regular Godot project. You will import this project via the Godot project manager, just like any other Godot project.

If you are familiar with Godot and you open this project, you will notice that some things look different. This is intentional. This project is meant to be entirely contained with in the editor.

At the moment there is no reason to "run" this project as if it were a game like you normally would for development done in Godot. The editor viewport(s) are where all simulations will take place.

If using the Godot fork use the Project Manager to create a new project, otherwise import the project from this repository. 

![image](https://github.com/Open-Industry-Project/Open-Industry-Project/assets/105675984/c38f96b0-b3ac-4f37-93c6-b9fe835bace5)

All objects used in a simulation scene will be in the EquipmentAndDevices folder.

All scenes where simulations will take place require a Main node. **A scene that inherients one is automatically created for new projects**, but the easiest way to setup a new one is to have a new one inherient the Main node.

![image](https://github.com/Open-Industry-Project/Open-Industry-Project/assets/105675984/e12543b5-5ea5-4258-b013-fcabc3cd88c8)

The Main node can be selected in Scene tab.

![image](https://github.com/Open-Industry-Project/Open-Industry-Project/assets/105675984/3198dcb5-9b5d-4966-98c9-618781f576e4)

This will expose it's properties in the Inspector tab. This is where communications will be setup. (This step can be skipped if no external platform will be used) 

![image](https://github.com/Open-Industry-Project/Open-Industry-Project/assets/105675984/9452d3af-bea6-47f1-a30b-d2f546d651ff)

New devices and equipment can be dragged into the viewport to instantiate it. Once they're in the scene they can be modified. 

https://github.com/Open-Industry-Project/Open-Industry-Project/assets/105675984/60091457-30b7-4133-bf9d-8a29b6484c86

If using the latest version of Godot (4.2 stable), it is recommended to toggle off "View Gizmos" when simulating:

![image](https://github.com/Open-Industry-Project/Open-Industry-Project/assets/105675984/ef2f5b0b-d65a-4018-8277-c87a2646a00b)

Equipment and devices have their properties that can be setup to communicate to a PLC or OPC Server. In this example Ignition was used as an OPC server to write to the conveyor tag.

https://github.com/Open-Industry-Project/Open-Industry-Project/assets/105675984/df4de804-87ca-4401-9d33-69bb6def4db3

## Importing Models

Although this project has a few models, you maybe interested in adding more. 

This is a good resource for free industrial parts CAD models: [3dfindit](https://www.3dfindit.com/en/)

It is recommened to export the files in their native format (usually STEP), modify them if needed for usage in Godot in any CAD software and then export as FBX for additional work in Blender, or to be imported straight into Godot. 

Alternatively most manufacturers provide the CAD files directly on their own website. 

## Help Wanted

- More equipment and devices
- Better exception handling
- Review code
- Documentation
- Training videos?


