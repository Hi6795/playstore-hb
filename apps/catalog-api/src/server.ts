import { createApi } from "./app.js";
import { migrate, PostgresRepository, MemoryRepository } from "./repository.js";

const host=process.env.HOST??"127.0.0.1";const port=Number(process.env.PORT??8080);
const repository=process.env.DATABASE_URL?await PostgresRepository.connect(process.env.DATABASE_URL):new MemoryRepository();
if(repository instanceof PostgresRepository) await migrate((repository as unknown as {pool:import("pg").Pool}).pool).catch((error)=>{throw new Error(`Database migration failed: ${String(error)}`);});
let tokens:Record<string,{subject:string;role:"submitter"|"reviewer"|"publisher"|"administrator"}>={};
try{tokens=JSON.parse(process.env.ADMIN_TOKENS_JSON??"{}");}catch{throw new Error("ADMIN_TOKENS_JSON must be valid JSON");}
if(Object.keys(tokens).length===0&&process.env.NODE_ENV==="production")throw new Error("Production requires ADMIN_TOKENS_JSON");
const allowedOrigins=(process.env.ADMIN_ORIGINS??"http://127.0.0.1:5174,http://localhost:5174").split(",").map((value)=>value.trim()).filter(Boolean);
let trustedKeys:import("../../../core/src/signedCatalog.js").TrustedKey[]=[];try{trustedKeys=JSON.parse(process.env.CATALOG_TRUSTED_KEYS_JSON??"[]");}catch{throw new Error("CATALOG_TRUSTED_KEYS_JSON must be valid JSON");}
const app=await createApi({repository,...(Object.keys(tokens).length?{tokens}:{}),logger:true,allowedOrigins,trustedKeys});
await app.listen({host,port});
