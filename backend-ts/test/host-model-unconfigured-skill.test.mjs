/** 两个控制面同时使用实际官方profile；无模型key、仅合成本机资料。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {appendFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createUnconfiguredFixture} from './host-model-unconfigured-fixture.mjs';
import {start} from './contact-context-support.mjs';

test('官方profile中TS未配置回复与TS Skill管理同时工作，管理不消费模型收据',{timeout:60000},async t=>{
 const f=await createUnconfiguredFixture();
 t.after(async()=>{try{for(const host of f.hosts??[])assert.equal(await host.terminate(),true);}finally{await f.close();}});
 const owner=randomUUID();await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成控制面本人')",[owner]);
 await appendFile(f.envFilePath,`NOTALONE_OWNER_ID=${owner}\nNOTALONE_REPLY_RUNTIME=typescript\n`);
 const packageRoot=join(f.directory,'gentle-reply');await mkdir(packageRoot);
 await writeFile(join(packageRoot,'SKILL.md'),'---\nname: gentle-reply\ndescription: "合成关系回应"\n---\n\n先核实感受。\n');
 const app=await start(t,f,{NOTALONE_REPLY_RUNTIME:'typescript'});
 const status=await app.request('/api/runtime/status');assert.equal(status.status,200);
 assert.equal(status.data.ownership.skills,'typescript');assert.equal(status.data.ownership.replies,'typescript');
 assert.deepEqual(status.data.reply,{runtime:'typescript',state:'unconfigured',reason:'reply_model_unconfigured'});
 assert.equal((await app.request('/api/setup/status')).status,200);
 assert.equal((await app.request('/api/skills/health')).data.state,'ok');
 assert.equal((await app.request('/api/runtime/skill-management/synchronize',{owner_id:owner})).status,404);
 assert.equal((await app.request('/internal/reply/prepare',{})).status,401);
 assert.deepEqual(await app.request('/api/reply/generate',{}),{status:503,data:{error:'reply_unavailable'}});
 const imported=await app.request('/api/skills/import',{package_path:packageRoot});assert.equal(imported.status,200);
 const id=imported.data.skill_id;assert.equal((await app.request(`/api/skills/${id}/preview`)).data.document,'先核实感受。\n');
 assert.equal((await app.request(`/api/skills/${id}/delete`,{})).data.deleted,true);
 assert.equal((await f.client.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,0);
});
