/** 103 的一次性内容转换；调用方持有迁移事务，失败保留旧表及字节。 */
import type {Client} from 'pg';
import {constants} from 'node:fs';
import {open,mkdir,link,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {SkillFiles,packageManifest,type SkillVersionFiles,type SkillMethod} from '../../skills/skill-files.ts';
import {canonicalRoot,checkNoLinks,readBounded,readPackage,serializeSkillDocument,sha256,validatePackage,type SkillPackage} from '../../skills/skill-package.ts';
import {resolveSkillsRoot} from '../../skills/skills-root.ts';
import {canonicalJSON} from '../../memory/overview/evidence/sources.ts';

type Row=Record<string,any>;
const fail=():never=>{throw new Error('skill_content_upgrade_required');};
async function immutable(file:string,bytes:Buffer):Promise<void>{
 checkNoLinks(file);await mkdir(dirname(file),{recursive:true,mode:0o700});checkNoLinks(file);
 const temporary=join(dirname(file),`.upgrade-${randomUUID()}`);let staged;
 try{
  staged=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  await staged.writeFile(bytes);await staged.sync();await staged.close();staged=undefined;
  try{await link(temporary,file);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  if(!readBounded(file).equals(bytes))fail();
 }finally{await staged?.close();await rm(temporary,{force:true});}
}
function originalPackage(root:string,row:Row,resources:Row[]):{pkg:SkillPackage;document:Buffer;relative:string}{
 if(row.name!==row.skill_name||row.skill_status==='deleted')fail();
 const relative=`.versions/${row.owner_id}/${row.skill_id}/${row.id}/${row.name}/SKILL.md`;
 let document:Buffer,pkg:SkillPackage;
 if(row.content_path==null){
  if(!row.content||resources.some(r=>r.content==null))fail();
  document=serializeSkillDocument(row.name,row.description,row.content);
  pkg=validatePackage(row.name,document,resources.map(r=>({relative_path:r.relative_path,resource_kind:r.resource_kind,media_type:r.media_type,content:Buffer.from(r.content),content_sha256:r.content_sha256})));
 }else{
  if(row.content_path!==relative)fail();
  const file=join(root,relative);document=readBounded(file);if(sha256(document)!==row.document_sha256)fail();
  const loaded=readPackage(dirname(file));
  const metadata=new Map(resources.map(r=>[r.relative_path,r]));
  pkg=validatePackage(row.name,document,loaded.resources.map(r=>({...r,media_type:metadata.get(r.relative_path)?.media_type??r.media_type})));
 }
 if(pkg.name!==row.name||pkg.description!==row.description||row.content_sha256!=null&&row.content_sha256!==pkg.content_sha256||row.content!=null&&row.content!==pkg.content||resources.length!==pkg.resources.length)fail();
 const metadata=new Map(resources.map(r=>[r.relative_path,r]));
 for(const resource of pkg.resources){
  const old=metadata.get(resource.relative_path);
  if(!old||old.resource_kind!==resource.resource_kind||old.media_type!==resource.media_type||old.byte_size!==resource.content.length||old.content_sha256!==resource.content_sha256
   ||old.content!=null&&!Buffer.from(old.content).equals(resource.content)||old.content_path!=null&&(row.content_path==null||old.content_path!==join(dirname(relative),resource.relative_path)))fail();
 }
 if(!Array.isArray(row.validation_warnings)||row.validation_warnings.some((warning:unknown)=>typeof warning!=='string'))fail();
 return {pkg:{...pkg,warnings:row.validation_warnings},document,relative};
}
export async function upgradeSkillBusinessState(client:Client,environment:NodeJS.ProcessEnv):Promise<void>{
 await client.query('ALTER TABLE public.reply_skill_version ADD COLUMN IF NOT EXISTS manifest_sha256 text CHECK (manifest_sha256 IS NULL OR manifest_sha256 ~ \'^[0-9a-f]{64}$\')');
 const rows=(await client.query("SELECT version.*,skill.owner_id,skill.name AS skill_name,skill.status AS skill_status FROM public.reply_skill_version version JOIN public.reply_skill skill ON skill.id=version.skill_id WHERE version.status='active' ORDER BY skill.owner_id,version.id FOR UPDATE OF version")).rows;
 for(const owner of [...new Set(rows.map(row=>row.owner_id))].sort())await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${owner}`]);
 const root=canonicalRoot(resolveSkillsRoot(environment,environment.HOME??homedir(),process.cwd()));const files=new SkillFiles(root);
 for(const row of rows){
  const resources=(await client.query('SELECT * FROM public.reply_skill_resource WHERE skill_version_id=$1 ORDER BY relative_path',[row.id])).rows;
  const {pkg,document,relative}=originalPackage(root,row,resources),base=dirname(dirname(relative));
  await immutable(join(root,relative),document);
  for(const resource of pkg.resources)await immutable(join(root,dirname(relative),resource.relative_path),resource.content);
  const manifest=Buffer.from(canonicalJSON(packageManifest(pkg))),manifestHash=sha256(manifest);
  if(row.manifest_sha256!=null&&row.manifest_sha256!==manifestHash)fail();
  await immutable(join(root,base,'manifest.json'),manifest);
  const receipt={content_path:relative,document_sha256:sha256(document),content_sha256:pkg.content_sha256,manifest_sha256:manifestHash};
  const current={...row,...receipt} as SkillVersionFiles;
  files.readManifest(current);if(files.readContent(current)!==pkg.content)fail();
  for(const resource of pkg.resources)if(!files.readResource(current,resource.relative_path).equals(resource.content))fail();
  await client.query('UPDATE public.reply_skill_version SET content_path=$1,document_sha256=$2,content_sha256=$3,manifest_sha256=$4,content=NULL WHERE id=$5',[relative,receipt.document_sha256,receipt.content_sha256,manifestHash,row.id]);
  for(const resource of resources)await client.query('UPDATE public.reply_skill_resource SET content_path=$1,content=NULL WHERE id=$2',[join(dirname(relative),resource.relative_path),resource.id]);
  if(row.content_path==null&&row.is_current)await client.query('INSERT INTO public.reply_skill_working_copy(skill_id,version_id) VALUES($1,$2) ON CONFLICT(skill_id) DO UPDATE SET version_id=excluded.version_id',[row.skill_id,row.id]);
 }
 for(const row of rows){
  const methods=(await client.query('SELECT method_id,title,instruction FROM public.reply_skill_method WHERE version_id=$1 ORDER BY ordinal',[row.id])).rows;
  if(!methods.length)continue;
  const hasLegacy=methods.some(method=>method.title!=null||method.instruction!=null);
  let receipt={method_manifest_path:row.method_manifest_path,method_manifest_sha256:row.method_manifest_sha256};
  if(hasLegacy){
   if(methods.some(method=>method.title==null||method.instruction==null))fail();
   receipt=files.prepareMethods(row.owner_id,row.skill_id,row.id,methods as SkillMethod[]);
   await client.query('UPDATE public.reply_skill_version SET method_manifest_path=$1,method_manifest_sha256=$2 WHERE id=$3',[receipt.method_manifest_path,receipt.method_manifest_sha256,row.id]);
  }
  const current=(await client.query('SELECT * FROM public.reply_skill_version WHERE id=$1',[row.id])).rows[0];
  const loaded=files.readMethods({...current,...receipt,owner_id:row.owner_id,name:row.name},methods.map(method=>method.method_id));
  if(hasLegacy&&JSON.stringify(loaded)!==JSON.stringify(methods))fail();
  if(hasLegacy)await client.query('UPDATE public.reply_skill_method SET title=NULL,instruction=NULL WHERE version_id=$1',[row.id]);
 }
}
