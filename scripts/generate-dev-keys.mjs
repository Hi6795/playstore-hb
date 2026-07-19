import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
const directory="content/development/keys";await mkdir(directory,{recursive:true});
const {privateKey,publicKey}=generateKeyPairSync("ed25519");
await writeFile(`${directory}/DEVELOPMENT-ONLY-private.pem`,privateKey.export({type:"pkcs8",format:"pem"}),{mode:0o600,flag:"wx"}).catch((error)=>{if(error.code!=="EEXIST")throw error;});
await writeFile(`${directory}/development-local-public.pem`,publicKey.export({type:"spki",format:"pem"}),{mode:0o644,flag:"wx"}).catch((error)=>{if(error.code!=="EEXIST")throw error;});
await writeFile(`${directory}/README.txt`,"DEVELOPMENT-ONLY KEYS. Never trust or use these for production publication.\n");
console.log("Development-only Ed25519 keys are present in the ignored development directory.");
