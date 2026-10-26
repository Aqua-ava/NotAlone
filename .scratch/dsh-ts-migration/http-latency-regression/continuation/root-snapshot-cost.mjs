// 保留两种原事务隔离；只诊断READ COMMITTED与只读快照的核验成本。
import { performance } from 'node:perf_hooks';
import { writeFile,readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { HostStorage } from '../../../../backend-ts/src/host-storage.ts';

process.umask(0o077);const storage=await HostStorage.open({envFilePath:'unused.env',migrationsDirectory:new URL('../../../../backend/database/migrations/',import.meta.url).pathname,environment:{NOTALONE_DISABLE_DOTENV:'1',NOTALONE_DATABASE_URL:process.env.NOTALONE_SETTINGS_DATABASE}});const rows=[];
try{for(let i=-10;i<30;i++)for(const method of ['businessReadTransaction','businessTransaction']){const start=performance.now();await storage[method](async c=>c.query('SELECT 1'));rows.push({i,method,milliseconds:performance.now()-start});}}
finally{await storage.close();}
const summary=Object.fromEntries(['businessReadTransaction','businessTransaction'].map(method=>{const a=rows.filter(r=>r.method===method&&r.i>=0).map(r=>r.milliseconds).sort((a,b)=>a-b);return[method,(a[14]+a[15])/2]}));
await writeFile(new URL('root-snapshot-cost.json',import.meta.url),JSON.stringify({diagnostic_only:true,summary,rows,source_sha256:createHash('sha256').update(await readFile(new URL('../../../../backend-ts/src/host-storage.ts',import.meta.url))).digest('hex'),own_resources_cleaned:true},null,2)+'\n',{mode:0o600});console.log(JSON.stringify(summary));
