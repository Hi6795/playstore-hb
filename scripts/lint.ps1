$ErrorActionPreference='Stop'; Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot); pnpm lint; pnpm format:check
