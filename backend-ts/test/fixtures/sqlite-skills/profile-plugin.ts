/** 正式profile合成入口；仅替换宿主认证、调用追踪和外部模型配置。 */
import type {Context} from '@deepseek-ai/cordis';
import {createScope} from '@deepseek-ai/dsh-scope';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {join} from 'node:path';
import {SqliteStorage} from '../../../src/storage/sqlite/client.ts';
import {TestSkillLibrary} from './test-library.mjs';
import {openSqliteSkillRun} from '../../../src/skills/sqlite/provider.ts';
import {SqliteSkillHttp} from '../../../src/skills/sqlite/http.ts';
export const name='notalone-sqlite-skills-profile-test';
export const inject=['skills'];
export async function apply(ctx: Context): Promise<void> {
 const dir=process.env.NOTALONE_SKILL_TEST_DIR!;
 const storage=await SqliteStorage.open({userData:dir,intent:'create',role:'test',registryModule:new URL('./registry.mjs',import.meta.url).href});
 await storage.execute('fixture.owner',{ownerId:'owner-a'});
 const library=new TestSkillLibrary(storage,'owner-a',join(dir,'originals'),{readerBinary:process.env.NOTALONE_SKILL_TEST_READER});
 const skills=new SqliteSkillHttp(library,req=>req.headers.authorization==='Bearer profile-only'&&!req.headers.origin);
 let sequence=0;
 const server=createServer(async(req,res)=>{
  if(await skills.handle(req,res))return;
  res.setHeader('content-type','application/json');
  try {
   let raw='';for await(const part of req)raw+=part;const input=raw?JSON.parse(raw):{};
   let result: unknown;
   if(req.url==='/cached-status')result={ready:true};
   else if(req.url==='/state')result=await library.inspect();
   else if(req.url==='/discover')result=await library.discover(input.name);
   else if(req.url==='/enabled')result=await library.setEnabled(input.id,BigInt(input.head),input.state);
   else if(req.url==='/verify')result=await library.verify(input.id,BigInt(input.head));
   else if(req.url==='/check')result=await storage.check();
   else if(req.url==='/load'||req.url==='/late-load'||req.url==='/load-resource'){
    const scope={ownerId:'owner-a',contactId:input.contactId??'contact-a',callId:`profile-${++sequence}`};
    if(scope.contactId==='contact-a')await storage.execute('fixture.scope',scope);
    const key={},layer=createScope(ctx,key);
    try {
     const run=await openSqliteSkillRun(library,scope,{
      assertCurrent:(scope,revision)=>storage.execute('fixture.checkScope',{scope,revision}),recordSelection:async()=>{},
      recordInput:async actual=>{
       if(req.url==='/late-load'){const current=await library.get(input.id);await library.setEnabled(current.id,current.headRevision,'disabled');}
       await storage.execute('fixture.input',actual);
      },
     });
     run.mount(layer.ctx);
     const content=await ctx.get('skills')!.get('gentle',{scope:key});
     if(!content)throw new Error('fixture_skill_unavailable');
     if(req.url==='/load-resource'){
      const resource=await run.readLoadedResource('gentle',input.path);
      const loaded=run.loadedSkills[0]!;
      result={content:content?.content,resource,loaded:{name:loaded.name,packageId:loaded.anchor.packageId,revisionNo:loaded.anchor.revisionNo,resources:loaded.resources},inputs:await storage.execute('fixture.inputs',scope),hostCatalog:(await ctx.get('skills')!.snapshot()).skills.length};
     }else result={content:content?.content,input:(await storage.execute<any[]>('fixture.inputs',scope))[0],hostCatalog:(await ctx.get('skills')!.snapshot()).skills.length};
    }finally{await layer.dispose();}
   }else throw new Error('fixture_route_denied');
   res.end(JSON.stringify(result,(_key,value)=>typeof value==='bigint'?value.toString():value));
  }catch(error){res.statusCode=409;res.end(JSON.stringify({code:(error as {code?:string}).code??'fixture_denied'}));}
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 ctx.effect(()=>async()=>{server.closeAllConnections();server.close();await library.close();await storage.close();});
 console.log(`SQLITE_SKILL_READY http://127.0.0.1:${(server.address() as {port:number}).port}`);
}
