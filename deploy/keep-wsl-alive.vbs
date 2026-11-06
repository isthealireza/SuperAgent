Set shell = CreateObject("WScript.Shell")
Do
  shell.Run "wsl.exe -d Ubuntu -u alpha --exec bash /home/alpha/src/SuperAgent/scripts/superagent.sh start", 0, True
  shell.Run "wsl.exe -d Ubuntu -u alpha --exec sleep infinity", 0, True
  WScript.Sleep 5000
Loop
