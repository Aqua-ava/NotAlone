import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createStorageFixture } from './host-storage-fixture.mjs';
import { start } from './contact-context-support.mjs';

test('官方profile公开Skill管理由TS唯一承接并保持HTTP契约',async t=>{
 const f=await createStorageFixture();
 t.after(async()=>{for(const host of f.hosts??[])assert.equal(await host.terminate(),true);await f.close();});
 const owner=randomUUID();await f.client.query('INSERT INTO public.owner(id,display_name) VALUES($1,$2)',[owner,'合成用户']);
 await appendFile(f.envFilePath,`NOTALONE_OWNER_ID=${owner}\n`);
 const path=join(f.directory,'gentle-reply');await mkdir(path);await writeFile(join(path,'SKILL.md'),'---\nname: gentle-reply\ndescription: "温和回应"\n---\n\n回应感受。\n');
 const app=await start(t,f);
 const status=await app.request('/api/runtime/status');assert.equal(status.status,200);assert.equal(status.data.runtime,'dsh');
 assert.equal(status.data.ownership.skills,'typescript','不可借旧Python路由通过TS迁移验收');
 assert.equal((await app.request('/api/skills/health')).data.state,'ok');
 assert.equal((await app.request('/api/runtime/skill-management/synchronize',{owner_id:owner})).status,401);
 const imported=await app.request('/api/skills/import',{package_path:path});assert.equal(imported.status,200);assert.equal(imported.data.version_number,1);
 const duplicate=await app.request('/api/skills/import',{package_path:path});assert.deepEqual(duplicate,{status:409,data:{error:'skill_import_rejected',reason:'package_invalid'}});
 const id=imported.data.skill_id;
 assert.equal((await app.request('/api/skills')).data.skills[0].skill_id,id);
 assert.equal((await app.request(`/api/skills/${id}/preview`)).data.document,'回应感受。\n');
 assert.equal((await app.request(`/api/skills/${id}/disable`,{})).data.status,'disabled');
 assert.equal((await app.request(`/api/skills/${id}/enable`,{})).data.status,'active');
 assert.equal((await app.request(`/api/skills/${id}/delete`,{})).data.deleted,true);
 assert.equal((await app.request('/api/skills')).data.skills[0].status,'deleted');
 assert.equal((await app.request(`/api/skills/${id}/enable`,{})).status,409);
});

test('无owner官方profile仍启动，Skill不可用直到原setup后重启',async t=>{
 const f=await createStorageFixture();t.after(async()=>{for(const host of f.hosts??[])assert.equal(await host.terminate(),true);await f.close();});
 const app=await start(t,f);assert.equal((await app.request('/api/runtime/status')).data.state,'running');
 assert.equal((await app.request('/api/skills')).status,503);assert.equal((await app.request('/api/skills/health')).status,503);
 assert.equal((await app.request('/api/setup/status')).status,200);await app.request('/api/runtime/shutdown',{});assert.equal(await app.host.waitForExit(7000),true);
});
