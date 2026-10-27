import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pureTsFixture} from './pure-ts-runtime-fixture.mjs';
test('非记忆后台任务进度通过认证 SSE发布，停止结果可从公开任务重读',{timeout:15000},async t=>{
 const f=await pureTsFixture(t),owner=randomUUID(),contact=randomUUID(),task=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name)VALUES($1,'合成本人')",[owner]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人')",[contact,owner]);
 await f.client.query("INSERT INTO background_task(id,owner_id,contact_id,task_type,status,current_step,message_count)VALUES($1,$2,$3,'skill_learning','queued','propose_skill',0)",[task,owner,contact]);
 await f.client.query("INSERT INTO background_task_step(task_id,step_name,step_order,total_count)VALUES($1,'propose_skill',1,0)",[task]);
 const app=await f.start({NOTALONE_OWNER_ID:owner});
 const controller=new AbortController();
 const stream=await fetch(`http://${app.connection.address}/api/events`,{headers:{Authorization:`Bearer ${app.connection.token}`},signal:controller.signal});const reader=stream.body.getReader();
 assert.equal((await app.request('/api/tasks/stop',{contact_id:contact,task_id:task})).status,200);
 let text='';for(let i=0;i<10&&!text.includes('"status":"cancelled"');i++)text+=new TextDecoder().decode((await reader.read()).value);
 assert.match(text,/event: task.progress/);assert.match(text,new RegExp(task));assert.match(text,/"status":"cancelled"/);
 const listed=await app.request(`/api/tasks?contact_id=${contact}`);assert.equal(listed.data.tasks[0].status,'cancelled');
 controller.abort();await reader.cancel().catch(()=>{});await app.request('/api/runtime/shutdown',{});assert.equal(await app.host.waitForExit(7000),true);
});
