$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host "Agent Teams Builder 一鍵安裝／更新程式"
$BundledNode = Join-Path $Root "runtime\windows-x64\node.exe"
if (Test-Path $BundledNode) {
  $Node = $BundledNode
} elseif (Get-Command node -ErrorAction SilentlyContinue) {
  $Node = "node"
} else {
  throw "安裝包內缺少 Node.js，且電腦也沒有 Node.js 18+。"
}
& $Node (Join-Path $Root "scripts\install.mjs")
exit $LASTEXITCODE
