@echo off
setlocal EnableExtensions
title Person Agent
chcp 65001 >nul

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "CLI=%ROOT%\dist\src\cli.js"
set "PROJECT=%ROOT%\client\PersonAgent.Desktop\PersonAgent.Desktop.csproj"
set "EXE=%ROOT%\client\PersonAgent.Desktop\bin\Debug\net8.0-windows\PersonAgent.Desktop.exe"
set "LOCAL_DOTNET=%ROOT%\.dotnet\dotnet.exe"
set "DOTNET_CMD=%LOCAL_DOTNET%"
if not exist "%LOCAL_DOTNET%" set "DOTNET_CMD=dotnet"

if not exist "%CLI%" call :build_service
if errorlevel 1 goto :failed
if not exist "%EXE%" call :build_desktop
if errorlevel 1 goto :failed

if exist "%LOCAL_DOTNET%" (
  set "DOTNET_ROOT=%ROOT%\.dotnet"
  set "DOTNET_MULTILEVEL_LOOKUP=0"
) else (
  set "DOTNET_ROOT="
  set "DOTNET_MULTILEVEL_LOOKUP="
)
start "" "%EXE%"
exit /b 0

:build_service
echo Building local service...
pushd "%ROOT%"
if exist "%ROOT%\node_modules\.bin\tsc.cmd" (
  call "%ROOT%\node_modules\.bin\tsc.cmd" -p tsconfig.json
) else (
  call npx tsc -p tsconfig.json
)
set "RESULT=%ERRORLEVEL%"
popd
exit /b %RESULT%

:build_desktop
echo Building desktop client...
pushd "%ROOT%"
if exist "%DOTNET_CMD%" (
  call "%DOTNET_CMD%" build "%PROJECT%" -c Debug
) else (
  call dotnet build "%PROJECT%" -c Debug
)
set "RESULT=%ERRORLEVEL%"
popd
exit /b %RESULT%

:failed
echo.
echo Build failed. See the messages above.
pause
exit /b 1
