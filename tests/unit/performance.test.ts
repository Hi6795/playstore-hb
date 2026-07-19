import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { validateCatalog } from "../../core/src/catalog.js";
import { developmentGame, developmentManifest } from "../fixtures/catalog.js";

describe("large development catalog performance",()=>{
  it("validates 1,000 explicitly marked test records without an excessive pause",()=>{const games=Array.from({length:1000},(_,index)=>{const n=String(index).padStart(5,"0");return developmentGame({id:`development-test-data-${n}`,title_id:`PSTB${n}`,content_id:`IV0000-PSTB${n}_00-DEVTEST${String(index).padStart(9,"0")}`,name:`DEVELOPMENT TEST DATA ${n}`});});const start=performance.now();const result=validateCatalog(developmentManifest(games));const elapsed=performance.now()-start;expect(result.games).toHaveLength(1000);expect(elapsed).toBeLessThan(2000);});
});
