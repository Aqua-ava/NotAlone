/** 捕获最终合成验证日志与数据库原件，并输出脱敏SHA绑定。 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,chmod,mkdir,readFile,writeFile,readdir,lstat} from 'node:fs/promises';
import {tmpdir,homedir,userInfo} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {sha} from './attempt-journal.mjs';
const execute=promisify(execFile),own=fileURLToPath(new URL('./',import.meta.url));
assert.deepEqual(process.argv.slice(2),['--synthetic-only'],'explicit_synthetic_only_required');
const root=await mkdtemp(join(tmpdir(),'na-broker-verification-'));await chmod(root,0o700);const cases=join(root,'unit-cases');await mkdir(cases,{mode:0o700});
const env={PATH:join(process.execPath,'..')+':/usr/bin:/bin:/usr/sbin:/sbin',HOME:homedir(),USER:userInfo().username,NOTALONE_DISABLE_DOTENV:'1',PYTHONDONTWRITEBYTECODE:'1',NA_BROKER_TEST_EVIDENCE:cases};
async function run(name,args,timeout){let code=0,log='';try{const r=await execute(process.execPath,args,{cwd:own,env,timeout,maxBuffer:4*1024*1024});log=r.stdout+r.stderr;}
  catch(e){code=Number.isInteger(e.code)?e.code:1;log=String(e.stdout??'')+String(e.stderr??'')+String(e.stack??e);}
  await writeFile(join(root,name+'.log'),log,{mode:0o600});return {code,log};}
const syntax=[];
for(const file of (await readdir(own)).filter(f=>f.endsWith('.mjs'))){const checked=await run('syntax-'+file,['--check',join(own,file)],10000);syntax.push({file,exit_code:checked.code});}
const units=await run('unit',['--test','--test-reporter=tap',join(own,'journal.test.mjs'),join(own,'broker.test.mjs')],15000);
const evidence=[];
for(const entry of await readdir(cases)){
  const path=join(cases,entry),db=new DatabaseSync(join(path,'journal.sqlite'),{readOnly:true}),budget=new DatabaseSync(join(path,'budget.sqlite'),{readOnly:true});
  const rows=db.prepare('SELECT state,record FROM attempts ORDER BY rowid').all(),used=budget.prepare('SELECT used FROM budget').get().used;
  const wire=JSON.parse(await readFile(join(path,'wire.json'),'utf8'));db.close();budget.close();
  evidence.push({attempts:rows.length,physical:rows.filter(r=>JSON.parse(r.record).physical_attempted===true).length,http:wire.length,used,
    states:Object.fromEntries(['responded','failed','unknown'].map(s=>[s,rows.filter(r=>r.state===s).length])),
    raw_sha256:{journal:sha(await readFile(join(path,'journal.sqlite'))),budget:sha(await readFile(join(path,'budget.sqlite'))),wire:sha(await readFile(join(path,'wire.json')))}});
}
const profile=await run('profile',[join(own,'probe.mjs'),'--synthetic-only'],180000);let profileResult=null;
try{profileResult=JSON.parse(profile.log.trim().split('\n').at(-1));}catch{}
const publicLog=units.log.split(own).join('<task>/').split(homedir()).join('<home>').replaceAll(root,'<private>');
assert.ok(!publicLog.includes(homedir()),'public_unit_log_private_path');await writeFile(join(own,'unit-final.tap'),publicLog);
const report={schema_version:'persistent-broker-verification-v1',status:syntax.every(s=>s.exit_code===0)&&units.code===0&&profile.code===0?'engineering_pass':'failed',
  node:process.version,syntax,unit:{exit_code:units.code,tests:Number(units.log.match(/# tests (\d+)/)?.[1]??0),pass:Number(units.log.match(/# pass (\d+)/)?.[1]??0),
    raw_log_sha256:sha(units.log),public_log_sha256:sha(publicLog),retained_case_count:evidence.length,evidence},
  profile:{exit_code:profile.code,result:profileResult,raw_log_sha256:sha(profile.log)},private_evidence_label:root.split('/').at(-1),
  independent_reviews:0,formal_quality_qualified:false,human_120_time_qualified:false,ticket25_approved:false};
const publicBytes=JSON.stringify(report,null,2)+'\n';assert.ok(!publicBytes.includes(homedir())&&!/\/(?:private\/)?var\//.test(publicBytes),'public_report_private_path');
const name='verification-'+Date.now()+'.json';await writeFile(join(own,name),publicBytes,{flag:'wx'});
const rawFiles=[];async function list(directory,prefix=''){for(const e of await readdir(join(directory,prefix),{withFileTypes:true})){
  const relative=join(prefix,e.name);if(e.isDirectory())await list(directory,relative);else{await chmod(join(directory,relative),0o600);rawFiles.push({file:relative,raw_sha256:sha(await readFile(join(directory,relative)))});}
}}await list(root);
await writeFile(join(own,name.replace('.json','-bindings.json')),JSON.stringify({public_file:name,public_sha256:sha(publicBytes),raw:rawFiles,private_directory_mode:(await lstat(root)).mode&0o777},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,units:report.unit.pass,retained_cases:evidence.length,profile:profileResult,public_file:name}));
if(report.status!=='engineering_pass')process.exitCode=1;
