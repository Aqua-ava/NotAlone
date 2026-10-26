// 仅合成counterfactual：复用真实业务与存储；省去DSH/宿主编排，绝不能作产品或gate结果。
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const project=process.env.NOTALONE_PERF_PROJECT;
const {HostStorage}=await import(pathToFileURL(path.join(project,'backend-ts/src/host-storage.ts')));
const {ContactContext}=await import(pathToFileURL(path.join(project,'backend-ts/src/contact-context.ts')));
const {stringifyJson}=await import(pathToFileURL(path.join(project,'backend-ts/src/host-json.ts')));
const environment={...Object.fromEntries(Object.entries(process.env).filter(([key])=>key.startsWith('PG')||key.startsWith('NOTALONE_'))),HOME:process.env.HOME};
const storage=await HostStorage.open({envFilePath:process.env.NOTALONE_ENV_FILE,migrationsDirectory:path.join(project,'backend/database/migrations'),environment});
const contacts=new ContactContext(storage),token=randomBytes(32).toString('base64url');
const server=http.createServer(async(req,res)=>{
 if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401).end('{}');return;}
 try{const result=await contacts.handle(req.method,new URL(req.url,'http://127.0.0.1'));
 res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}).end(stringifyJson(result));}
 catch(error){res.writeHead(error.status??503,{'Content-Type':'application/json'}).end(JSON.stringify({error:error.code??'unavailable'}));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
await writeFile(process.env.NOTALONE_BACKEND_INFO,`address=127.0.0.1:${server.address().port}\ntoken=${token}\npid=${process.pid}\n`,{mode:0o600});
let stopping;
const stop=()=>stopping??=(async()=>{await new Promise(resolve=>server.close(resolve));await storage.close();process.stdin.pause();})();
process.stdin.resume();process.stdin.on('end',stop);process.on('SIGTERM',stop);
