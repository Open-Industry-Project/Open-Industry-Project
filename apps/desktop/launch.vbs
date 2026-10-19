' Launch Open Industry Project - Simulator with NO visible console window.
' The desktop shortcut targets this script; it runs launch.cmd hidden (window style 0),
' which orchestrates the dev server + Electron. Electron shows its own GUI window normally.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
q = Chr(34)
sh.Run "cmd /c " & q & dir & "\launch.cmd" & q, 0, False
