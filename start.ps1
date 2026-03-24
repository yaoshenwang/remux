#!/usr/bin/env pwsh
# Start remux in dev mode with hot reload.
# Frontend: Vite HMR on http://localhost:5173
# Backend:  tsx watch with auto-restart
#
# Usage: .\start.ps1 [--prod]

param(
    [switch]$Prod
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if ($Prod) {
    # Production mode: build and run
    if (-not (Test-Path "dist/backend/cli.js")) {
        Write-Host "Building remux..." -ForegroundColor Yellow
        npm run build
    }
    node dist/backend/cli.js @args
    return
}

# Dev mode: start backend + frontend with hot reload
Write-Host ""
Write-Host "Starting remux dev mode..." -ForegroundColor Cyan
Write-Host "  Backend:  tsx watch (auto-restart on changes)" -ForegroundColor DarkGray
Write-Host "  Frontend: Vite HMR on http://localhost:5173" -ForegroundColor DarkGray
Write-Host ""

# Start Vite in background
$viteJob = Start-Process -FilePath "node" -ArgumentList "node_modules/vite/bin/vite.js","--config","vite.config.ts" `
    -NoNewWindow -PassThru -RedirectStandardOutput "$env:TEMP\remux-vite.log" -RedirectStandardError "$env:TEMP\remux-vite-err.log"

Write-Host "[vite] started (pid=$($viteJob.Id))" -ForegroundColor Green

# Give Vite a moment to start
Start-Sleep 2

# Run backend in foreground (tsx watch for hot reload)
try {
    Write-Host "[back] starting..." -ForegroundColor Blue
    $env:VITE_DEV_MODE = "1"
    npx tsx watch src/backend/cli.ts --no-tunnel --no-require-password @args
}
finally {
    # Clean up Vite when backend exits
    if (-not $viteJob.HasExited) {
        Stop-Process -Id $viteJob.Id -Force -ErrorAction SilentlyContinue
        Write-Host "[vite] stopped" -ForegroundColor Green
    }
}
