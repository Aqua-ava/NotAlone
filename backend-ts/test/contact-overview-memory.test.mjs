import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStorageFixture } from './host-storage-fixture.mjs';
import { projectOverviewMemory } from '../src/contact-overview-memory.ts';

test('合成PG：手录关系资料保持微秒和稳定偏好，不将文档日期当消息时间', async () => {
  const f = await createStorageFixture();
  const owner = randomUUID(), contact = randomUUID(), id = randomUUID();
  try {
    await f.client.query("SET TIME ZONE 'UTC'");
    await f.client.query('INSERT INTO public.owner(id,display_name) VALUES($1,$2)', [owner,'合成本人']);
    await f.client.query('INSERT INTO public.contact(id,owner_id,display_name) VALUES($1,$2,$3)', [contact,owner,'合成联系人']);
    await f.client.query("INSERT INTO public.confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method,created_at) VALUES($1,$2,$3,'喜欢清淡食物','preference',$4,'manual','2026-10-01T01:02:03.123456Z')", [id,owner,contact,[randomUUID()]]);
    const row = (await f.client.query('SELECT to_jsonb(m) AS value FROM public.confirmed_memory m WHERE id=$1',[id])).rows[0].value;
    const result = await projectOverviewMemory(f.client,row);
    assert.equal(result.payload.memory_id,id);
    assert.equal(result.payload.timing.recorded_at,'2026-10-01T01:02:03.123456+00:00');
    assert.equal(result.payload.timing.current_status,'stable');
    assert.equal(result.payload.timing.source_time_complete,false);
    assert.equal(result.payload.timing.source_started_at,null);
    assert.equal(result.payload.can_revert_auto_update,false);
    assert.equal(result.payload.version_evidence_source_current,false);
    for(const confidence of [1,0.5,0.00001,1e-7]) {
      await f.client.query('UPDATE public.confirmed_memory SET confidence=$2 WHERE id=$1',[id,confidence]);
      const current=(await f.client.query('SELECT to_jsonb(m) AS value FROM public.confirmed_memory m WHERE id=$1',[id])).rows[0].value;
      const digest=execFileSync(join(homedir(),'miniconda3/envs/NotAlone/bin/python'), ['-c',
        "import sys,psycopg; from psycopg.rows import dict_row; from notalone.persistence.memory_versions import raw_memory,version_record_digest; c=psycopg.connect('host=/tmp dbname='+sys.argv[1],row_factory=dict_row); c.execute(\"SET TIME ZONE 'UTC'\"); row=c.execute('SELECT * FROM public.confirmed_memory WHERE id=%s',(sys.argv[2],)).fetchone(); print(version_record_digest(raw_memory(row),current_projection=True)); c.close()",
        f.client.database,id], {env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},encoding:'utf8'}).trim();
      assert.equal((await projectOverviewMemory(f.client,current)).recordDigest,digest,`confidence=${confidence}`);
    }

    const event = { version:1,stage:'agreed',stage_evidence:[{message_id:randomUUID(),char_start:0,char_end:2}],
      stage_verified:true,occurrence_start:null,occurrence_end:null,occurrence_evidence:[],occurrence_verified:false };
    const unbound = await projectOverviewMemory(f.client,{...row,event});
    assert.equal(unbound.payload.event.stage,'agreed');
    assert.equal(unbound.payload.event.stage_verified,false,'旧标志不证明当前来源有效');
    const cases = [
      ['common_fact','毕业于合成大学'], ['common_fact','出生于1990年'], ['common_fact','出生于2999年'],
      ['common_fact','曾经毕业于合成大学'], ['common_fact','计划毕业于合成大学'], ['common_fact','未取得资格'],
      ['common_fact','毕业于合成大学，但是现在任职合成公司'], ['common_fact','出生于合成市，毕业于合成大学'],
      ['preference','喜欢清淡食物'], ['preference','今天喜欢清淡食物'], ['taboo','不喜欢被催促'],
      ['recent_state','目前在休假'], ['relationship_note','双方最近相识'], ['common_fact','拥有硕士学位'],
    ];
    const oracle = JSON.parse(execFileSync(join(homedir(),'miniconda3/envs/NotAlone/bin/python'), ['-c',
      'import sys,json; from notalone.memory.current_status import project_current_status; from notalone.memory.timing import MemoryTiming; print(json.dumps([project_current_status(MemoryTiming(),category=c,text=t).to_payload() for c,t in json.loads(sys.argv[1])]))',
      JSON.stringify(cases)], {env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},encoding:'utf8'}));
    for (let i=0;i<cases.length;i++) {
      const actual = await projectOverviewMemory(f.client,{...row,category:cases[i][0],text_content:cases[i][1]});
      assert.equal(actual.timing.current_status,oracle[i].current_status,cases[i][1]);
      assert.equal(actual.timing.current_status_reason,oracle[i].current_status_reason,cases[i][1]);
    }
    for (const [patch,status] of [
      [{category:'common_fact',text_content:'毕业于合成大学'},'stable'],
      [{category:'common_fact',text_content:'目前住在合成城市'},'current_unverified'],
      [{invalid_at:'2000-01-01T00:00:00Z'},'historical'],
      [{valid_at:'2999-01-01T00:00:00Z'},'current_unverified'],
      [{conditions:{version:1,items:[{text:'合成条件',evidence:[],source_supported:false}]}},'current_unverified'],
    ]) {
      assert.equal((await projectOverviewMemory(f.client,{...row,...patch})).timing.current_status,status);
    }


  } finally { await f.close(); }
});
