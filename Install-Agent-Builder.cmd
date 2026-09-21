@echo off
setlocal
cd /d "%~dp0"
echo Agent Teams Builder one-click installer and updater
echo Checking GitHub updates, Node.js, Claude Code, Codex, and desktop apps...
where node >nul 2>nul
if errorlevel 1 (
  echo Installation failed: Node.js 18 or later is required.
  pause
  exit /b 1
)
node "%~dp0scripts\install.mjs"
set EXIT_CODE=%ERRORLEVEL%
pause
exit /b %EXIT_CODE%
