#!/usr/bin/env pwsh
# Start remux.
#
# Usage:
#   .\start.ps1                           Dev mode (hot reload, no tunnel)
#   .\start.ps1 --prod                    Production (build + run with tunnel)
#   .\start.ps1 --prod --password mypass  Production with custom password
#   .\start.ps1 --dev --tunnel            Dev mode with tunnel enabled

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# Parse our flags, pass the rest through to the CLI.
$isProd = $false
$passthrough = @()

for ($i = 0; $i -lt $args.Count; $i++) {
    if ($args[$i] -eq "--prod") {
        $isProd = $true
    } elseif ($args[$i] -eq "--dev") {
        # explicit dev mode (default anyway)
    } else {
        $passthrough += $args[$i]
    }
}

if ($isProd) {
    # Production mode: always rebuild to ensure dist/ is current.
    Write-Host "Building remux..." -ForegroundColor Yellow
    npm run build
    # Use a stable token so the URL doesn't change on restart.
    if (-not $env:REMUX_TOKEN) {
        $tokenFile = Join-Path (Join-Path $env:USERPROFILE ".remux") "token"
        if (Test-Path $tokenFile) {
            $env:REMUX_TOKEN = (Get-Content $tokenFile -Raw).Trim()
        } else {
            $env:REMUX_TOKEN = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
            New-Item -ItemType Directory -Path (Split-Path $tokenFile) -Force | Out-Null
            Set-Content $tokenFile $env:REMUX_TOKEN
        }
        Write-Host "  Stable token saved to $tokenFile" -ForegroundColor DarkGray
    }
    Write-Host "Starting remux (production)..." -ForegroundColor Cyan
    node dist/backend/cli.js @passthrough
    return
}

# Dev mode: tsx watch (hot reload) + Vite frontend.
# Default: no tunnel, no password. Override with explicit flags.
$devArgs = @("--no-require-password")

# Only add --no-tunnel if user didn't explicitly pass --tunnel.
$hasTunnel = $passthrough -contains "--tunnel"
if (-not $hasTunnel) {
    $devArgs += "--no-tunnel"
}

$devArgs += $passthrough

Write-Host ""
Write-Host "Starting remux dev mode..." -ForegroundColor Cyan
Write-Host "  Backend:  tsx watch (auto-restart on changes)" -ForegroundColor DarkGray
Write-Host "  Frontend: Vite HMR on http://localhost:5173" -ForegroundColor DarkGray
Write-Host ""

# Start Vite in background.
$viteJob = Start-Process -FilePath "node" -ArgumentList "node_modules/vite/bin/vite.js","--config","vite.config.ts" `
    -NoNewWindow -PassThru -RedirectStandardOutput "$env:TEMP\remux-vite.log" -RedirectStandardError "$env:TEMP\remux-vite-err.log"

Write-Host "[vite] started (pid=$($viteJob.Id))" -ForegroundColor Green
Start-Sleep 2

try {
    Write-Host "[back] starting..." -ForegroundColor Blue
    $env:VITE_DEV_MODE = "1"
    npx tsx watch src/backend/cli.ts @devArgs
}
finally {
    if (-not $viteJob.HasExited) {
        Stop-Process -Id $viteJob.Id -Force -ErrorAction SilentlyContinue
        Write-Host "[vite] stopped" -ForegroundColor Green
    }
}
