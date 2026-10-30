import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NarrowWechatClient } from '../src/history/wechat/native-client.ts';
import { loadNarrowWechatOptions } from '../src/history/wechat/artifacts.ts';
import { createWechatContactMetadata } from '../src/contacts/sqlite/wechat-metadata.ts';
import { SqliteContactService } from '../src/contacts/sqlite/service.ts';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { createServer } from 'node:http';
import { SqliteContactHttp } from '../src/contacts/sqlite/http.ts';
import { authorizeSqliteRequest } from '../src/sqlite-host-plugin.ts';

const digest = value => createHash('sha256').update(value).digest('hex');
const accountKey = 'synthetic-configured-owner_full', generation = 'a'.repeat(64);
async function fixture(t, mode = 'normal') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'notalone-account-metadata-')));
  await mkdir(join(root, 'bin')); await mkdir(join(root, 'lib'));
  const executable = join(root, 'bin', 'wx-cli'), stateFile = join(root, 'state.json'), logFile = join(root, 'requests'), pidFile = join(root, 'pid');
  await writeFile(stateFile, JSON.stringify({mode,account:accountKey,generation}));
  const script = `#!${process.execPath}
const fs=require('node:fs'),crypto=require('node:crypto'),readline=require('node:readline');
const stateFile=${JSON.stringify(stateFile)},logFile=${JSON.stringify(logFile)},pidFile=${JSON.stringify(pidFile)};
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');fs.writeFileSync(pidFile,String(process.pid));
if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['notalone-history']))process.exit(91);
const cli=hash(fs.readFileSync(process.argv[1])),wcdb=hash(fs.readFileSync(${JSON.stringify(join(root,'lib','libWCDB.dylib'))}));
const account=s=>({format:'wechat-account-metadata-v1',status:s.mode==='unknown-version'?'unverified':'verified',reason:s.mode==='unknown-version'?'history_program_version_uncertified':null,accountKey:s.account,identityScheme:'wechat.account.v1',sourceGeneration:s.generation,supportProfile:'wechat-4.0.6-29387-account-session-metadata-v1',programVersion:s.mode==='unknown-version'?'9.9.9':'4.0.6',build:s.mode==='unknown-version'?'1':'29387',artifactSha256:cli,wcdbSha256:wcdb,configuredAccount:s.mode==='unknown-version'?'unverified':'verified',continuity:'held-contact-session-instances',normalHistory:false});
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line),s=JSON.parse(fs.readFileSync(stateFile));fs.appendFileSync(logFile,JSON.stringify(r)+'\\n');let data;
if(s.mode==='no-config'){console.log(JSON.stringify({ok:false,error:{code:'history_account_unavailable'}}));return;}
if(s.mode==='unverified-source'){console.log(JSON.stringify({ok:false,error:{code:'history_source_unverified'}}));return;}
if(s.mode==='explicit-config'&&(process.env.WECHAT_CLI_CONFIG!==stateFile||process.env.HOME!==s.expectedHome||process.env.NOTALONE_UNRELATED_SECRET)){console.log(JSON.stringify({ok:false,error:{code:'history_account_unavailable'}}));return;}
if(r.op==='metadata-account'){data=account(s);if(s.mode==='account-body')data.body='BODY_SENTINEL';if(s.mode==='account-promoted')data.normalHistory=true;if(s.mode==='account-artifact')data.artifactSha256='f'.repeat(64);}
if(r.op==='metadata-sessions'){
 if(s.mode==='cancel')return;
 data={format:'wechat-private-session-metadata-v1',account:account(s),sessions:[{username:'friend-a',displayName:'合成甲',kind:'private',identityAssurance:'verified'},{username:'friend-b',displayName:'合成乙',kind:'private',identityAssurance:'verified'}]};
 if(s.mode==='duplicate')data.sessions.push(data.sessions[0]);if(s.mode==='false-group')data.sessions[0].username='synthetic@chatroom';if(s.mode==='sessions-body')data.sessions[0].summary='BODY_SENTINEL';if(s.mode==='overflow')data.sessions=Array.from({length:5001},(_,i)=>({...data.sessions[0],username:'synthetic-'+i}));
 if(s.mode==='changed-after-list'){s.account='different-configured-owner';fs.writeFileSync(stateFile,JSON.stringify(s));}
}
if(r.op==='resolve')data={accountKey:s.account,conversationKey:'friend-a',displayName:'合成甲',sourceGeneration:s.generation};
if(r.op==='inspect-account-schema'){
 const table=(role,n)=>({target:String(n).repeat(64),partition:String(n+2).repeat(64),role,columns:[{name:'username',type:'TEXT',notNull:false,primaryKey:1,hidden:0}],indexes:[],declaredPrimaryKey:['username'],autoIncrement:false,sqlFingerprint:'e'.repeat(64),triggerFingerprints:[],schemaVersion:'1',rootPage:String(n)});
 data={format:'wechat-account-schema-v1',status:'unverified',accountKey:s.account,sourceGeneration:s.generation,schemaFingerprint:'b'.repeat(64),tables:[table('session',1),table('contact',2)],normalHistory:false};if(s.mode==='schema-body')data.records=['BODY_SENTINEL'];
}
if(data===undefined){console.log(JSON.stringify({ok:false,error:{code:'history_operation_unsupported'}}));return;}console.log(JSON.stringify({ok:true,data}));
});`;
  await writeFile(executable, script, {mode:0o700}); await writeFile(join(root,'lib','libWCDB.dylib'), 'synthetic-wcdb');
  await writeFile(join(root,'manifest.json'), JSON.stringify({formatVersion:1,kind:'notalone-history-cli-development',architecture:process.arch,
    sourceCommit:'795071fa0591da5fc2c6ab94a70f22ccd93ef06c',sourceTree:'5d617ff3250c27fd9b33a60cb0182e153c521057',readonlyPatchSha256:'c143ef47728d32c5e647196c75efc33278b49647bd35f3f058b51aeb92ce06aa',signing:'ad-hoc-development',realWechatVerified:false,cliSha256:digest(script),wcdbSha256:digest('synthetic-wcdb')}));
  const options = await loadNarrowWechatOptions(executable), client = new NarrowWechatClient(options), cleanups=[];
  t.after(async()=>{for(const cleanup of cleanups.reverse())await cleanup();await client.close();await rm(root,{recursive:true,force:true});});
  return {root,executable,stateFile,logFile,pidFile,client,cleanups,update:async change=>writeFile(stateFile,JSON.stringify({...JSON.parse(await readFile(stateFile,'utf8')),...change}))};
}
async function requests(f) { try{return (await readFile(f.logFile,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return [];} }
async function requested(f, op) {
  if((await requests(f)).some(row=>row.op===op))return;
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{watcher.close();reject(new Error('synthetic_request_missing'));},5000);
    const check=async()=>{if((await requests(f)).some(row=>row.op===op)){clearTimeout(timer);watcher.close();resolve();}};
    const watcher=watch(f.root,check);void check();
  });
}
function noProcess(pid) { assert.throws(()=>process.kill(pid,0),{code:'ESRCH'}); }

