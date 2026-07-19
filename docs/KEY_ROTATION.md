# Signing-key rotation

1. Generate Ed25519 keys offline; assign a new non-secret key ID and activation window.
2. Add the new public key to a client release while the old key remains trusted; hardware-test that client.
3. Reach the required client adoption threshold and publish a higher-sequence catalog signed by the new key.
4. Keep the old public key only for the documented overlap; never distribute either private key.
5. Release a client that removes the retired/compromised public key. Record fingerprints, custodians, dates, and approvals offline.

Emergency compromise skips normal overlap where necessary: freeze, sign revocation with an unaffected key, remove compromised trust in a client update, and communicate recovery. Accepting an older sequence always requires an explicit user-controlled recovery action and audit warning.
