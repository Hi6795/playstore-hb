# PS4 hardware verification checklist

Create one signed record per exact console model, firmware, jailbreak/homebrew environment version, client commit, OpenOrbis commit, catalog sequence, and test date. Never generalize.

- [ ] Fat / exact model and firmware
- [ ] Slim / exact model and firmware
- [ ] Pro / exact model and firmware
- [ ] Each explicitly supported jailbreak environment
- [ ] Fresh install; launch; disclaimer/build metadata
- [ ] Upgrade install; previous settings/cache migration
- [ ] Offline startup and cache age/expiration warning
- [ ] Signed catalog refresh; malformed/signature/downgrade rejection
- [ ] 1,000-entry development performance catalog (never production)
- [ ] Download; pause; resume; restart recovery; long-duration transfer
- [ ] Hash mismatch rejection and invalid-file removal
- [ ] Explicit package install; progress/result; failed installer result
- [ ] Update detection by game/title/content/SemVer and changelog display
- [ ] Low storage plus reserved margin
- [ ] Network loss, timeout, redirect failure, TLS failure
- [ ] Controller disconnect/reconnect and focus restoration
- [ ] Rest-mode interruption where supported
- [ ] Corrupt cache/queue recovery and safe cache clearing
- [ ] Uninstall behavior without database editing
- [ ] System language and configured confirmation mapping
- [ ] 1920×1080 overscan/safe-area adjustment
- [ ] Reduced motion, high contrast, all text sizes
- [ ] Thermal/memory stability over four hours
- [ ] USB redacted diagnostic export when adapter is enabled

Attach actual logs and photos/video of the real reviewed application/package. A skipped line is recorded as skipped, never passed.
