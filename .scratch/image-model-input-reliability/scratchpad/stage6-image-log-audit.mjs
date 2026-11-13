/** 只读现有统一日志；不会打印或复制原始trace/context/身份，仅汇总字段与范围。 */
import {readdir,lstat,readFile,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {homedir} from 'node:os';
import {join} from 'node:path';
const privateRoot='/tmp/notalone-image-reliability-hw9x92j_',directory=join(homedir(),'Library/Application Support/NotAloneDesktop/logs');
const initial=JSON.parse(await readFile(join(privateRoot,'stage6-independent-initial.json'),'utf8')),calls=new Set(initial.calls.filter(row=>['extraction','verification'].includes(row.purpose)).map(row=>row.id));
const files=(await readdir(directory)).filter(name=>/^backend-\d{4}-\d{2}-\d{2}-\d+\.jsonl$/.test(name)).sort();
const rows=[],sample=[];let badLines=0,earliest=Infinity,latest=-Infinity;
for(const name of files){const path=join(directory,name),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.())throw Error('audit_log_file_invalid');const lines=createInterface({input:createReadStream(path,{encoding:'utf8'}),crlfDelay:Infinity});for await(const line of lines){if(!line.includes('processing.model_'))continue;let row;try{row=JSON.parse(line);}catch{badLines++;continue;}if(!['processing.model_call','processing.model_image'].includes(row.event))continue;const time=Date.parse(row.time);if(Number.isFinite(time)){earliest=Math.min(earliest,time);latest=Math.max(latest,time);}rows.push(row);if(calls.has(row.callId))sample.push(row);}}
const fields=['originalBytes','sentBytes','imageCount','requestBytes','failureCategory','durationMs'];
const range=(list,key)=>{const values=list.map(row=>row[key]).filter(value=>typeof value==='number'&&Number.isFinite(value));return {count:values.length,min:values.length?Math.min(...values):null,max:values.length?Math.max(...values):null};};
const summary=list=>({rows:list.length,distinctCalls:new Set(list.map(row=>row.callId)).size,fields:Object.fromEntries(fields.map(field=>[field,{present:list.filter(row=>Object.hasOwn(row,field)).length,...(field==='failureCategory'?{none:list.filter(row=>row[field]==='none').length}:range(list,field))}])),imageIdPresent:list.filter(row=>Object.hasOwn(row,'imageId')).length});
const callRows=sample.filter(row=>row.event==='processing.model_call'),imageRows=sample.filter(row=>row.event==='processing.model_image');
const unsafeFields=['message','cause','body','prompt','context','dataBase64','requestBody','responseBody'];
const safe={observedAt:new Date().toISOString(),logFiles:files.length,allRetainedImageEvents:rows.length,retainedImageEventTimeRange:{earliest:Number.isFinite(earliest)?new Date(earliest).toISOString():null,latest:Number.isFinite(latest)?new Date(latest).toISOString():null},sampleL1DatabaseCalls:calls.size,sampleCallRows:summary(callRows),sampleImageRows:summary(imageRows),sampleDistinctImages:new Set(imageRows.map(row=>row.imageId)).size,callImageRowsComplete:callRows.every(row=>imageRows.filter(image=>image.callId===row.callId).length===row.imageCount),unexpectedContentFieldCount:sample.filter(row=>unsafeFields.some(field=>Object.hasOwn(row,field))).length,partialLines:badLines};
await writeFile(join(privateRoot,'stage6-unified-image-log-audit.json'),JSON.stringify(safe,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(safe));
