import {randomUUID} from 'node:crypto';
import {writeFile,appendFile,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {start} from './contact-context-support.mjs';

export async function createForegroundFixture(t,{launch=true}={}){
 const f=await createStorageFixture();t.after(async()=>{for(const h of f.hosts??[])await h.terminate();await f.close();});
 const owner=randomUUID(),contact=randomUUID(),binding=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成甲友')",[contact,owner]);
 await f.client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','fixture-account','合成账号')",[owner]);
 await f.client.query("INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator,display_name) VALUES($1,$2,$3,'wechat','fixture-account','fixture-a','合成甲友')",[binding,owner,contact]);
 await f.client.query('INSERT INTO front_sync_state(owner_id,enabled) VALUES($1,true)',[owner]);
 const dataPath=join(f.directory,'synthetic-observation.json'),sessionsPath=join(f.directory,'synthetic-sessions.json');
 await writeFile(dataPath,JSON.stringify({name:'合成甲友',confidence:0.99}));
 await writeFile(sessionsPath,JSON.stringify([{username:'fixture-a',display_name:'合成甲友',chat_type:'private',last_timestamp:0}]));
 const cli=join(f.directory,'synthetic-cli'),probe=join(f.directory,'synthetic-probe');
 await writeFile(cli,`#!${process.execPath}\nconst fs=await import('node:fs');const command=process.argv[2];if(command==='status')console.log(JSON.stringify({ok:true,data:{status:{account:{identity_configured:true,schema2_ready:true},live_read_ok:true,readiness:'ready',mode:{strict_read_only:true},account_debug:{wxid:'fixture-account'}}}}));else if(command==='sessions')console.log(JSON.stringify({ok:true,data:{sessions:JSON.parse(fs.readFileSync(${JSON.stringify(sessionsPath)},'utf8'))}}));else process.exit(2);`);
 await writeFile(probe,`#!${process.execPath}\nconst fs=await import('node:fs');const rl=await import('node:readline');if(!process.argv.includes('--session-worker'))process.exit(2);console.log(JSON.stringify({version:1,event:'ready'}));for await(const line of rl.createInterface({input:process.stdin})){const r=JSON.parse(line),d=JSON.parse(fs.readFileSync(${JSON.stringify(dataPath)},'utf8'));if(d.hang){fs.writeFileSync(${JSON.stringify(join(f.directory,'probe-started'))},'started');await new Promise(resolve=>setTimeout(resolve,10000));}const result=d.error?{ok:false,error:d.error}:{ok:true,wechat_in_front:d.front!==false,...(d.front===false?{}:{capture_version:'automatic-header-v4',captured_at:new Date().toISOString(),display_name:d.name,quality:{layout_verified:true,name_complete:true,display_name_confidence:d.confidence}})};console.log(JSON.stringify({version:1,request_id:r.request_id,result}));}`);
 await chmod(cli,0o700);await chmod(probe,0o700);
 await appendFile(f.envFilePath,`NOTALONE_OWNER_ID=${owner}\nNOTALONE_WECHAT_CLI=${cli}\nNOTALONE_SYNC_PROBE=${probe}\n`);
 const app=launch?await start(t,f,{},resolve(new URL('../..',import.meta.url).pathname)):undefined;
 return {...f,owner,contact,binding,app,cli,probe,setProbe:data=>writeFile(dataPath,JSON.stringify(data)),setSessions:rows=>writeFile(sessionsPath,JSON.stringify(rows))};
}
