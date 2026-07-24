#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import sharp from "sharp";
import { canonicalize, digestCatalog, sha256File, signCatalog, validateCatalog, verifySignedCatalog, type CatalogGame, type CatalogManifest } from "../../../core/src/index.js";

interface Report { ok: boolean; command: string; errors: string[]; warnings: string[]; details: Record<string, unknown> }
const argv=process.argv.slice(2);const command=argv.shift()??"help";
const report:Report={ok:false,command,errors:[],warnings:[],details:{}};
function argument(name:string,fallback?:string):string|undefined{const index=argv.indexOf(name);return index>=0?argv[index+1]:fallback;}
function positional(index=0):string|undefined{return argv.filter((v,i)=>i===0||!argv[i-1]!.startsWith("--")) [index];}
async function json(path:string):Promise<unknown>{return JSON.parse(await readFile(path,"utf8"));}
async function atomicWrite(path:string,data:string|Buffer):Promise<void>{await mkdir(dirname(path),{recursive:true});const temp=`${path}.tmp-${process.pid}`;await writeFile(temp,data,{mode:0o600});await rename(temp,path);}

try{
  switch(command){
    case "validate":await validateCommand(positional()??"content/production/catalog.json");break;
    case "inspect-pkg":await inspectPkg(required(positional(),"package path"));break;
    case "hash":await hashCommand(required(positional(),"file path"));break;
    case "process-media":await processMedia(required(positional(),"media directory"));break;
    case "build-catalog":await buildCatalog();break;
    case "sign-catalog":await signCommand();break;
    case "verify-catalog":await verifyCommand();break;
    case "diff-catalog":await diffCommand(required(positional(0),"old catalog"),required(positional(1),"new catalog"));break;
    case "publish":await publishCommand();break;
    default:report.errors.push("Usage: playstorehb-publisher <validate|inspect-pkg|hash|process-media|build-catalog|sign-catalog|verify-catalog|diff-catalog|publish>");
  }
}catch(error){report.errors.push(error instanceof Error?error.message:String(error));}
report.ok=report.errors.length===0;process.stdout.write(`${JSON.stringify(report,null,2)}\n`);process.exitCode=report.ok?0:1;

