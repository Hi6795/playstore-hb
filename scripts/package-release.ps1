$ErrorActionPreference='Stop'; Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
New-Item -ItemType Directory -Force -Path build | Out-Null
pnpm lint; if($LASTEXITCODE){exit $LASTEXITCODE}
pnpm exec vitest run --reporter=json --outputFile=build/test-report.json; if($LASTEXITCODE){exit $LASTEXITCODE}
pnpm build; if($LASTEXITCODE){exit $LASTEXITCODE}
pnpm run license-notices; if($LASTEXITCODE){exit $LASTEXITCODE}
$version=(Get-Content -Raw package.json|ConvertFrom-Json).version;$target="build/release/playstore-hb-$version";New-Item -ItemType Directory -Force -Path $target|Out-Null
Copy-Item -Recurse -Force dist/desktop-preview "$target/desktop-preview"
Copy-Item -Recurse -Force dist/admin-web "$target/admin-web"
Copy-Item -Recurse -Force dist/node "$target/node-services-and-publisher"
Copy-Item -Recurse -Force infra/docker "$target/container-build-definitions"
Copy-Item -Force dist/THIRD_PARTY_NOTICES.txt,build/test-report.json,README.md,CONTENT_POLICY.md,SECURITY.md,LICENSE,CHANGELOG.md "$target"
Copy-Item -Force docs/HARDWARE_TESTING.md "$target/HARDWARE_TESTING.md"
$ps4Pkg=Get-ChildItem -LiteralPath 'build/ps4/artifacts' -Filter '*.pkg' -File -ErrorAction SilentlyContinue|Select-Object -First 1
if($ps4Pkg){New-Item -ItemType Directory -Force -Path "$target/ps4"|Out-Null;Copy-Item -Force -LiteralPath $ps4Pkg.FullName -Destination "$target/ps4";foreach($name in @('build-report.json','pkg-validation.txt','pkg-entries.txt')){if(Test-Path -LiteralPath "build/ps4/artifacts/$name"){Copy-Item -Force -LiteralPath "build/ps4/artifacts/$name" -Destination "$target/ps4"}}}
$sourceStage="build/release-source-$version";$buildRoot=(Resolve-Path build).Path;$sourceStageFull=[IO.Path]::GetFullPath((Join-Path (Get-Location) $sourceStage))
if(-not $sourceStageFull.StartsWith($buildRoot+[IO.Path]::DirectorySeparatorChar)){throw 'Resolved source staging path escaped build directory.'}
if(Test-Path -LiteralPath $sourceStageFull){Remove-Item -LiteralPath $sourceStageFull -Recurse -Force}
New-Item -ItemType Directory -Force -Path $sourceStageFull,"$sourceStageFull/content/development"|Out-Null
foreach($directory in @('apps','core','tools','schemas','assets','tests','infra','docs','scripts','LICENSES')){Copy-Item -Recurse -Force -LiteralPath $directory -Destination $sourceStageFull}
Copy-Item -Recurse -Force -LiteralPath 'content/production' -Destination "$sourceStageFull/content/production"
Copy-Item -Force -LiteralPath 'content/development/catalog.json','content/development/README.md' -Destination "$sourceStageFull/content/development"
Copy-Item -Force -LiteralPath 'CMakeLists.txt','docker-compose.yml','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','README.md','CONTRIBUTING.md','CONTENT_POLICY.md','SECURITY.md','LICENSE','CHANGELOG.md' -Destination $sourceStageFull
Compress-Archive -Path "$sourceStageFull/*" -DestinationPath "$target/playstore-hb-$version-source.zip" -Force
$electronSmoke=$false;$electron=Get-ChildItem -Recurse -Filter electron.exe -LiteralPath 'node_modules/.pnpm/electron@43.1.1/node_modules/electron/dist' -ErrorAction SilentlyContinue|Select-Object -First 1 -ExpandProperty FullName
if($electron){$desktopProcess=Start-Process -FilePath $electron -ArgumentList 'apps/desktop-preview/electron/main.mjs' -WorkingDirectory (Get-Location).Path -WindowStyle Hidden -PassThru;Start-Sleep -Seconds 4;if(-not $desktopProcess.HasExited){$electronSmoke=$true;Stop-Process -Id $desktopProcess.Id -Force}}
$releaseStatus=if($ps4Pkg){'PS4 build produced but not hardware tested'}elseif($electronSmoke){'Desktop tested'}else{'Desktop build produced'}
@{status=$releaseStatus;desktop_preview_built=$true;electron_smoke_test_passed=$electronSmoke;api_container_definition_built=$false;ps4_build_produced=[bool]$ps4Pkg;ps4_package_sha256=if($ps4Pkg){(Get-FileHash -Algorithm SHA256 -LiteralPath $ps4Pkg.FullName).Hash.ToLower()}else{$null};ps4_hardware_tested=$false;generated_at=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json|Set-Content "$target/build-report.json"
Get-ChildItem -File -Recurse $target|Where-Object{$_.Name -ne 'SHA256SUMS'}|ForEach-Object{"$((Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLower())  $($_.FullName.Substring((Resolve-Path $target).Path.Length+1).Replace('\','/'))"}|Set-Content "$target/SHA256SUMS"
Write-Host "Release assembled at $target. Container definitions are included; Docker images and PS4 hardware tests were not run in this environment."
