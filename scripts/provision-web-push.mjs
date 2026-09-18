import {readFile,writeFile,mkdir,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import webpush from 'web-push';
const dir=new URL('../.ops/',import.meta.url),file=new URL('web-push.json',dir);
await mkdir(dir,{recursive:true,mode:0o700});
let keys;
try{keys=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;keys=webpush.generateVAPIDKeys();await writeFile(file,JSON.stringify(keys),{mode:0o600});}
await chmod(file,0o600);
const config=JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
if(process.argv.includes('--apply')){
 if(config.vars.VAPID_PUBLIC_KEY!==keys.publicKey)throw new Error('VAPID public key/config mismatch');
 const result=spawnSync('pnpm',['exec','wrangler','secret','put','VAPID_PRIVATE_KEY'],{input:keys.privateKey+'\n',encoding:'utf8'});
 if(result.status!==0)throw new Error('VAPID secret upload failed');
 console.log(JSON.stringify({vapidConfigured:true}));
}else console.log(JSON.stringify({publicKey:keys.publicKey,privateKeyStored:true}));
