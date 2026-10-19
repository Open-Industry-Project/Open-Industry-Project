' Launch Open Industry Project - Simulator with NO visible console window.
' The desktop shortcut targets this script; it runs launch-prod.cmd hidden (window style 0),
' which starts Electron on the built app. Electron shows its own GUI window normally.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
q = Chr(34)
sh.Run "cmd /c " & q & dir & "\launch-prod.cmd" & q, 0, False
