# Build NotifyCenter.exe with the in-box .NET Framework 4.8 compiler (no SDK needed).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = 'Stop'

$fw = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$csc = Join-Path $fw 'csc.exe'
if (-not (Test-Path $csc)) { throw "csc.exe not found: $csc" }

$out = Join-Path $PSScriptRoot 'NotifyCenter.exe'
$src = Join-Path $PSScriptRoot 'NotifyCenter.cs'
$manifest = Join-Path $PSScriptRoot 'app.manifest'
$config = Join-Path $PSScriptRoot 'NotifyCenter.exe.config'

& $csc /nologo /target:winexe /platform:anycpu /optimize+ /warn:4 `
    "/win32manifest:$manifest" "/out:$out" `
    "/r:$fw\System.dll" "/r:$fw\System.Core.dll" "/r:$fw\System.Net.Http.dll" `
    "/r:$fw\System.Web.Extensions.dll" "/r:$fw\System.Xaml.dll" `
    "/r:$fw\WPF\WindowsBase.dll" "/r:$fw\WPF\PresentationCore.dll" "/r:$fw\WPF\PresentationFramework.dll" `
    $src

if ($LASTEXITCODE -ne 0) { throw "compile failed with exit code $LASTEXITCODE" }

# NotifyCenter.exe.config holds the WPF per-monitor DPI switch; .NET reads it
# automatically at startup, so it only has to sit next to the executable.
if (-not (Test-Path $config)) { throw "missing NotifyCenter.exe.config" }

Get-Item $out | Select-Object FullName, Length, LastWriteTime
