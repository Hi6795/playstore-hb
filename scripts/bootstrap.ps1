$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$missing = @()
foreach ($tool in @('node','pnpm')) { if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { $missing += $tool } }
if ($missing.Count) { throw "Missing required tools: $($missing -join ', '). Install Node.js 24+ and pnpm 11." }
if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env'; Write-Host 'Created .env from the safe development template.' }
pnpm install --frozen-lockfile
node scripts/generate-dev-keys.mjs
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Write-Warning 'Docker is not installed; PostgreSQL/MinIO containers will be unavailable. Core, tests, and desktop builds still work.' }
Write-Host 'Bootstrap complete. Development keys are visibly marked and git-ignored.'
