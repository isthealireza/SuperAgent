Set shell = CreateObject("WScript.Shell")
shell.Run "wsl.exe -d Ubuntu -u alpha --exec sleep infinity", 0, False