function required(value:string|undefined,label:string):string{if(!value)throw new Error(`Missing ${label}`);return value;}
async function validateCommand(path:string){const value=await json(path);const production=resolve(path).includes(`${join("content","production")}`);const manifest=validateCatalog(value,{production});if(production&&manifest.channel==="development")throw new Error("Development channel is forbidden in production");report.details={path:resolve(path),catalogVersion:manifest.catalog_version,sequence:manifest.catalog_sequence,games:manifest.games.length,production};}
async function inspectPkg(path:string){const size=(await stat(path)).size;if(size<32)throw new Error("Package is too small to contain a PS4 package header");const handle=await import("node:fs/promises").then((m)=>m.open(path,"r"));const header=Buffer.alloc(32);try{await handle.read(header,0,32,0);}finally{await handle.close();}const magic=header.subarray(0,4).toString("hex");const looksLikePkg=magic==="7f434e54";report.details={path:resolve(path),sizeBytes:size,headerMagic:magic,looksLikePs4Pkg:looksLikePkg,sha256:await sha256File(path)};report.warnings.push("Header inspection does not establish authorization, safety, content identity, launchability, or redistribution rights.");if(!looksLikePkg)report.errors.push("Package header magic is not recognized as an OpenOrbis-compatible PS4 PKG container.");}
async function hashCommand(path:string){report.details={path:resolve(path),sizeBytes:(await stat(path)).size,sha256:await sha256File(path)};}
async function processMedia(directory:string){const output=argument("--output",join(directory,"processed"))!;const names=(await readdir(directory)).filter((name)=>[".png",".jpg",".jpeg",".webp"].includes(extname(name).toLowerCase())).sort();const outputs=[];for(const name of names){const input=join(directory,name);const image=sharp(input,{failOn:"warning",limitInputPixels:40_000_000});const meta=await image.metadata();if(!meta.width||!meta.height)throw new Error(`${name}: missing dimensions`);if(meta.width<320||meta.height<180)report.warnings.push(`${name}: low resolution; output will not be upscaled`);const stem=basename(name,extname(name));const portrait=/cover/i.test(stem);const targets=portrait?[{suffix:"cover-thumb",width:320,height:480},{suffix:"cover-full",width:840,height:1260}]:[{suffix:"screenshot-thumb",width:480,height:270},{suffix:"full",width:1920,height:1080}];for(const target of targets){const scale=Math.min(1,target.width/meta.width,target.height/meta.height);const width=Math.max(1,Math.floor(meta.width*scale));const height=Math.max(1,Math.floor(meta.height*scale));const path=join(output,`${stem}-${target.suffix}.webp`);await mkdir(dirname(path),{recursive:true});await sharp(input,{failOn:"warning"}).rotate().resize(width,height,{fit:"inside",withoutEnlargement:true}).webp({quality:82,effort:6}).toFile(path);outputs.push({path:resolve(path),width,height,sha256:await sha256File(path)});}if(/icon/i.test(stem)){const path=join(output,`${stem}-ps4-icon.png`);await sharp(input,{failOn:"warning"}).rotate().resize(512,512,{fit:"contain",withoutEnlargement:true,background:{r:8,g:11,b:18,alpha:1}}).png({compressionLevel:9}).toFile(path);const info=await sharp(path).metadata();outputs.push({path:resolve(path),width:info.width,height:info.height,sha256:await sha256File(path)});}if(/splash|background/i.test(stem)){const path=join(output,`${stem}-ps4-background.png`);await sharp(input,{failOn:"warning"}).rotate().resize(1920,1080,{fit:"inside",withoutEnlargement:true}).png({compressionLevel:9}).toFile(path);const info=await sharp(path).metadata();outputs.push({path:resolve(path),width:info.width,height:info.height,sha256:await sha256File(path)});}}report.details={inputs:names.length,outputs};}
async function buildCatalog(){const input=argument("--input","content/reviewed")!;const output=argument("--output","build/catalog/catalog.json")!;let files:string[]=[];try{files=(await readdir(input)).filter((f)=>f.endsWith(".json")).sort();}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}const games:CatalogGame[]=[];for(const file of files){const record=await json(join(input,file)) as {status?:string;game?:CatalogGame};if(record.status!=="approved"||!record.game)throw new Error(`${file}: package lacks an approval record`);games.push(record.game);}games.sort((a,b)=>a.id.localeCompare(b.id));const epoch=Number(process.env.SOURCE_DATE_EPOCH??0);if(!epoch)throw new Error("SOURCE_DATE_EPOCH is required for deterministic generated_at");const generated=new Date(epoch*1000);const manifest:CatalogManifest={schema_version:1,catalog_version:argument("--version",generated.toISOString().slice(0,10).replaceAll("-",".")+".1")!,catalog_sequence:Number(argument("--sequence","1")),generated_at:generated.toISOString(),expires_at:new Date(generated.getTime()+30*86400_000).toISOString(),minimum_client_version:argument("--minimum-client","0.1.0")!,key_id:argument("--key-id","development-local")!,channel:argument("--channel","development") as CatalogManifest["channel"],games};validateCatalog(manifest,{production:manifest.channel!=="development"});await atomicWrite(output,`${canonicalize(manifest).toString("utf8")}\n`);report.details={output:resolve(output),games:games.length,digest:digestCatalog(manifest)};}
async function signCommand(){const catalog=argument("--catalog",positional()??"build/catalog/catalog.json")!;const keyPath=argument("--key",process.env.PLAYSTOREHB_SIGNING_KEY_PATH);if(!keyPath)throw new Error("Signing key path is required; no private key fallback exists");const manifest=validateCatalog(await json(catalog),{production:!resolve(catalog).includes("development")});const signature=signCatalog(manifest,await readFile(keyPath,"utf8"));const output=argument("--output",`${catalog}.sig`)!;await atomicWrite(output,`${signature}\n`);report.details={catalog:resolve(catalog),signature:resolve(output),keyId:manifest.key_id,digest:digestCatalog(manifest)};}
async function verifyCommand(){const catalog=argument("--catalog",positional()??"build/catalog/catalog.json")!;const signaturePath=argument("--signature",`${catalog}.sig`)!;const publicPath=required(argument("--public-key",process.env.PLAYSTOREHB_PUBLIC_KEY_PATH),"public key path");const manifest=validateCatalog(await json(catalog));const at=argument("--at");const now=at?new Date(at):new Date();if(Number.isNaN(now.getTime()))throw new Error("--at must be a valid ISO-8601 timestamp");verifySignedCatalog(manifest,(await readFile(signaturePath,"utf8")).trim(),[{id:manifest.key_id,publicKeyPem:await readFile(publicPath,"utf8")}],{highestSequence:Number(argument("--highest-sequence","0")),clientVersion:argument("--client-version","1.0.0")!,now});report.details={catalog:resolve(catalog),keyId:manifest.key_id,digest:digestCatalog(manifest),verifiedAt:now.toISOString()};}
async function diffCommand(oldPath:string,newPath:string){const old=validateCatalog(await json(oldPath));const next=validateCatalog(await json(newPath));const oldMap=new Map(old.games.map((g)=>[g.id,g]));const newMap=new Map(next.games.map((g)=>[g.id,g]));const added=[...newMap.keys()].filter((id)=>!oldMap.has(id));const removed=[...oldMap.keys()].filter((id)=>!newMap.has(id));const updated=[...newMap].filter(([id,g])=>oldMap.has(id)&&oldMap.get(id)!.version!==g.version).map(([id])=>id);report.details={oldSequence:old.catalog_sequence,newSequence:next.catalog_sequence,added,removed,updated};if(next.catalog_sequence<=old.catalog_sequence)report.errors.push("New catalog sequence must increase");}
async function publishCommand(){
  const environment=argument("--environment");
  if(!["staging","production"].includes(environment??""))throw new Error("--environment must be staging or production");
  const catalog=argument("--catalog","build/catalog/catalog.json")!;
  const signaturePath=argument("--signature",`${catalog}.sig`)!;
  const publicPath=required(argument("--public-key",process.env.PLAYSTOREHB_PUBLIC_KEY_PATH),"public key path");
  const signature=(await readFile(signaturePath,"utf8")).trim();
  const rawManifest=await json(catalog);
  const candidate=validateCatalog(rawManifest,{production:environment==="production"});
  if(environment==="production"&&candidate.channel==="development")throw new Error("Refusing development catalog in production");
  if(environment==="production"&&candidate.games.some((game)=>game.development_test_data))throw new Error("Refusing DEVELOPMENT TEST DATA in production");
  const target=process.env.PLAYSTOREHB_PUBLISH_TARGET_DIR;
  if(!target)throw new Error("PLAYSTOREHB_PUBLISH_TARGET_DIR is required; implicit remote publication is forbidden");
  const environmentRoot=resolve(target,environment!);
  await mkdir(environmentRoot,{recursive:true});
  const currentPath=join(environmentRoot,"current.json");
  let previous:Record<string,unknown>|null=null;
  try{previous=await json(currentPath) as Record<string,unknown>;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw new Error("Existing publication pointer is invalid");}
  const previousSequence=previous===null?-1:Number(previous.sequence);
  if(!Number.isSafeInteger(previousSequence)||previousSequence<-1)throw new Error("Existing publication sequence is invalid");
  if(candidate.catalog_sequence<=previousSequence)throw new Error("Catalog sequence must increase before publication");
  const manifest=verifySignedCatalog(
    candidate,
    signature,
    [{id:candidate.key_id,publicKeyPem:await readFile(publicPath,"utf8")}],
    {highestSequence:Math.max(0,previousSequence),clientVersion:argument("--client-version","1.0.0")!,production:environment==="production"},
  );
  const destinationName=`catalog-${manifest.catalog_sequence}`;
  const destination=join(environmentRoot,destinationName);
  try{await access(destination);throw new Error("Immutable catalog destination already exists");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const next=join(environmentRoot,`.next-${manifest.catalog_sequence}-${process.pid}-${Date.now()}`);
  await mkdir(next,{recursive:false});
  let promoted=false;
  try{
    const stagedCatalog=join(next,"catalog.json");
    const stagedSignature=join(next,"catalog.json.sig");
    await copyFile(catalog,stagedCatalog);
    await copyFile(signaturePath,stagedSignature);
    await writeFile(join(next,"key-id"),`${manifest.key_id}\n`,{mode:0o600});
    const sourceDigest=await sha256File(catalog);
    if(await sha256File(stagedCatalog)!==sourceDigest)throw new Error("Staged catalog digest mismatch");
    if((await readFile(stagedSignature,"utf8")).trim()!==signature)throw new Error("Staged signature mismatch");
    await rename(next,destination);
    promoted=true;
    await mkdir(join(environmentRoot,"history"),{recursive:true});
    if(previous)await atomicWrite(join(environmentRoot,"history",`pointer-${previousSequence}.json`),`${JSON.stringify(previous,null,2)}\n`);
    const pointer={
      sequence:manifest.catalog_sequence,
      catalog_version:manifest.catalog_version,
      key_id:manifest.key_id,
      catalog_sha256:sourceDigest,
      catalog:`${destinationName}/catalog.json`,
      signature:`${destinationName}/catalog.json.sig`,
      published_at:new Date().toISOString(),
    };
    await atomicWrite(currentPath,`${JSON.stringify(pointer,null,2)}\n`);
    report.details={environment,destination:resolve(destination),sequence:manifest.catalog_sequence,games:manifest.games.length,digest:sourceDigest,pointer:resolve(currentPath)};
    report.warnings.push("CDN cache refresh and remote object availability remain explicit infrastructure operations.");
  }finally{
    if(!promoted)await rm(next,{recursive:true,force:true});
  }
}
