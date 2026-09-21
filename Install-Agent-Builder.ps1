$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host "Agent Teams Builder 一鍵安裝程式"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "找不到 Node.js 18+。請先安裝 Node.js LTS。"
}
& node (Join-Path $Root "scripts\install.mjs")
exit $LASTEXITCODE
