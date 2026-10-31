$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$localDotnet = Join-Path $root '.dotnet\dotnet.exe'
if (Test-Path $localDotnet) {
    $env:DOTNET_ROOT = Join-Path $root '.dotnet'
    $env:DOTNET_MULTILEVEL_LOOKUP = '0'
    $dotnet = $localDotnet
} else {
    $dotnet = 'dotnet'
}

& $dotnet run --project (Join-Path $PSScriptRoot 'PersonAgent.Desktop.Tests.csproj') -c Debug
exit $LASTEXITCODE
