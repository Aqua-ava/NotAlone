// 每轮读完相同 116 份 SQL；仅比较 I/O 调度方式，绝不复用校验成功。
import { readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
const directory = new URL('../../../../backend/database/migrations/',import.meta.url);
const names = readdirSync(directory).filter(x=>x.endsWith('.sql')).sort();
const rounds=[];
for(let i=-10;i<30;i++) for(const mode of ['async','sync']) {
 const start=performance.now();
 const data=mode==='async' ? await Promise.all(names.map(name=>readFile(new URL(name,directory)))) : names.map(name=>readFileSync(new URL(name,directory)));
 const hashes=data.map(value=>createHash('sha256').update(value).digest('hex'));
 rounds.push({index:i,mode,milliseconds:performance.now()-start,hashes});
}
const summaries=Object.fromEntries(['async','sync'].map(mode=>{const values=rounds.filter(x=>x.mode===mode&&x.index>=0).map(x=>x.milliseconds).sort((a,b)=>a-b);return[mode,{p50_ms:(values[14]+values[15])/2}]}));
const identical=rounds.every(x=>JSON.stringify(x.hashes)===JSON.stringify(rounds[0].hashes));
await writeFile(new URL('file-reads.json',import.meta.url),JSON.stringify({count:names.length,identical,summaries,rounds},null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({count:names.length,identical,summaries}));
