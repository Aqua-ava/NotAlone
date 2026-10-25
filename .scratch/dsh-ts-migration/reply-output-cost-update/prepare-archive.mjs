/** 固定提交源码；评测控制脚本与报告器delta单列，不接触共享Git index。 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,readFile,copyFile,symlink,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
const pin=process.argv[2];assert.match(pin??'',/^[a-f0-9]{40}$/);
const gitEnvironment={...process.env};
for(const key of ['GIT_INDEX_FILE','GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES'])delete gitEnvironment[key];
const home=await mkdtemp(join(tmpdir(),'notalone-reply-output-cost-'));await chmod(home,0o700);
const archive=join(home,'archive');await mkdir(archive,{mode:0o700});
const paths=['backend-ts','backend/src','backend/database/migrations','backend/tests/fixtures/fidelity/synthetic-v1.json','.scratch/dsh-ts-migration/baseline','.scratch/dsh-ts-migration/ticket25-final-run'];
const bytes=execFileSync('git',['archive',pin,'--',...paths],{cwd:ROOT,env:gitEnvironment,maxBuffer:128*1024*1024});
execFileSync('tar',['-xf','-','-C',archive],{input:bytes,maxBuffer:1024*1024});
execFileSync('git',['init','--quiet'],{cwd:archive,env:gitEnvironment});
const objectPath=execFileSync('git',['rev-parse','--git-path','objects'],{cwd:ROOT,env:gitEnvironment,encoding:'utf8'}).trim();
await mkdir(join(archive,'.git/objects/info'),{recursive:true});
await writeFile(join(archive,'.git/objects/info/alternates'),resolve(ROOT,objectPath)+'\n');
await writeFile(join(archive,'.git/HEAD'),pin+'\n');
execFileSync('git',['read-tree',pin],{cwd:archive,env:{...gitEnvironment,GIT_INDEX_FILE:join(archive,'.git/index')}});
await symlink(join(ROOT,'backend-ts/node_modules'),join(archive,'backend-ts/node_modules'),'dir');
const delta=[];
for(const name of ['runner.mjs','run-full.mjs','execution-snapshot.mjs','normalize.mjs']){
 const relative='.scratch/dsh-ts-migration/ticket25-final-run/'+name,target=join(archive,relative),before=await readFile(target),after=await readFile(join(ROOT,relative));
 await copyFile(join(ROOT,relative),target);
 delta.push({path:relative,before_sha256:sha(before),after_sha256:sha(after),kind:'evaluation_control_entry'});
}
const reporter=join(home,'reporter-delta');await mkdir(reporter,{mode:0o700});
for(const name of ['reply-comparison-statistics.ts','reply-comparison-sources.ts'])await symlink(join(archive,'backend-ts/src',name),join(reporter,name));
const reportPath='backend-ts/src/reply-comparison.ts';await copyFile(join(ROOT,reportPath),join(reporter,'reply-comparison.ts'));
delta.push({path:reportPath,before_sha256:sha(await readFile(join(archive,reportPath))),after_sha256:sha(await readFile(join(reporter,'reply-comparison.ts'))),kind:'offline_reporter_delta_not_collector_product_source'});
const raw=join(home,'raw');await mkdir(raw,{mode:0o700});
const receipt={schema_version:'reply-output-cost-archive-v1',source_commit:pin,archive,raw,scorer:join(reporter,'reply-comparison.ts'),source_equals_commit_tree:true,dependency_link:'existing_backend_ts_node_modules',shared_index_accessed:false,isolated_archive_index_only:true,deltas:delta};
await writeFile(join(home,'archive-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
process.stdout.write(JSON.stringify({home,...receipt})+'\n');
function sha(value){return createHash('sha256').update(value).digest('hex');}
