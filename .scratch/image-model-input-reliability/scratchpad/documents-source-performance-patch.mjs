/** 离线生成文档来源资格整改提案；不保存产品文件或活动验收备份。 */
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const project=fileURLToPath(new URL('../../../',import.meta.url)),backend=join(project,'backend-ts'),scratch=dirname(fileURLToPath(import.meta.url));
const paths=Object.fromEntries(['basis','actions','stages','publication','later-schedule'].map(name=>[name,join(backend,`src/memory/sqlite/documents/${name}.ts`)])),sources={};
const one=(source,before,after)=>{if(source.split(before).length!==2)throw Error('document_patch_anchor_changed');return source.replace(before,after);};
for(const [name,path] of Object.entries(paths))sources[name]=await readFile(path,'utf8');
sources.basis=one(sources.basis,"import {assertSourceEligibility,type SourceEligibility} from '../../../history/sqlite/source.ts';","import {assertSourceEligibility,type SourceEligibility} from '../../../history/sqlite/source.ts';\nimport type {MessageSourceReference} from '../../../history/sqlite/contracts.ts';");
sources.basis=one(sources.basis,'function safeNumber(value:bigint):number',`const sourceQualifications=new WeakMap<StorageTransaction,Set<string>>();
/** 一个同步动作内只复用当前来源身份的核验；不缓存正文、版本修订或文档依赖结果。 */
export const documentSourceEligibility:SourceEligibility=(tx,ref:MessageSourceReference)=>{
 const cache=sourceQualifications.get(tx),key=JSON.stringify([ref.owner_id,ref.contact_id,ref.record_id,ref.message_id]);
 if(cache?.has(key))return;
 assertSourceEligibility(tx,ref);cache?.add(key);
};
export function withDocumentSourceQualifications<T>(tx:StorageTransaction,work:()=>T):T{
 if(sourceQualifications.has(tx))return work();
 sourceQualifications.set(tx,new Set());try{return work();}finally{sourceQualifications.delete(tx);}
}
function safeNumber(value:bigint):number`);
if(sources.basis.split('sourceEligibility:SourceEligibility=assertSourceEligibility').length!==6)throw Error('document_source_defaults_changed');
sources.basis=sources.basis.replaceAll('sourceEligibility:SourceEligibility=assertSourceEligibility','sourceEligibility:SourceEligibility=documentSourceEligibility');
sources.basis=one(sources.basis,'sourceMemo&&sourceEligibility===assertSourceEligibility?', 'sourceMemo&&(sourceEligibility===assertSourceEligibility||sourceEligibility===documentSourceEligibility)?');
sources.basis=one(sources.basis,' assertSourceEligibility(tx,{owner_id:ownerId,contact_id:s.contactId,message_id:s.messageId,record_id:s.recordId});',' documentSourceEligibility(tx,{owner_id:ownerId,contact_id:s.contactId,message_id:s.messageId,record_id:s.recordId});');
sources.actions=one(sources.actions,"import {memoryBasis,publicationMembers,renderDocuments,withSourceMemo} from './basis.ts';","import {memoryBasis,publicationMembers,renderDocuments,withSourceMemo,documentSourceEligibility,withDocumentSourceQualifications} from './basis.ts';");
sources.actions=one(sources.actions,' assertInputs(tx,ownerId,String(t.run_id),inputs);',' assertInputs(tx,ownerId,String(t.run_id),inputs,documentSourceEligibility);');
sources.actions=one(sources.actions,'execute:fn});','execute:(tx,input)=>withDocumentSourceQualifications(tx,()=>fn(tx,input))});');
for(const name of ['stages','publication']){
 const oldImport=sources[name].split('\n').find(line=>line.startsWith('import {')&&line.endsWith("from './basis.ts';"));if(!oldImport)throw Error('document_basis_import_missing');sources[name]=one(sources[name],oldImport,oldImport.replace("} from './basis.ts';",",withDocumentSourceQualifications} from './basis.ts';"));
 sources[name]=one(sources[name],"mode,retryBusy:false,execute} as StorageAction);","mode,retryBusy:false,execute:(tx,input,lease)=>withDocumentSourceQualifications(tx,()=>execute(tx,input,lease))} as StorageAction);");
}
sources['later-schedule']=one(sources['later-schedule'],"import {memoryBasis,documentSources} from './basis.ts';","import {memoryBasis,documentSources,withDocumentSourceQualifications} from './basis.ts';");
sources['later-schedule']=one(sources['later-schedule'],"mode,retryBusy:false,execute});","mode,retryBusy:false,execute:(tx,input)=>withDocumentSourceQualifications(tx,()=>execute(tx,input))});");
for(const [name,source] of Object.entries(sources))await writeFile(join(scratch,`documents-${name}-proposed.ts`),source,{mode:0o600});
const backendRequire=createRequire(join(backend,'package.json')),{build}=createRequire(join(project,'desktop/package.json'))('esbuild');
const result=await build({absWorkingDir:backend,entryPoints:['src/memory/sqlite/documents/stages.ts'],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent',plugins:[{name:'private-document-source',setup(build){build.onLoad({filter:/\.ts$/},args=>{const name=Object.keys(paths).find(name=>paths[name]===args.path);return name?{contents:sources[name],loader:'ts',resolveDir:dirname(args.path)}:undefined;});build.onResolve({filter:/^[^./][^:]*/},args=>args.path.startsWith('node:')?{path:args.path,external:true}:{path:backendRequire.resolve(args.path),external:true});}}]});
await writeFile(join(scratch,'documents-source-patched-bundle.mjs'),result.outputFiles[0].text,{mode:0o600});console.log(JSON.stringify({privateBundlePrepared:true,sourceApplied:false,files:Object.keys(paths).length}));
