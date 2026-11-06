param(
  [ValidateSet('start','status','stop','restart','logs')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
$distro = 'Ubuntu'
$linuxScript = '/home/alpha/src/SuperAgent/scripts/superagent.sh'
wsl.exe -d $distro -u alpha --exec bash $linuxScript $Action
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
