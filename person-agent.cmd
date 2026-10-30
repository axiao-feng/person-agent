@echo off
setlocal

where node >nul 2>nul
if not errorlevel 1 (
  node "%~dp0dist\src\cli.js" %*
  exit /b %errorlevel%
)

set "BUNDLED_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%BUNDLED_NODE%" (
  "%BUNDLED_NODE%" "%~dp0dist\src\cli.js" %*
  exit /b %errorlevel%
)

echo Node.js not found. Install Node.js 24 or add node.exe to PATH. 1>&2
exit /b 1
