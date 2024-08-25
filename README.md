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


https://github.com/Open-Industry-Project/Open-Industry-Project/assets/105675984/e78c3b0a-bb8e-411a-aa17-b2b6534868a4


## Out of the Box Features 

Customizable Equipment

https://github.com/user-attachments/assets/0d3ae08d-e80a-4495-8059-7056c406584f

https://github.com/user-attachments/assets/00a2b3e6-03c3-45a1-b917-d71f6fdef13a

Dynamic Devices

https://github.com/Open-Industry-Project/Open-Industry-Project/assets/105675984/1e74dc9c-0613-43cf-a864-8fc78a2785ca

## Getting Started

**Requirements:** https://dotnet.microsoft.com/en-us/download

**.NET SDK is required for this project for the compilation of C# code**

It is **highly** recommended to download the latest package here: https://github.com/Open-Industry-Project/Open-Industry-Project/releases

It comes with a fork that contains functions and features that are not avaliable in regular Godot.

The contents of this repo are parts of a regular Godot project. You will ~~import~~ (importing will break the project at the moment due to issues with current versions of Godot) open this project via the Godot project manager, just like any other Godot project.

If you are familiar with Godot and you open this project, you will notice that some things look different. This is intentional. This project is meant to be entirely contained with in the editor.

At the moment there is no reason to "run" this project as if it were a game like you normally would for development done in Godot. The editor viewport(s) are where all simulations will take place.

Use the Project Manager to create a new project.

![image](https://github.com/user-attachments/assets/3de4a320-89bc-4088-86b7-a814da0e726d)

All objects used in a simulation scene will be in the Parts tab. 

![image](https://github.com/Open-Industry-Project/Open-Industry-Project/assets/105675984/fd0fd71c-e3fa-43cb-99b5-4b9d65d04727)

All scenes where simulations will take place require a Main node. **A scene that inherients one is automatically created for new projects**, but the easiest way to setup a new one is by creating adding a new scene, and selecting "New Simulation".

![image](https://github.com/Open-Industry-Project/Open-Industry-Project/assets/105675984/d28ec7a4-a3e2-4659-8b9a-3946c8baa528)

![image](https://github.com/Open-Industry-Project/Open-Industry-Project/assets/105675984/2745376e-185a-4963-8c32-a416ca4174bc)

The Main node can be selected in Scene tab.

![image](https://github.com/Open-Industry-Project/Open-Industry-Project/assets/105675984/d7a55424-d958-4130-8a03-7fae6544d616)

This will expose it's properties in the Inspector tab. This is where communications will be setup. (This step can be skipped if no external platform will be used) 

![image](https://github.com/Open-Industry-Project/Open-Industry-Project/assets/105675984/88f90daa-9612-4633-a859-c484303de533)

Parts can be dragged into the viewport to instantiate it. Once they're in the scene they can be modified. 

https://github.com/Open-Industry-Project/Open-Industry-Project/assets/105675984/fc3dca44-ceab-4ecf-8c7d-cd5754fce558

Most parts have properties that can be setup to communicate to a PLC or OPC Server. In this example Ignition was used as an OPC server to write to the conveyor tag.

https://github.com/Open-Industry-Project/Open-Industry-Project/assets/105675984/c14ec7ba-a0ed-4163-850a-4f75f8ec5579

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


