# Third-party review

Direct dependencies, versions, sources, and licenses are in `LICENSES/DEPENDENCIES.md`; integrity is pinned by `pnpm-lock.yaml`. Registry stable versions were checked on 2026-07-18. Install scripts are denied by default; only Electron, esbuild, and sharp are explicitly allowed because they retrieve/verify platform binaries or native bindings required by the build.

Before release, generate full transitive notices, scan advisories, inspect lockfile changes, verify package provenance/integrity, and review native binary licenses. The recorded PS4 build pins OpenOrbis v0.5.4 (`b458dfd`) and its official release-archive SHA-256; the toolchain remains external to source control. The package stages the pinned release's sample `right.sprx`, `libc.prx`, and `libSceFios2.prx`. No Sony SDK dependency is allowed.
