Dim shell, fso, scriptDir, cmd, i, arg, quote

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
quote = Chr(34)
cmd = "cmd /c " & quote & "set MEMORY_SUITE_HIDDEN_RELAY=1&& " & quote & scriptDir & "\start-electron.bat" & quote

For i = 0 To WScript.Arguments.Count - 1
  arg = Replace(WScript.Arguments(i), """", """""")
  cmd = cmd & " " & quote & arg & quote
Next

cmd = cmd & quote
shell.Run cmd, 0, False
