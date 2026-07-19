# Known limitations

- A PS4 fake PKG was cross-compiled, structurally validated, and extracted, but no PS4 hardware was available. Install, launch, video output, controller input, suspend/resume, shutdown, memory stability, and firmware compatibility are unverified.
- The native PS4 runtime currently presents the signed-empty-catalog storefront shell. The shared catalog, download, persistence, and integrity implementations are desktop-tested but are not yet wired to console HTTP/filesystem adapters.
- The AppInstUtil adapter compiles against OpenOrbis v0.5.4 and calls `sceAppInstUtilAppInstallPkg`, but it has not been executed on hardware. Installed-title discovery, network diagnostics, media decoding/cache, and USB diagnostic export still need console adapters.
- The generated artifact is a fake PKG for a compatible jailbroken/homebrew environment. It is not retail-signed and cannot install on an unmodified console.
- Docker was unavailable, so compose services and container images remain unexecuted in this environment.
- Electron application packaging into platform installers is not configured; the built preview runs through the pinned Electron host.
- S3 upload/promotion is represented by validated storage keys and a filesystem atomic publisher; managed production promotion remains deployment work.
- Public account login is not built; the admin API uses externally provisioned bearer principals. CSRF protection must be added if ambient cookie authentication is introduced.
- The production catalog is empty and no production private signing key is provisioned. No game or firmware compatibility claim exists.
- Bounded artwork-cache eviction and a measured 1,000-entry console benchmark remain hardware/client integration work.
