import path from 'node:path';
export interface SqliteCapabilitiesConfiguration {
 capabilities: ['contacts'] | ['contacts','skills'] | ['contacts','history'] | ['contacts','skills','history'];
 skillPackageRoot?: string;
}
/** 固定顺序保留既有contacts/skills合同；history不授权真实渠道或新增范围。 */
export function readSqliteCapabilities(value:unknown,skillPackageRoot:unknown,userData:string):SqliteCapabilitiesConfiguration|undefined {
 const supported=[['contacts'],['contacts','skills'],['contacts','history'],['contacts','skills','history']];
 if(!Array.isArray(value)||!supported.some(shape=>shape.length===value.length&&shape.every((entry,index)=>entry===value[index])))return undefined;
 const capabilities=value.slice() as SqliteCapabilitiesConfiguration['capabilities'];
 if(!value.includes('skills'))return skillPackageRoot===undefined?{capabilities}:undefined;
 if(typeof skillPackageRoot!=='string'||!path.isAbsolute(skillPackageRoot)||path.resolve(skillPackageRoot)!==skillPackageRoot)return undefined;
 const relative=path.relative(userData,skillPackageRoot);
 if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))return undefined;
 if(relative.split(path.sep)[0].toLowerCase()==='managed')return undefined;
 return {capabilities,skillPackageRoot};
}
