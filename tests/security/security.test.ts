import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../apps/catalog-api/src/app.js";
import { validateCatalog } from "../../core/src/catalog.js";
import { developmentGame, developmentManifest } from "../fixtures/catalog.js";

describe("security boundaries",()=>{
  it("hashes passwords with salted scrypt",()=>{const stored=hashPassword("correct horse battery staple");expect(stored.hash).not.toContain("correct");expect(verifyPassword("correct horse battery staple",stored.salt,stored.hash)).toBe(true);expect(verifyPassword("wrong",stored.salt,stored.hash)).toBe(false);});
  it("rejects path traversal package names",()=>expect(()=>validateCatalog(developmentManifest([developmentGame({package:{...developmentGame().package,filename:"..\\evil.pkg"}})]))).toThrow("unsafe"));
  it("does not accept credential-bearing HTTP package URLs",()=>expect(()=>validateCatalog(developmentManifest([developmentGame({package:{...developmentGame().package,url:"http://user:secret@example.invalid/game.pkg"}})]))).toThrow("HTTPS"));
});
