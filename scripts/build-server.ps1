$ErrorActionPreference='Stop'; Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot); pnpm build:server; pnpm build:admin
