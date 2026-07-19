import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CatalogValidationError, canonicalize, compareSemver, signCatalog, validateCatalog, verifySignedCatalog } from "../../core/src/index.js";
import { developmentGame, developmentManifest } from "../fixtures/catalog.js";

const keys=generateKeyPairSync("ed25519");const privatePem=keys.privateKey.export({type:"pkcs8",format:"pem"}).toString();const publicPem=keys.publicKey.export({type:"spki",format:"pem"}).toString();
describe("catalog validation and signatures",()=>{
  it("accepts a valid development manifest",()=>expect(validateCatalog(developmentManifest()).games).toHaveLength(1));
  it("canonicalizes object keys deterministically",()=>expect(canonicalize({z:1,a:[2,1]}).toString()).toBe('{"a":[2,1],"z":1}'));
  it("accepts a valid signature",()=>{const m=developmentManifest();const sig=signCatalog(m,privatePem);expect(verifySignedCatalog(m,sig,[{id:m.key_id,publicKeyPem:publicPem}],{highestSequence:0,clientVersion:"0.1.0",now:new Date("2026-07-19")}).catalog_sequence).toBe(9001);});
  it("rejects a tampered manifest",()=>{const m=developmentManifest();const sig=signCatalog(m,privatePem);const changed={...m,catalog_sequence:9002};expect(()=>verifySignedCatalog(changed,sig,[{id:m.key_id,publicKeyPem:publicPem}],{highestSequence:0,clientVersion:"0.1.0",now:new Date("2026-07-19")})).toThrow("INVALID_CATALOG_SIGNATURE");});
  it("rejects unknown keys",()=>{const m=developmentManifest();expect(()=>verifySignedCatalog(m,signCatalog(m,privatePem),[],{highestSequence:0,clientVersion:"0.1.0",now:new Date("2026-07-19")})).toThrow("UNKNOWN_SIGNING_KEY");});
  it("rejects catalog downgrade",()=>{const m=developmentManifest();expect(()=>verifySignedCatalog(m,signCatalog(m,privatePem),[{id:m.key_id,publicKeyPem:publicPem}],{highestSequence:9002,clientVersion:"0.1.0",now:new Date("2026-07-19")})).toThrow("CATALOG_DOWNGRADE_REJECTED");});
  it("rejects unsupported schema",()=>expect(()=>validateCatalog({...developmentManifest(),schema_version:2})).toThrow("unsupported schema_version"));
  it("rejects duplicate identifiers",()=>expect(()=>validateCatalog(developmentManifest([developmentGame(),developmentGame()]))).toThrow("duplicate id"));
  it("rejects missing legal evidence",()=>expect(()=>validateCatalog(developmentManifest([developmentGame({legal:{...developmentGame().legal,redistribution_evidence_id:""}})]))).toThrow("legal record is incomplete"));
  it("rejects development data in production",()=>expect(()=>validateCatalog(developmentManifest(),{production:true})).toThrow("DEVELOPMENT TEST DATA"));
  it("rejects a source port without exact warnings",()=>expect(()=>validateCatalog(developmentManifest([developmentGame({distribution_mode:"requires_original_files",requires_original_files:true,original_files_notice:"Bring files"})]))).toThrow("required notice"));
  it("rejects unsafe filenames and non-HTTPS URLs",()=>expect(()=>validateCatalog(developmentManifest([developmentGame({package:{...developmentGame().package,filename:"../bad.pkg",url:"http://bad.invalid/file.pkg"}})]))).toThrow(CatalogValidationError));
  it("compares semantic versions",()=>{expect(compareSemver("1.2.0","1.1.9")).toBe(1);expect(compareSemver("1.0.0-beta","1.0.0")).toBe(-1);});
});
