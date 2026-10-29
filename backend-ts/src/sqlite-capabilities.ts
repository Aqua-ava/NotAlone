import path from 'node:path';
export interface SqliteCapabilitiesConfiguration {
 capabilities: ['contacts'] | ['contacts','skills'];
 skillPackageRoot?: string;
}
/** 只用于显式test开发配置；Skill根限本次隔离userData内，不从旧owner或环境猜关联。 */
export function readSqliteCapabilities(value:unknown,skillPackageRoot:unknown,userData:string):SqliteCapabilitiesConfiguration|undefined {
 if(!Array.isArray(value)||value[0]!=='contacts'||!(value.length===1||value.length===2&&value[1]==='skills'))return undefined;
 if(value.length===1)return skillPackageRoot===undefined?{capabilities:['contacts']}:undefined;
 if(typeof skillPackageRoot!=='string'||!path.isAbsolute(skillPackageRoot)||path.resolve(skillPackageRoot)!==skillPackageRoot)return undefined;
 const relative=path.relative(userData,skillPackageRoot);
 if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))return undefined;
 return {capabilities:['contacts','skills'],skillPackageRoot};
}
