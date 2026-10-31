import path from 'node:path';
export interface SqliteCapabilitiesConfiguration {
 capabilities: ('contacts'|'skills'|'history'|'discussions'|'memory')[];
 skillPackageRoot?: string;
}
/** 固定顺序保留既有contacts/skills合同；history不授权真实渠道或新增范围。 */
export function readSqliteCapabilities(value:unknown,skillPackageRoot:unknown,userData:string):SqliteCapabilitiesConfiguration|undefined {
 const base=[['contacts'],['contacts','skills'],['contacts','history'],['contacts','skills','history']];
 const supported=[...base,...base.map(shape=>[...shape,'discussions']),...base.map(shape=>[...shape,'memory']),...base.map(shape=>[...shape,'discussions','memory'])];
 if(!Array.isArray(value)||!supported.some(shape=>shape.length===value.length&&shape.every((entry,index)=>entry===value[index])))return undefined;
 const capabilities=value.slice() as SqliteCapabilitiesConfiguration['capabilities'];
 if(!value.includes('skills'))return skillPackageRoot===undefined?{capabilities}:undefined;
 if(typeof skillPackageRoot!=='string'||!path.isAbsolute(skillPackageRoot)||path.resolve(skillPackageRoot)!==skillPackageRoot)return undefined;
 // 宿主可配置外部Skill根；原件仍与App受管删除区隔离。
 const relative=path.relative(userData,skillPackageRoot);
 if(!relative)return undefined;
 if(relative.split(path.sep)[0].toLowerCase()==='managed')return undefined;
 return {capabilities,skillPackageRoot};
}
