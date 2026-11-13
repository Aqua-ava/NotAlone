/** 只生成离线提案和bundle，不保存产品源码；当前来源资格复用不越过同步动作边界。 */
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const project=fileURLToPath(new URL('../../../',import.meta.url)),backend=join(project,'backend-ts'),scratch=dirname(fileURLToPath(import.meta.url));
const actionFile=join(backend,'src/memory/sqlite/management/adjudication-actions.ts'),qualificationFile=join(backend,'src/memory/sqlite/management/qualification.ts');
const replaceOne=(source,before,after)=>{if(source.split(before).length!==2)throw Error('adjudication_patch_anchor_changed');return source.replace(before,after);};
let action=await readFile(actionFile,'utf8'),qualification=await readFile(qualificationFile,'utf8');
action=replaceOne(action,"import {assertSourceEligibility} from '../../../history/sqlite/source.ts';","import {assertSourceEligibility,type SourceEligibility} from '../../../history/sqlite/source.ts';\nimport type {MessageSourceReference} from '../../../history/sqlite/contracts.ts';");
const act="const act=(name:string,mode:'read'|'write',execute:(tx:StorageTransaction,input:unknown,lease:StorageLease)=>unknown):StorageAction=>({name:`memoryAdjudication.${name}`,mode,retryBusy:mode==='write',execute} as StorageAction);";
action=replaceOne(action,act,`const sourceScopes=new WeakMap<StorageTransaction,Set<string>>();
/** 只在一次同步动作内复用已核验来源身份；消息修订、图片身份及完整任务贡献仍逐项复验。 */
const adjudicationSourceEligibility:SourceEligibility=(tx,ref:MessageSourceReference)=>{
 const cache=sourceScopes.get(tx),key=JSON.stringify([ref.owner_id,ref.contact_id,ref.record_id,ref.message_id]);
 if(cache?.has(key))return;
 assertSourceEligibility(tx,ref);cache?.add(key);
};
function withSourceQualifications<T>(tx:StorageTransaction,work:()=>T):T{
 if(sourceScopes.has(tx))return work();
 sourceScopes.set(tx,new Set());try{return work();}finally{sourceScopes.delete(tx);}
}
const act=(name:string,mode:'read'|'write',execute:(tx:StorageTransaction,input:unknown,lease:StorageLease)=>unknown):StorageAction=>({name:\`memoryAdjudication.\${name}\`,mode,retryBusy:mode==='write',execute:(tx,input,lease)=>withSourceQualifications(tx,()=>execute(tx,input,lease))} as StorageAction);`);
action=replaceOne(action,"const rows=requireSources(tx,ownerId,parent,!!parent.memoryId&&tx.get('SELECT adoption_mode FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,parent.memoryId,parent.versionNo!])?.adoption_mode==='manual');","const rows=requireSources(tx,ownerId,parent,!!parent.memoryId&&tx.get('SELECT adoption_mode FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,parent.memoryId,parent.versionNo!])?.adoption_mode==='manual',adjudicationSourceEligibility);");
action=replaceOne(action,'requireAutomaticCandidate(tx,ownerId,c!);','requireAutomaticCandidate(tx,ownerId,c!,adjudicationSourceEligibility);');
action=replaceOne(action,'verifiedExtractionOutput(tx,{ownerId,eventId:String(c!.event_id)})','verifiedExtractionOutput(tx,{ownerId,eventId:String(c!.event_id)},adjudicationSourceEligibility)');
action=replaceOne(action,'requireVersion(tx,ownerId,m,v!);','requireVersion(tx,ownerId,m,v!,adjudicationSourceEligibility);');
action=replaceOne(action,"sourceVerificationState(tx,ownerId,{memoryId:String(m.id),versionNo:v!.version_no as bigint})","sourceVerificationState(tx,ownerId,{memoryId:String(m.id),versionNo:v!.version_no as bigint},adjudicationSourceEligibility)");
action=replaceOne(action,'qualificationSources(tx,ownerId,{candidateId:basis.candidateId})','qualificationSources(tx,ownerId,{candidateId:basis.candidateId},adjudicationSourceEligibility)');
action=replaceOne(action,'qualificationSources(tx,ownerId,{memoryId:p.id,versionNo:BigInt(p.versionNo)})','qualificationSources(tx,ownerId,{memoryId:p.id,versionNo:BigInt(p.versionNo)},adjudicationSourceEligibility)');
action=replaceOne(action,'requireSources(tx,ownerId,{candidateId:basis.candidateId})','requireSources(tx,ownerId,{candidateId:basis.candidateId},false,adjudicationSourceEligibility)');
action=replaceOne(action,'requireSources(tx,ownerId,{memoryId:p.id,versionNo:BigInt(p.versionNo)},true)','requireSources(tx,ownerId,{memoryId:p.id,versionNo:BigInt(p.versionNo)},true,adjudicationSourceEligibility)');
action=replaceOne(action,'assertSourceEligibility(tx,{owner_id:ownerId,contact_id:String(s.source_contact_id),message_id:String(s.message_id),record_id:String(s.record_id)});','adjudicationSourceEligibility(tx,{owner_id:ownerId,contact_id:String(s.source_contact_id),message_id:String(s.message_id),record_id:String(s.record_id)});');
qualification=replaceOne(qualification,'export function requireAutomaticCandidate(tx:StorageTransaction,ownerId:string,c:StorageRow):void{\n if(requireCandidate(tx,ownerId,c).state', 'export function requireAutomaticCandidate(tx:StorageTransaction,ownerId:string,c:StorageRow,sourceEligibility:SourceEligibility=assertSourceEligibility):void{\n if(requireCandidate(tx,ownerId,c,sourceEligibility).state');
await writeFile(join(scratch,'adjudication-actions-proposed.ts'),action,{mode:0o600});await writeFile(join(scratch,'adjudication-qualification-proposed.ts'),qualification,{mode:0o600});
const backendRequire=createRequire(join(backend,'package.json')),{build}=createRequire(join(project,'desktop/package.json'))('esbuild');
const result=await build({absWorkingDir:backend,entryPoints:['src/memory/sqlite/management/adjudication-actions.ts'],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent',plugins:[{name:'private-adjudication-source',setup(build){build.onLoad({filter:/\.ts$/},args=>args.path===actionFile?{contents:action,loader:'ts',resolveDir:dirname(actionFile)}:args.path===qualificationFile?{contents:qualification,loader:'ts',resolveDir:dirname(qualificationFile)}:undefined);build.onResolve({filter:/^[^./][^:]*/},args=>args.path.startsWith('node:')?{path:args.path,external:true}:{path:backendRequire.resolve(args.path),external:true});}}]});
await writeFile(join(scratch,'adjudication-source-patched-bundle.mjs'),result.outputFiles[0].text,{mode:0o600});console.log(JSON.stringify({privateBundlePrepared:true,sourceApplied:false}));
