$ErrorActionPreference='Stop'; Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if (Get-Command docker -ErrorAction SilentlyContinue) { docker compose up --build }
else { Write-Host 'Docker unavailable. Start separately: pnpm dev:api, pnpm dev:desktop, pnpm dev:admin'; pnpm dev:desktop }