test('正式metadata factory与联系人服务从空库完成检测、账号确认、名单确认和grant',async t=>{
  const f=await fixture(t),metadata=createWechatContactMetadata(f.executable);
  await mkdir(join(f.root,'storage'));const storage=await SqliteStorage.open({userData:join(f.root,'storage'),intent:'create',role:'test'});
  const contacts=new SqliteContactService(storage,'00000000-0000-4000-8000-000000000083',metadata);
  f.cleanups.push(async()=>{await contacts.close();await storage.close();});
  await contacts.initialize();const candidate=await contacts.detectAccount();assert.equal(candidate.account_id,accountKey);assert.equal(candidate.verified,true);
  await contacts.confirmAccount(candidate.candidate_token);await contacts.setReading(true);
  await assert.rejects(contacts.candidates(false),{code:'metadata_consent_required'});
  assert.equal((await requests(f)).some(row=>row.op==='metadata-sessions'),false);
  const snapshot=await contacts.candidates(true);assert.equal(snapshot.sessions.length,2);
  await contacts.confirm(snapshot.snapshot_token,snapshot.sessions.map(row=>({locator:row.username,observed_display_name:row.display_name,expected_selection_generation:row.selection_generation})));
  const directory=await contacts.directory();assert.equal(directory.bindings.length,2);assert.ok(directory.bindings.every(row=>row.status==='active'&&row.grant_id));
  assert.equal((await contacts.eligibility(directory.bindings[0].contact_id)).source_generation,generation);
  const account=await f.client.accountMetadata();assert.equal(account.normalHistory,false);await f.client.resolveSelected('合成甲');
  await assert.rejects(f.client.targetSelected(),{code:'history_support_unverified'});
  assert.ok((await requests(f)).every(row=>['metadata-account','metadata-sessions','resolve'].includes(row.op)));
});

