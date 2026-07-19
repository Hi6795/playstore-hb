import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { compareSemver, validateCatalog } from "./catalog.js";
import type { CatalogManifest } from "./types.js";

export interface TrustedKey { id: string; publicKeyPem: string; notBefore?: string; notAfter?: string }
export interface AcceptanceState { highestSequence: number; clientVersion: string; now?: Date; allowRecoveryDowngrade?: boolean; production?: boolean }

export function digestCatalog(manifest: unknown): string { return createHash("sha256").update(canonicalize(manifest)).digest("hex"); }
export function signCatalog(manifest: unknown, privateKeyPem: string): string {
  const key: KeyObject = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Signing key must be Ed25519");
  return sign(null, canonicalize(manifest), key).toString("base64");
}

export function verifySignedCatalog(rawManifest: unknown, signatureBase64: string, keys: TrustedKey[], state: AcceptanceState): CatalogManifest {
  const manifest = validateCatalog(rawManifest, { ...(state.production === undefined ? {} : { production: state.production }), ...(state.now === undefined ? {} : { now: state.now }) });
  const now = state.now ?? new Date();
  if (Date.parse(manifest.expires_at) <= now.getTime()) throw new Error("CATALOG_EXPIRED");
  if (compareSemver(state.clientVersion, manifest.minimum_client_version) < 0) throw new Error("CLIENT_UPDATE_REQUIRED");
  if (manifest.catalog_sequence < state.highestSequence && !state.allowRecoveryDowngrade) throw new Error("CATALOG_DOWNGRADE_REJECTED");
  const trusted = keys.find((key) => key.id === manifest.key_id);
  if (!trusted) throw new Error("UNKNOWN_SIGNING_KEY");
  if (trusted.notBefore && now < new Date(trusted.notBefore)) throw new Error("SIGNING_KEY_NOT_ACTIVE");
  if (trusted.notAfter && now >= new Date(trusted.notAfter)) throw new Error("SIGNING_KEY_EXPIRED");
  let signature: Buffer;
  try { signature = Buffer.from(signatureBase64, "base64"); } catch { throw new Error("INVALID_SIGNATURE_ENCODING"); }
  const publicKey = createPublicKey(trusted.publicKeyPem);
  if (publicKey.asymmetricKeyType !== "ed25519" || !verify(null, canonicalize(manifest), publicKey, signature)) throw new Error("INVALID_CATALOG_SIGNATURE");
  return manifest;
}
