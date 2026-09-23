$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host "Agent Teams Builder installer/updater"
$BundledNode = Join-Path $Root "runtime\windows-x64\node.exe"
if (Test-Path $BundledNode) {
  $Node = $BundledNode
} elseif (Get-Command node -ErrorAction SilentlyContinue) {
  $Node = "node"
} else {
  throw "Node.js 18+ was not found in the installer or on this computer."
}
& $Node (Join-Path $Root "scripts\install.mjs")
exit $LASTEXITCODE
