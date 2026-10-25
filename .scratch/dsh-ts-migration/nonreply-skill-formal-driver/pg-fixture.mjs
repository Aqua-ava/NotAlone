/** 只建本轮随机合成库；空库SQL夹具无Python，不作为产品迁移器。 */
import assert from 'node:assert/strict';
import pg from '../../../backend-ts/node_modules/pg/lib/index.js';
import {mkdtemp,chmod,readdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {sha} from './snapshot.mjs';
export async function createFixture(receipts,rawDirectory){
  const directory=await mkdtemp(join(tmpdir(),'na-skill-pg-'));await chmod(directory,0o700);
  const database='notalone_ts_host_'+randomUUID().replaceAll('-','')+'_test';
  const admin=new pg.Client({host:'/tmp',database:'postgres'});
  const receipt={database,directory,created:false,dropped:false,python_processes:0};receipts.push(receipt);
  const persist=()=>writeFile(join(rawDirectory,'fixtures.json'),JSON.stringify(receipts),{mode:0o600});
  let client,closed=false,adminConnected=false,clientEnded=false;
  async function close(){
    if(closed)return;if(!clientEnded){await client?.end();clientEnded=true;}
    let connections=0;
    // 子进程exit与PG后端撤下不在同一瞬间；仅对本轮库做一次有界收尾等待。
    for(let check=0;adminConnected&&check<30;check++){
      connections=(await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1',[database])).rows[0].n;
      if(connections===0)break;await new Promise(done=>setTimeout(done,50));
    }
    assert.equal(connections,0,'owned_database_connections_alive');
    if(receipt.created)await admin.query('DROP DATABASE "'+database+'"');
    receipt.dropped=true;receipt.remaining_connections=connections;
    receipt.database_absent=adminConnected?!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount:!receipt.created;
    await rm(directory,{recursive:true});await persist();await admin.end();
    closed=true;
  }
  try{
    await admin.connect();adminConnected=true;
    assert.match(database,/^notalone_ts_host_[a-f0-9]+_test$/);
    await admin.query('CREATE DATABASE "'+database+'" TEMPLATE template0');receipt.created=true;await persist();
    client=new pg.Client({host:'/tmp',database});await client.connect();
    await client.query('CREATE TABLE public.notalone_schema_migration(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    const migrations=new URL('../../../backend/database/migrations/',import.meta.url);
    const names=(await readdir(migrations)).filter(name=>name.endsWith('.sql')).sort();assert.equal(names.length,116);
    for(const [index,name] of names.entries()){
      assert.ok(name.startsWith(String(index+1).padStart(3,'0')+'_'),'fixture_migration_order');
      const content=await readFile(new URL(name,migrations)),lines=content.toString().trim().split('\n');
      while(lines[0]?.trim().startsWith('--'))lines.shift();while(lines.at(-1)?.trim().startsWith('--'))lines.pop();
      let body=lines.join('\n').trim();if(body.startsWith('BEGIN;')&&body.endsWith('COMMIT;'))body=body.slice(6,-7).trim();
      await client.query('BEGIN');
      try{await client.query(body);await client.query('INSERT INTO public.notalone_schema_migration(name,checksum)VALUES($1,$2)',[name,sha(content)]);await client.query('COMMIT');}
      catch(error){await client.query('ROLLBACK');throw error;}
    }
    receipt.migrations=names.length;receipt.empty_103_upgrade_noop=true;await persist();
    const options={envFilePath:join(directory,'unused-synthetic-config'),migrationsDirectory:migrations.pathname,
      environment:{NOTALONE_DISABLE_DOTENV:'1',NOTALONE_DATABASE_URL:'host=/tmp dbname='+database,HOME:directory}};
    return {client,directory,database,options,close};
  }catch(error){await writeFile(join(rawDirectory,'fixture-failure.log'),String(error.stack??error),{mode:0o600});await close();throw error;}
}
