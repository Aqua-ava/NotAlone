/** 独立且有界的诊断／准备入口；无模型、任务或隐式子进程。 */
import {pathToFileURL} from 'node:url';
import {realpath} from 'node:fs/promises';
import {HostStorage,HostStorageError} from './platform/database/host-storage.ts';
import {prepareDatabaseSchema,type SchemaPrepareResult} from './platform/database/schema-prepare.ts';
export async function runSchemaDiagnostic(envFilePath:string,migrationsDirectory:string,environment:NodeJS.ProcessEnv,prepare=false):Promise<{code:string}|SchemaPrepareResult>{
 let storage:HostStorage|undefined;
 try{
  storage=await HostStorage.open({envFilePath,migrationsDirectory,environment});
  if(!prepare)return await storage.compatibility();
  const databaseUrl=storage.databaseUrl,values=storage.runtimeEnvironment();await storage.close();storage=undefined;
  return await prepareDatabaseSchema({databaseUrl,migrationsDirectory,environment:values});
 }catch(error){return {code:error instanceof HostStorageError?error.code:'diagnostic_failed',...(prepare?{applied:[]}: {})};}
 finally{await storage?.close();}
}
async function main():Promise<void>{
 const args=process.argv.slice(2),index=args.indexOf('--migrations');
 const valid=index>=0&&Boolean(args[index+1])&&args.length===(args.includes('--prepare')?3:2)&&args.every((arg,i)=>i===index||i===index+1||arg==='--prepare');
 const result=valid?await runSchemaDiagnostic(process.env.NOTALONE_ENV_FILE??'',args[index+1],process.env,args.includes('--prepare')):{code:'diagnostic_failed'};
 process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.code==='ready'?0:1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(await realpath(process.argv[1])).href)await main();
