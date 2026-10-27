import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { HostStorage } from '../src/platform/database/host-storage.ts';
import { createStorageFixture } from './host-storage-fixture.mjs';

test('数据库已中止事务时不能把回滚命令当成提交成功', async t => {
  const fixture=await createStorageFixture();
  const storage=await HostStorage.open(fixture.options);
  const owner=randomUUID(), observed={};
  const query=pg.Client.prototype.query;
  try {
    await fixture.client.query("INSERT INTO public.owner(id,display_name) VALUES($1,'提交前原值')",[owner]);
    pg.Client.prototype.query=function(...args) {
      const result=Reflect.apply(query,this,args);
      if (args[0]==='COMMIT' && result && typeof result.then==='function') result.then(value=>{observed.commit_command=value.command;},()=>{});
      return result;
    };
    let failure;
    try {
      observed.result=await storage.businessTransaction(async client=>{
        await client.query("UPDATE public.owner SET display_name='不可丢失的写入' WHERE id=$1",[owner]);
        try { await client.query('SELECT 1/0'); }
        catch(error) { observed.server_code=error.code; }
        return '已完成';
      });
    } catch(error) { failure=error; observed.failure_code=error.code; }
    observed.persisted=(await fixture.client.query('SELECT display_name FROM public.owner WHERE id=$1',[owner])).rows[0].display_name;
    assert.equal(observed.server_code,'22012');
    assert.equal(observed.commit_command,'ROLLBACK');
    assert.equal(observed.persisted,'提交前原值');
    assert.equal(failure?.code,'database_unavailable','数据库实际回滚时不能对调用方报告成功');
  } finally {
    pg.Client.prototype.query=query;
    t.diagnostic('提交结果与实际状态 '+JSON.stringify(observed));
    await storage.close(); await fixture.close();
  }
});

test('保存点已恢复的查询失败可正常提交其余写入', async ()=>{
  const fixture=await createStorageFixture();
  const storage=await HostStorage.open(fixture.options);
  const owner=randomUUID();
  try {
    await fixture.client.query("INSERT INTO public.owner(id,display_name) VALUES($1,'原值')",[owner]);
    const value=await storage.businessTransaction(async client=>{
      await client.query('SAVEPOINT synthetic_optional');
      await assert.rejects(client.query('SELECT 1/0'),{code:'22012'});
      await client.query('ROLLBACK TO SAVEPOINT synthetic_optional');
      await client.query('RELEASE SAVEPOINT synthetic_optional');
      await client.query("UPDATE public.owner SET display_name='成功提交' WHERE id=$1",[owner]);
      return '已完成';
    });
    assert.equal(value,'已完成');
    assert.equal((await fixture.client.query('SELECT display_name FROM public.owner WHERE id=$1',[owner])).rows[0].display_name,'成功提交');
  } finally {await storage.close();await fixture.close();}
});
