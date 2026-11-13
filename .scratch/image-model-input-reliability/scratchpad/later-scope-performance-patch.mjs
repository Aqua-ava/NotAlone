/** 仅生成私有离线bundle；产品源码需主Agent给出热更新窗口后才保存。 */
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const project=fileURLToPath(new URL('../../../',import.meta.url));
export function transform(source){
 const replace=(before,after)=>{if(source.split(before).length!==2)throw Error('later_scope_patch_anchor_changed');source=source.replace(before,after);};
 replace("import {runTargetsReleased,releasedRunSql} from '../run-retirement.ts';","import {runTargetsReleased} from '../run-retirement.ts';");
 replace('function scopeBlocked(tx:StorageTransaction,ownerId:string,row:StorageRow):boolean {','function scopeBlocked(tx:StorageTransaction,ownerId:string,row:StorageRow,releasedRuns:Map<string,boolean>):boolean {');
 replace(" AND NOT ${releasedRunSql('r')}", '');
 replace(' for(const blocker of blockers){\n',` for(const blocker of blockers){
  // 一个同步只读扫描内按运行复验一次；先缩小到当前范围任务，避免每个任务展开完整回执链。
  const runId=String(blocker.run_id);
  if(['failed','revoked','completed'].includes(String(blocker.run_state))){
   let released=releasedRuns.get(runId);
   if(released===undefined){released=runTargetsReleased(tx,ownerId,runId);releasedRuns.set(runId,released);}
   if(released)continue;
  }
`);
 replace("if(!failed||blocker.run_state==='completed'||runTargetsReleased(tx,ownerId,String(blocker.run_id)))continue;","if(!failed||blocker.run_state==='completed')continue;");
 replace(' return candidates.filter(row=>!scopeBlocked(tx,ownerId,row));',' const releasedRuns=new Map<string,boolean>();\n return candidates.filter(row=>!scopeBlocked(tx,ownerId,row,releasedRuns));');
 return source;
}
const backend=join(project,'backend-ts'),backendRequire=createRequire(join(backend,'package.json')),{build}=createRequire(join(project,'desktop/package.json'))('esbuild');
const target=join(backend,'src/memory/sqlite/documents/later-schedule.ts'),original=await readFile(target,'utf8'),output=transform(original);
await writeFile(new URL('./later-schedule-proposed.ts',import.meta.url),output,{mode:0o600});
const result=await build({absWorkingDir:backend,entryPoints:['src/memory/sqlite/runs.ts'],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent',plugins:[{name:'private-scope-patch',setup(build){build.onLoad({filter:/\/documents\/later-schedule\.ts$/},args=>({contents:args.path===target?output:undefined,loader:'ts',resolveDir:dirname(target)}));build.onResolve({filter:/^[^./][^:]*/},args=>args.path.startsWith('node:')?{path:args.path,external:true}:{path:backendRequire.resolve(args.path),external:true});}}]});
await writeFile(new URL('./later-scope-patched-bundle.mjs',import.meta.url),result.outputFiles[0].text,{mode:0o600});
console.log(JSON.stringify({privateBundlePrepared:true,sourceApplied:false}));