test('未知版本、缺配置和未配工具不认证metadata，也不读取名单',async t=>{
  await assert.rejects(createWechatContactMetadata().account(),{code:'wechat_tool_unavailable'});
  for(const mode of ['unknown-version','no-config']){
    const f=await fixture(t,mode),port=createWechatContactMetadata(f.executable);t.after(()=>port.close());
    if(mode==='unknown-version'){const account=await port.account();assert.equal(account.assurance,'unverified');await assert.rejects(port.sessions(account),{code:'metadata_identity_unverified'});}
    else await assert.rejects(port.account(),{code:'history_account_unavailable'});
    assert.ok((await requests(f)).every(row=>row.op==='metadata-account'));
  }
});

test('账号检测报告缺失的工具清单，恢复完整制品后可重试且不读取名单', async t => {
  const f = await fixture(t), metadata = createWechatContactMetadata(f.executable);
  await mkdir(join(f.root, 'storage'));
  const storage = await SqliteStorage.open({userData: join(f.root, 'storage'), intent: 'create', role: 'test'});
  const contacts = new SqliteContactService(storage, '00000000-0000-4000-8000-000000000083', metadata);
  f.cleanups.push(async () => { await contacts.close(); await storage.close(); });
  await contacts.initialize();
  const api = new SqliteContactHttp(contacts), token = 'synthetic-account-detection';
  const server = createServer((req, res) => {
    if (!authorizeSqliteRequest(req, token)) { res.writeHead(401).end(); return; }
    void api.handle(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const detect = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/setup/wechat/detect`, {method: 'POST', body: '{}', headers: {Authorization: `Bearer ${token}`}});
    assert.equal(response.status, 200);
    return response.json();
  };
  const manifest = await readFile(join(f.root, 'manifest.json'));
  await rm(join(f.root, 'manifest.json'));
  assert.deepEqual(await detect(), {state: 'tool_not_ready', account_id: null, candidate_token: null, failure_code: 'history_artifact_manifest_missing'});
  assert.deepEqual(await requests(f), [], '工具不完整时不启动读取进程');
  await writeFile(join(f.root, 'manifest.json'), manifest);
  assert.equal((await detect()).state, 'ready');
  assert.ok((await requests(f)).every(row => row.op === 'metadata-account'));
  assert.equal((await contacts.directory()).account, null, '检测不等于连接授权');
  await f.update({mode: 'unknown-version'});
  assert.equal((await detect()).failure_code, 'history_scope_changed');
  assert.equal((await detect()).failure_code, 'history_program_version_uncertified');
  await f.update({mode: 'no-config'});
  assert.equal((await detect()).failure_code, 'history_account_unavailable');
  await f.update({mode: 'unverified-source'});
  assert.equal((await detect()).failure_code, 'history_source_unverified');
  assert.ok((await requests(f)).every(row => row.op === 'metadata-account'));
});

test('factory失败后仅下一次显式检测重开同port，close保持终态',async t=>{
  const f=await fixture(t,'no-config'),port=createWechatContactMetadata(f.executable);f.cleanups.push(()=>port.close());
  await assert.rejects(port.account(),{code:'history_account_unavailable'});
  const failedPid=Number(await readFile(f.pidFile,'utf8'));noProcess(failedPid);
  assert.equal((await requests(f)).length,1,'本次失败不能自动重试');
  await f.update({mode:'normal'});
  assert.equal((await port.account()).assurance,'verified');
  assert.equal((await requests(f)).length,2,'后续显式检测必须重新发RPC');
  await port.close();noProcess(Number(await readFile(f.pidFile,'utf8')));
  await assert.rejects(port.account(),{code:'identity_closed'});
  assert.equal((await requests(f)).length,2,'close后不得复活');
});

test('隔离宿主为微信只传递明确账号配置路径，不恢复HOME或泄露其他环境', async t => {
  const f = await fixture(t, 'explicit-config'), isolatedHome = join(f.root, 'isolated-home');
  await mkdir(isolatedHome); await f.update({expectedHome: isolatedHome});
  const prior = Object.fromEntries(['HOME', 'NOTALONE_WECHAT_CONFIG', 'NOTALONE_UNRELATED_SECRET'].map(key => [key, process.env[key]]));
  const port = createWechatContactMetadata(f.executable);
  try {
    process.env.HOME = isolatedHome;
    process.env.NOTALONE_WECHAT_CONFIG = f.stateFile;
    process.env.NOTALONE_UNRELATED_SECRET = 'synthetic-secret-must-not-reach-reader';
    assert.equal((await port.account()).assurance, 'verified');
    assert.ok((await requests(f)).every(row => row.op === 'metadata-account'));
  } finally {
    await port.close();
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('同port修复配置后的显式检测不会恢复服务已撤销的旧grant',async t=>{
  const f=await fixture(t),metadata=createWechatContactMetadata(f.executable);
  await mkdir(join(f.root,'storage'));const storage=await SqliteStorage.open({userData:join(f.root,'storage'),intent:'create',role:'test'});
  const contacts=new SqliteContactService(storage,'00000000-0000-4000-8000-000000000083',metadata);f.cleanups.push(async()=>{await contacts.close();await storage.close();});
  await contacts.initialize();const candidate=await contacts.detectAccount();await contacts.confirmAccount(candidate.candidate_token);await contacts.setReading(true);
  const snapshot=await contacts.candidates(true);await contacts.confirm(snapshot.snapshot_token,snapshot.sessions.map(row=>({locator:row.username,observed_display_name:row.display_name,expected_selection_generation:row.selection_generation})));
  const contactId=(await contacts.directory()).bindings[0].contact_id;await contacts.eligibility(contactId);
  await f.update({mode:'no-config'});await assert.rejects(contacts.detectAccount(),{code:'history_account_unavailable'});
  await assert.rejects(contacts.eligibility(contactId),{code:'read_not_authorized'});
  await f.update({mode:'normal'});assert.equal((await contacts.detectAccount()).verified,true);
  await assert.rejects(contacts.eligibility(contactId),{code:'read_not_authorized'});
  assert.ok((await contacts.directory()).bindings.every(row=>row.status==='revoked'));
});

test('metadata严格拒绝重复身份、伪私聊、附带正文、超量及制品/资格升级',async t=>{
  for(const mode of ['duplicate','false-group','sessions-body','overflow','account-body','account-promoted','account-artifact']){
    const f=await fixture(t,mode);
    await assert.rejects(async()=>{const account=await f.client.accountMetadata();await f.client.privateSessionMetadata(account);},{code:'history_protocol_invalid'});
    noProcess(Number(await readFile(f.pidFile,'utf8')));
  }
});

test('账号或来源在确认前/名单后改变时不保存新身份或grant',async t=>{
  for(const mode of ['account','source','changed-after-list']){
    const f=await fixture(t,mode==='changed-after-list'?mode:'normal'),metadata=createWechatContactMetadata(f.executable);
    await mkdir(join(f.root,'storage'));const storage=await SqliteStorage.open({userData:join(f.root,'storage'),intent:'create',role:'test'});
    const contacts=new SqliteContactService(storage,'00000000-0000-4000-8000-000000000083',metadata);f.cleanups.push(async()=>{await contacts.close();await storage.close();});
    await contacts.initialize();const candidate=await contacts.detectAccount();
    if(mode==='account'||mode==='source'){await f.update(mode==='account'?{account:'changed-owner'}:{generation:'c'.repeat(64)});await assert.rejects(contacts.confirmAccount(candidate.candidate_token),{code:'history_scope_changed'});assert.equal((await contacts.directory()).account,null);}
    else{await contacts.confirmAccount(candidate.candidate_token);await assert.rejects(contacts.candidates(true),{code:'history_scope_changed'});assert.deepEqual((await contacts.directory()).bindings,[]);}
  }
});

test('结构诊断只返回两固定元数据schema，额外记录字段拒绝且不授予history',async t=>{
  const f=await fixture(t),schema=await f.client.inspectAccountSchema();assert.equal(schema.status,'unverified');assert.equal(schema.normalHistory,false);assert.deepEqual(schema.tables.map(row=>row.role),['session','contact']);
  await assert.rejects(f.client.targetSelected(),{code:'history_scope_unverified'});
  const invalid=await fixture(t,'schema-body');await assert.rejects(invalid.client.inspectAccountSchema(),{code:'history_protocol_invalid'});noProcess(Number(await readFile(invalid.pidFile,'utf8')));
});

test('名单取消及factory关闭会等待真实受控子进程退出',async t=>{
  const f=await fixture(t,'cancel'),account=await f.client.accountMetadata(),controller=new AbortController();
  const pending=f.client.privateSessionMetadata(account,controller.signal),rejected=assert.rejects(pending,{code:'history_native_cancelled'});
  await requested(f,'metadata-sessions');controller.abort();await rejected;noProcess(Number(await readFile(f.pidFile,'utf8')));
  const g=await fixture(t,'cancel'),port=createWechatContactMetadata(g.executable);const evidence=await port.account();
  const reading=port.sessions(evidence),closed=assert.rejects(reading,{code:'history_native_closed'});await requested(g,'metadata-sessions');await port.close();await closed;noProcess(Number(await readFile(g.pidFile,'utf8')));
});
