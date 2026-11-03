/** 固定用途原生只读适配器；不是模型文件工具，不接受任意文件路径。 */
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalRoot,decodeUtf8,sha256,validateName,validatePackage,validateResourcePath,type SkillPackage,type SkillResource} from './skill-package.ts';
const binary=fileURLToPath(new URL('../../../native/skill-read/.build/skill-read',import.meta.url));
export class SecureSkillReadError extends Error {
  readonly code: string;
  constructor(code: string) {super(code);this.code=code;}
}
const knownErrors=new Set(['skill_directory_unavailable','skill_directory_conflict','skill_package_invalid']);
type Identity=[string,string];
function identity(value:unknown): Identity {
  if(!Array.isArray(value)||value.length!==2||value.some(part=>typeof part!=='string'||!/^[0-9]+$/.test(part)))throw new SecureSkillReadError('skill_package_invalid');
  return value as Identity;
}
export class SecureSkillDirectory {
  readonly root: string;
  private readonly rootIdentity: Identity;
  private readonly readerBinary: string;
  constructor(root:string,readerBinary=binary,expectedRootIdentity?:readonly[string,string]) {
    this.readerBinary=readerBinary;
    this.root=canonicalRoot(root);
    this.rootIdentity=identity(this.invoke('root','',undefined).identity);
    if(expectedRootIdentity&&JSON.stringify(this.rootIdentity)!==JSON.stringify(identity(expectedRootIdentity)))throw new SecureSkillReadError('skill_directory_conflict');
  }
  names(): string[] {
    const value=this.invoke('list','');
    if(!Array.isArray(value.names)||new Set(value.names).size!==value.names.length)throw new SecureSkillReadError('skill_package_invalid');
    for(const name of value.names)validateName(name);
    return value.names;
  }
  directoryIdentity(name:string): string {
    validateName(name);
    return this.locator(name,identity(this.invoke('identity',name).identity));
  }
  snapshot(name:string,expectedIdentity:string): {directoryIdentity:string;document:Buffer;pkg:SkillPackage} {
    validateName(name);
    let expected:Identity;
    try {const value=JSON.parse(expectedIdentity);if(!Array.isArray(value)||value.length!==3||value[0]!==join(this.root,name))throw new Error();expected=identity(value.slice(1));}
    catch{throw new SecureSkillReadError('skill_directory_conflict');}
    const result=this.invoke('package',name,expected);
    const current=this.locator(name,identity(result.identity));
    if(current!==expectedIdentity)throw new SecureSkillReadError('skill_directory_conflict');
    if(!Array.isArray(result.files)||result.files.length<1||result.files.length>101)throw new SecureSkillReadError('skill_package_invalid');
    const resources:SkillResource[]=[];let document:Buffer|undefined;
    const media:Record<string,string>={md:'text/markdown',markdown:'text/markdown',txt:'text/plain',csv:'text/csv',json:'application/json',yaml:'application/yaml',yml:'application/yaml',xml:'application/xml',svg:'image/svg+xml',template:'text/plain',tmpl:'text/plain'};
    for(const file of result.files) {
      if(!file||typeof file.path!=='string'||typeof file.hex!=='string'||file.hex.length>2*1024*1024||file.hex.length%2||!/^[a-f0-9]*$/.test(file.hex))throw new SecureSkillReadError('skill_package_invalid');
      const bytes=Buffer.from(file.hex,'hex');
      if(file.path==='SKILL.md'){if(document)throw new SecureSkillReadError('skill_package_invalid');document=bytes;}
      else {validateResourcePath(file.path);resources.push({relative_path:file.path,resource_kind:file.path.startsWith('references/')?'reference':'asset',media_type:media[file.path.split('.').at(-1)!.toLowerCase()],content:bytes,content_sha256:sha256(bytes)});}
    }
    if(!document)throw new SecureSkillReadError('skill_package_invalid');
    return {directoryIdentity:current,document,pkg:validatePackage(name,document,resources)};
  }
  private locator(name:string,value:Identity): string {return JSON.stringify([join(this.root,name),...value]);}
  private invoke(operation:'root'|'list'|'identity'|'package',name:string,expected?:Identity): Record<string,any> {
    const result=spawnSync(this.readerBinary,[operation,this.root,name,...(this.rootIdentity??['-','-']),...(expected??['-','-'])],{timeout:5000,maxBuffer:12*1024*1024,env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','ignore']});
    if(result.error)throw new SecureSkillReadError('skill_reader_unavailable');
    let value:Record<string,any>;
    try {value=JSON.parse(decodeUtf8(result.stdout));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();}
    catch{throw new SecureSkillReadError('skill_package_invalid');}
    if(result.status!==0||value.error)throw new SecureSkillReadError(knownErrors.has(value.error)?value.error:'skill_package_invalid');
    return value;
  }
}
