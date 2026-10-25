/** 最小统一执行的原始stdout/stderr留在仓库外；公开副本绑定双方SHA。 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,chmod,writeFile,readFile,readdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir,homedir,userInfo} from 'node:os';
import {fileURLToPath} from 'node:url';
import {sha,REPO} from './snapshot.mjs';
const execute=promisify(execFile),own=fileURLToPath(new URL('./',import.meta.url));
const directory=await mkdtemp(join(tmpdir(),'na-skill-verification-'));await chmod(directory,0o700);
const label=directory.split('/').at(-1).replace('na-skill-verification-','verification-');
const start=Date.now();let stdout='',stderr='',code=0;
try{const output=await execute(process.execPath,[join(own,'probe.mjs'),'--synthetic-only'],{cwd:REPO,env:{PATH:process.env.PATH,HOME:homedir(),USER:userInfo().username,NOTALONE_DISABLE_DOTENV:'1'},timeout:240000,maxBuffer:1024*1024});stdout=output.stdout;stderr=output.stderr;}
catch(error){stdout=String(error.stdout??'');stderr=String(error.stderr??'');code=error.code??1;}
await writeFile(join(directory,'verification.stdout.log'),stdout,{mode:0o600});await writeFile(join(directory,'verification.stderr.log'),stderr,{mode:0o600});
const publicText=(stdout+stderr).split(REPO).join('<repository>').split(homedir()).join('<private-home>').replace(/\/private\/var\/folders\/[^\s"']+/g,'<private-temporary-path>');
await writeFile(new URL('./'+label+'.log',import.meta.url),publicText,{flag:'wx'});
const candidates=await Promise.all((await readdir(own)).filter(n=>n.endsWith('-summary.json')).map(async name=>({name,mtime:(await stat(join(own,name))).mtimeMs})));
const selected=candidates.filter(x=>x.mtime>=start).sort((a,b)=>b.mtime-a.mtime)[0];
const result={command:'node .scratch/dsh-ts-migration/nonreply-skill-formal-driver/probe.mjs --synthetic-only',exit_code:code,
  raw_directory_label:directory.split('/').at(-1),raw_stdout_sha256:sha(stdout),raw_stderr_sha256:sha(stderr),public_log_sha256:sha(publicText),
  public_summary:selected?.name??null,public_summary_sha256:selected?sha(await readFile(join(own,selected.name))):null};
await writeFile(new URL('./'+label+'.json',import.meta.url),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result));assert.equal(code,0,'integrated_skill_probe_failed');
