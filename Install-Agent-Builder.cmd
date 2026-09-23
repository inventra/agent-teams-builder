@echo off
setlocal
cd /d "%~dp0"
echo Agent Teams Builder one-click installer and updater
echo Checking GitHub updates, Node.js, Claude Code, Codex, and desktop apps...
set "NODE_BIN=%~dp0runtime\windows-x64\node.exe"
if not exist "%NODE_BIN%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo Installation failed: bundled Node.js is missing and no system Node.js 18+ was found.
    pause
    exit /b 1
  )
  set "NODE_BIN=node"
)
"%NODE_BIN%" "%~dp0scripts\install.mjs"
set EXIT_CODE=%ERRORLEVEL%
pause
exit /b %EXIT_CODE%
