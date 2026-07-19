import { performance } from "node:perf_hooks";
import { platform, release, cpus } from "node:os";
import { validateCatalog } from "../core/src/catalog.js";
import { developmentGame, developmentManifest } from "../tests/fixtures/catalog.js";
const count=1000;const games=Array.from({length:count},(_,index)=>{const n=String(index).padStart(5,"0");return developmentGame({id:`development-test-data-${n}`,title_id:`PSTB${n}`,content_id:`IV0000-PSTB${n}_00-DEVTEST${String(index).padStart(9,"0")}`,name:`DEVELOPMENT TEST DATA ${n}`});});
const start=performance.now();validateCatalog(developmentManifest(games));const elapsedMs=performance.now()-start;
console.log(JSON.stringify({records:count,elapsedMs:Number(elapsedMs.toFixed(3)),node:process.version,platform:platform(),release:release(),cpu:cpus()[0]?.model??"unknown",claim:"desktop development-data schema validation only"},null,2));
