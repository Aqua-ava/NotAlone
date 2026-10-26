/** 103 格式的不可变文件存储；业务资格与数据库事务由调用方负责。 */
import { mkdirSync, mkdtempSync, renameSync, rmSync, lstatSync, readdirSync, openSync, closeSync, writeSync, fsyncSync, constants, existsSync, linkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { canonicalRoot, compareText, checkNoLinks, decodeUtf8, MAX_RESOURCE_BYTES, parseSkillDocument, readBounded, readPackage, serializeSkillDocument, sha256, validateName, validatePackage, validateRelative, validateResourcePath, type SkillPackage } from './skill-package.ts';

export class SkillFileError extends Error { readonly code='file_unavailable'; constructor(){super('Skill 文件不可用。');this.name='SkillFileError';} }
export interface SkillVersionFiles { owner_id:string;skill_id:string;id:string;name:string;content_path:string;document_sha256:string;content_sha256:string;manifest_sha256:string;method_manifest_path?:string|null;method_manifest_sha256?:string|null }
export interface SkillFileReceipt {content_path:string;document_sha256:string;content_sha256:string;manifest_sha256:string}
export interface SkillManifestResource {relative_path:string;resource_kind:'reference'|'asset';media_type:string;byte_size:number;content_sha256:string}
export interface SkillManifest {schema_version:1;name:string;description:string;warnings:string[];resources:SkillManifestResource[]}
export interface SkillMethod {method_id:string;title:string;instruction:string}
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function uuid(value:string):string {if(typeof value!=='string'||!uuidPattern.test(value))throw new SkillFileError();return value;}
function safe<T>(action:()=>T):T {try{return action();}catch{throw new SkillFileError();}}
function exactKeys(value:unknown,keys:string[]):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('\0')===[...keys].sort().join('\0');}
function sortedJson(value:unknown):string {if(Array.isArray(value))return '['+value.map(sortedJson).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+sortedJson((value as Record<string,unknown>)[k])).join(',')+'}';return JSON.stringify(value);}
export function packageManifest(pkg:SkillPackage):SkillManifest {return {schema_version:1,name:pkg.name,description:pkg.description,warnings:[...pkg.warnings],resources:[...pkg.resources].sort((a,b)=>compareText(a.relative_path,b.relative_path)).map(r=>({relative_path:r.relative_path,resource_kind:r.resource_kind,media_type:r.media_type,byte_size:r.content.length,content_sha256:r.content_sha256}))};}
/** 纯业务匹配：资源路径为身份，忽略目录遍历或数据库排序差异。输入须已通过包/清单校验。 */
export function matchesSkillPackage(row:SkillVersionFiles,manifest:SkillManifest,pkg:SkillPackage):boolean {
  if(row.name!==pkg.name || row.content_sha256!==pkg.content_sha256 || manifest.description!==pkg.description)return false;
  const tuples=(resources:SkillManifestResource[])=>[...resources].sort((a,b)=>compareText(a.relative_path,b.relative_path)).map(r=>[r.relative_path,r.resource_kind,r.media_type,r.byte_size,r.content_sha256]);
  const proposed=pkg.resources.map(r=>({relative_path:r.relative_path,resource_kind:r.resource_kind,media_type:r.media_type,byte_size:r.content.length,content_sha256:r.content_sha256}));
  return JSON.stringify(tuples(manifest.resources))===JSON.stringify(tuples(proposed));
}
function validateManifest(raw:unknown,name:string):SkillManifest {
  if(!exactKeys(raw,['schema_version','name','description','warnings','resources'])||raw.schema_version!==1||raw.name!==name||typeof raw.description!=='string'||!raw.description.trim()||[...raw.description].length>1024||!Array.isArray(raw.warnings)||raw.warnings.some(w=>typeof w!=='string')||!Array.isArray(raw.resources)||raw.resources.length>100)throw new SkillFileError();
  const seen=new Set<string>();let total=0;
  for(const r of raw.resources){if(!exactKeys(r,['relative_path','resource_kind','media_type','byte_size','content_sha256']))throw new SkillFileError();validateResourcePath(r.relative_path as string);const relative=r.relative_path as string;if(seen.has(relative)||r.resource_kind!==(relative.startsWith('references/')?'reference':'asset')||typeof r.media_type!=='string'||!r.media_type.trim()||typeof r.byte_size!=='number'||!Number.isInteger(r.byte_size)||r.byte_size<0||r.byte_size>MAX_RESOURCE_BYTES||typeof r.content_sha256!=='string'||! /^[0-9a-f]{64}$/.test(r.content_sha256))throw new SkillFileError();seen.add(relative);total+=r.byte_size;}
  if(total>4*MAX_RESOURCE_BYTES)throw new SkillFileError();return raw as unknown as SkillManifest;
}
function normalizeMethods(methods:SkillMethod[]):SkillMethod[]{if(!Array.isArray(methods)||methods.length<1||methods.length>6)throw new SkillFileError();const seen=new Set<string>();return methods.map(m=>{uuid(m.method_id);if(seen.has(m.method_id)||typeof m.title!=='string'||!m.title.trim()||typeof m.instruction!=='string'||!m.instruction.trim())throw new SkillFileError();seen.add(m.method_id);return {method_id:m.method_id,title:m.title,instruction:m.instruction};});}
export class SkillFiles {
  readonly root:string;
  constructor(root=process.env.NOTALONE_SKILLS_DIR??join(homedir(),'.notalone','skills')) {this.root=resolve(root.startsWith('~/')?join(homedir(),root.slice(2)):root);}
  private path(relative:string):string {validateRelative(relative);let root=this.root;try{root=canonicalRoot(root);}catch{/* 未创建根的父目录仍由逐段检查覆盖。 */}const path=join(root,relative);checkNoLinks(path);return path;}
  private versionRoot(owner:string,skill:string,version:string):string{return `.versions/${uuid(owner)}/${uuid(skill)}/${uuid(version)}`;}
  private locator(row:SkillVersionFiles):string{validateName(row.name);const expected=this.versionRoot(row.owner_id,row.skill_id,row.id)+`/${row.name}/SKILL.md`;if(row.content_path!==expected)throw new SkillFileError();return expected;}
  private read(relative:string,hash:string):Buffer {const bytes=readBounded(this.path(relative));if(sha256(bytes)!==hash)throw new SkillFileError();return bytes;}
  private write(path:string,bytes:Buffer):void {checkNoLinks(path);mkdirSync(dirname(path),{recursive:true,mode:0o700});checkNoLinks(path);const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{let offset=0;while(offset<bytes.length)offset+=writeSync(fd,bytes,offset,bytes.length-offset);fsyncSync(fd);}finally{closeSync(fd);}}
  prepareVersion(owner:string,skill:string,version:string,pkg:SkillPackage):SkillFileReceipt {return safe(()=>{
    validateName(pkg.name);const versionRoot=this.versionRoot(owner,skill,version),relative=versionRoot+`/${pkg.name}/SKILL.md`;
    const document=serializeSkillDocument(pkg.name,pkg.description,pkg.content);const validated=validatePackage(pkg.name,document,pkg.resources);
    if(validated.content_sha256!==pkg.content_sha256)throw new SkillFileError();
    const manifest=Buffer.from(sortedJson(packageManifest(validated)));
    const receipt={content_path:relative,document_sha256:sha256(document),content_sha256:pkg.content_sha256,manifest_sha256:sha256(manifest)};
    const target=this.path(versionRoot);
    if(existsSync(target)){const existing=readPackage(join(target,pkg.name));if(existing.resources.length!==pkg.resources.length)throw new SkillFileError();const row={owner_id:owner,skill_id:skill,id:version,name:pkg.name,...receipt};if(!this.read(relative,receipt.document_sha256).equals(document)||!this.read(versionRoot+'/manifest.json',receipt.manifest_sha256).equals(manifest))throw new SkillFileError();for(const r of pkg.resources)if(!this.readResource(row,r.relative_path).equals(r.content))throw new SkillFileError();return receipt;}
    const staging=this.path(`.staging/${uuid(owner)}/${uuid(skill)}`);mkdirSync(staging,{recursive:true,mode:0o700});checkNoLinks(staging);const temporary=mkdtempSync(join(staging,'publish-'));
    try{this.write(join(temporary,pkg.name,'SKILL.md'),document);for(const r of pkg.resources)this.write(join(temporary,pkg.name,r.relative_path),r.content);this.write(join(temporary,'manifest.json'),manifest);readPackage(join(temporary,pkg.name));mkdirSync(dirname(target),{recursive:true,mode:0o700});checkNoLinks(target);renameSync(temporary,target);return receipt;}finally{rmSync(temporary,{recursive:true,force:true});}
  });}
  readManifest(row:SkillVersionFiles):SkillManifest {return safe(()=>{this.locator(row);return validateManifest(JSON.parse(decodeUtf8(this.read(this.versionRoot(row.owner_id,row.skill_id,row.id)+'/manifest.json',row.manifest_sha256))),row.name);});}
  readContent(row:SkillVersionFiles):string{return safe(()=>{const document=this.read(this.locator(row),row.document_sha256);const content=parseSkillDocument(document,row.name).content;if(sha256(content)!==row.content_sha256)throw new SkillFileError();return content;});}
  readResource(row:SkillVersionFiles,relative:string):Buffer{return safe(()=>{validateResourcePath(relative);const resource=this.readManifest(row).resources.find(r=>r.relative_path===relative);if(!resource)throw new SkillFileError();const bytes=this.read(this.locator(row).slice(0,-'SKILL.md'.length)+relative,resource.content_sha256);if(bytes.length!==resource.byte_size)throw new SkillFileError();return bytes;});}
  prepareMethods(owner:string,skill:string,version:string,methods:SkillMethod[]):{method_manifest_path:string;method_manifest_sha256:string}{return safe(()=>{
    const base=this.versionRoot(owner,skill,version);const normalized=normalizeMethods(methods);const entries=normalized.map(method=>{const body=Buffer.from(JSON.stringify(method)),relative=`methods/${method.method_id}.json`;this.immutable(base+'/'+relative,body);return {method_id:method.method_id,relative_path:relative,content_sha256:sha256(body)};});const body=Buffer.from(JSON.stringify(entries));this.immutable(base+'/methods.json',body);return {method_manifest_path:base+'/methods.json',method_manifest_sha256:sha256(body)};
  });}
  private immutable(relative:string,bytes:Buffer):void {
    if(bytes.length>MAX_RESOURCE_BYTES)throw new SkillFileError();const path=this.path(relative);
    if(existsSync(path)){if(!readBounded(path).equals(bytes))throw new SkillFileError();return;}
    mkdirSync(dirname(path),{recursive:true,mode:0o700});checkNoLinks(path);
    const temporary=mkdtempSync(join(dirname(path),'.immutable-')),staged=join(temporary,'content');
    try{this.write(staged,bytes);checkNoLinks(path);try{linkSync(staged,path);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||!readBounded(path).equals(bytes))throw error;}}finally{rmSync(temporary,{recursive:true,force:true});}
  }
  readMethods(row:SkillVersionFiles,orderedIds:string[],selectedIds?:string[]):SkillMethod[]{return safe(()=>{
    this.locator(row);if(!orderedIds.length)return [];const expected=this.versionRoot(row.owner_id,row.skill_id,row.id)+'/methods.json';if(row.method_manifest_path!==expected||!row.method_manifest_sha256)throw new SkillFileError();const entries:unknown=JSON.parse(decodeUtf8(this.read(expected,row.method_manifest_sha256)));
    if(!Array.isArray(entries)||entries.length<1||entries.length>6||entries.length!==orderedIds.length||new Set(orderedIds).size!==orderedIds.length)throw new SkillFileError();
    for(let i=0;i<entries.length;i++){const e=entries[i];if(!exactKeys(e,['method_id','relative_path','content_sha256'])||e.method_id!==orderedIds[i]||e.relative_path!==`methods/${uuid(e.method_id as string)}.json`||typeof e.content_sha256!=='string'||! /^[0-9a-f]{64}$/.test(e.content_sha256))throw new SkillFileError();}
    const selected=new Set(selectedIds??orderedIds);if([...selected].some(id=>!orderedIds.includes(id)))throw new SkillFileError();
    return entries.filter(e=>selected.has(e.method_id)).map(e=>{const method=normalizeMethods([JSON.parse(decodeUtf8(this.read(expected.slice(0,-'methods.json'.length)+e.relative_path,e.content_sha256)))])[0];if(method.method_id!==e.method_id)throw new SkillFileError();return method;});
  });}
  writeWorking(row:SkillVersionFiles):void {safe(()=>{
    this.readContent(row);const manifest=this.readManifest(row);const document=this.read(this.locator(row),row.document_sha256);const resources=manifest.resources.map(r=>({relative:r.relative_path,bytes:this.readResource(row,r.relative_path)}));
    const target=this.path(`${uuid(row.owner_id)}/${row.name}`);const staging=this.path(`.staging/${row.owner_id}/${row.skill_id}`);mkdirSync(staging,{recursive:true,mode:0o700});checkNoLinks(staging);const temporary=mkdtempSync(join(staging,'working-')),replacement=join(temporary,row.name),previous=join(temporary,'previous');
    try{this.write(join(replacement,'SKILL.md'),document);for(const r of resources)this.write(join(replacement,r.relative),r.bytes);mkdirSync(dirname(target),{recursive:true,mode:0o700});checkNoLinks(target);if(existsSync(target))renameSync(target,previous);try{renameSync(replacement,target);}catch(error){if(existsSync(previous)&&!existsSync(target))renameSync(previous,target);throw error;}}finally{rmSync(temporary,{recursive:true,force:true});}
  });}
  exportPackage(row:SkillVersionFiles,destination:string):{package_sha256:string;resource_paths:string[];destination:string} {return safe(()=>{
    const content=this.readContent(row),manifest=this.readManifest(row);
    const items=[{relative:'SKILL.md',bytes:serializeSkillDocument(row.name,manifest.description,content)},...manifest.resources.map(r=>({relative:r.relative_path,bytes:this.readResource(row,r.relative_path)}))];
    let target=resolve(destination);try{target=canonicalRoot(target);}catch{/* 父目录尚未创建，逐段检查后创建。 */}
    checkNoLinks(target);let controlled=resolve(this.root);try{controlled=canonicalRoot(controlled);}catch{/* 未创建根。 */}
    if(target===controlled||target.startsWith(controlled+'/'))throw new SkillFileError();
    for(const item of items)checkNoLinks(join(target,item.relative));
    mkdirSync(target,{recursive:true,mode:0o700});checkNoLinks(target);
    const temporary=mkdtempSync(join(target,'.export-'));
    try{for(const item of items){this.write(join(temporary,item.relative),item.bytes);const path=join(target,item.relative);checkNoLinks(path);mkdirSync(dirname(path),{recursive:true,mode:0o700});checkNoLinks(path);if(existsSync(path)&&!lstatSync(path).isFile())throw new SkillFileError();renameSync(join(temporary,item.relative),path);}}finally{rmSync(temporary,{recursive:true,force:true});}
    const hash=createHash('sha256').update('SKILL.md\0').update(items[0].bytes);
    for(const item of items.slice(1).sort((a,b)=>compareText(a.relative,b.relative)))hash.update(item.relative).update('\0').update(item.bytes).update('\0');
    return {package_sha256:hash.digest('hex'),resource_paths:manifest.resources.map(r=>r.relative_path),destination};
  });}
  scan(owner:string,excludedNames:Iterable<string>=[]):{packages:{name:string;package_path:string}[];failedNames:string[];rootFailed:boolean;failureCode:string|null} {
    const packages:{name:string;package_path:string}[]=[],failedNames:string[]=[];const excluded=new Set(excludedNames);
    try{const path=this.path(uuid(owner));if(!existsSync(path))return {packages,failedNames,rootFailed:false,failureCode:null};
      for(const entry of readdirSync(path,{withFileTypes:true})){
        if(entry.name.startsWith('.')||excluded.has(entry.name))continue;
        if(entry.isSymbolicLink()){failedNames.push(entry.name);continue;}
        if(!entry.isDirectory())continue;
        try{validateName(entry.name);packages.push({name:entry.name,package_path:this.path(owner+'/'+entry.name)});}catch{failedNames.push(entry.name);}
      }
      packages.sort((a,b)=>a.name<b.name?-1:1);return {packages,failedNames,rootFailed:false,failureCode:failedNames.length?'file_unavailable':null};
    }catch{return {packages:[],failedNames:[],rootFailed:true,failureCode:'file_unavailable'};}
  }
  /** 仅枚举受控快照定位；是否仍被数据库引用由持有 owner 锁的调用方决定。 */
  scanSnapshotDirectories(owner:string):{skill_id:string;version_id:string;relative_path:string}[]{return safe(()=>{
    const prefix=`.versions/${uuid(owner)}`,root=this.path(prefix);
    if(!existsSync(root))return [];
    const result:{skill_id:string;version_id:string;relative_path:string}[]=[];
    for(const skill of readdirSync(root,{withFileTypes:true})){
      uuid(skill.name);if(!skill.isDirectory()||skill.isSymbolicLink())throw new SkillFileError();
      const skillPath=this.path(prefix+'/'+skill.name);
      for(const version of readdirSync(skillPath,{withFileTypes:true})){
        uuid(version.name);if(!version.isDirectory()||version.isSymbolicLink())throw new SkillFileError();
        const relative_path=prefix+'/'+skill.name+'/'+version.name;this.path(relative_path);
        result.push({skill_id:skill.name,version_id:version.name,relative_path});
      }
    }
    return result.sort((a,b)=>compareText(a.relative_path,b.relative_path));
  });}
  /** 暂存只枚举技能一级目录；是否存在工作副本任务由调用方核对。 */
  scanStagingDirectories(owner:string):{skill_id:string;relative_path:string}[]{return safe(()=>{
    const prefix=`.staging/${uuid(owner)}`,root=this.path(prefix);
    if(!existsSync(root))return [];
    return readdirSync(root,{withFileTypes:true}).map(skill=>{
      uuid(skill.name);if(!skill.isDirectory()||skill.isSymbolicLink())throw new SkillFileError();
      const relative_path=prefix+'/'+skill.name;this.path(relative_path);return {skill_id:skill.name,relative_path};
    }).sort((a,b)=>compareText(a.relative_path,b.relative_path));
  });}
  discover(owner:string):{name:string;package_path:string}[]{const result=this.scan(owner);if(result.rootFailed||result.failedNames.length)throw new SkillFileError();return result.packages;}
  remove(relative:string):void {safe(()=>{validateRelative(relative);const parts=relative.split('/');if(parts[0]==='.versions'||parts[0]==='.staging'){if(parts.length<3||parts.length>4)throw new SkillFileError();parts.slice(1).forEach(uuid);}else{if(parts.length!==2)throw new SkillFileError();uuid(parts[0]);validateName(parts[1]);}const path=this.path(relative);if(!existsSync(path))return;const visit=(target:string):void=>{checkNoLinks(target);const stat=lstatSync(target);if(stat.isDirectory())for(const entry of readdirSync(target))visit(join(target,entry));else if(!stat.isFile())throw new SkillFileError();};visit(path);rmSync(path,{recursive:true,force:true});});}
}
