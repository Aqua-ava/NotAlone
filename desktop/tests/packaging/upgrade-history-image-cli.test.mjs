import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compareUpgradeScopeEvidence, createUpgradeImageCliTools } from '../../scripts/upgrade-history-image-cli.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const hash = digest;

function scopeEvidence(artifactSha256) {
  const accountKey = 'synthetic-account';
  const sourceGeneration = 'a'.repeat(64);
  const scopes = ['conversation-a', 'conversation-b', 'conversation-empty'].map((conversationKey, index) => {
    const partition = String(index + 1).repeat(64);
    const instance = String(index + 3).repeat(64);
    const schemaFingerprint = `${index}`.repeat(64);
    const scope = { accountKey, conversationKey, displayName: `联系人${index}`, sourceGeneration };
    const inspection = { format: 'wechat-message-schema-v1', status: 'unverified',
      scopeDigest: digest(`${accountKey}\0${conversationKey}`), sourceGeneration, schemaFingerprint,
      tables: index === 2 ? [] : [{ target: instance, partition, role: 'private_message', columns: [], indexes: [],
        declaredPrimaryKey: ['local_id'], autoIncrement: false, schemaVersion: '1', rootPage: '2',
        sqlFingerprint: 'b'.repeat(64), triggerFingerprints: [] },
      ...(index === 0 ? [{ target: '4'.repeat(64), partition, role: 'private_message', columns: [], indexes: [],
        declaredPrimaryKey: ['local_id'], autoIncrement: false, schemaVersion: '1', rootPage: '3',
        sqlFingerprint: 'c'.repeat(64), triggerFingerprints: [] }] : [])], checkedPartitions: [partition] };
    const support = { protocol: 'private-history-v1', profileId: 'synthetic-profile', adapterVersion: '1',
      status: 'supported', reason: null, accountKey, conversationKey, sourceGeneration,
      programVersion: '4.0.6', build: '29387', artifactSha256,
      schemaFingerprint, declaredPrimaryKey: ['local_id'], serverAliasSemantics: 'verified',
      identity: 'source-table-local-v1', statusSemantics: 'known', continuity: 'same-source-instances-normal-use-v1',
      capabilities: { history: 'supported', incrementalTail: 'supported' } };
    const target = { protocol: 'private-history-v1', descriptor: `dynamic-${artifactSha256.slice(0, 8)}`,
      sourceGeneration, partitions: [partition], tables: index === 2 ? [] : [{ partition, instance },
        ...(index === 0 ? [{ partition, instance: '4'.repeat(64) }] : [])], checkedPartitions: [partition] };
    return { scope, inspection, support, target };
  });
  return { account: { format: 'wechat-account-metadata-v1', status: 'verified', reason: null,
    accountKey, identityScheme: 'wechat.account.v1', sourceGeneration, supportProfile: 'synthetic-profile',
    programVersion: '4.0.6', build: '29387', artifactSha256, wcdbSha256: 'c'.repeat(64),
    configuredAccount: 'verified', continuity: 'held-contact-session-instances', normalHistory: false }, scopes };
}

const syntheticFileHashes = {
  'cmd/wechat-cli/notalone_identity_aliases.go': 'identity-aliases',
  'cmd/wechat-cli/notalone_watch_darwin.go': 'source-watch',
  'cmd/wechat-cli/notalone_history.go': 'history-identity',
  'cmd/wechat-cli/notalone_snapshot.go': 'snapshot-identity',
  'cmd/wechat-cli/notalone_account_metadata.go': 'account-identity',
  'cmd/wechat-cli/notalone_readonly_test.go': 'readonly-overlay-test',
  'cmd/wechat-cli/notalone_protocol.go': 'protocol-before',
  'internal/wcdb/notalone_read.go': 'wcdb-read',
  'internal/wcdb/notalone_read_test.go': 'wcdb-read-test',
  'cmd/wechat-cli/main.go': 'same-upstream-main',
  'go.mod': 'same-upstream-module',
};

function overlaySha(files) {
  const rows = [['cmd/wechat-cli/notalone_readonly_test.go', hash('readonly-overlay-test')]];
  for (const name of Object.keys(files).filter(name => name.startsWith('cmd/wechat-cli/notalone_')
    && name.endsWith('.go') && name !== 'cmd/wechat-cli/notalone_readonly_test.go').sort()) {
    rows.push([name, hash(files[name])]);
  }
  for (const name of Object.keys(files).filter(name => name.startsWith('internal/wcdb/notalone_') && name.endsWith('.go')).sort()) {
    rows.push([name, hash(files[name])]);
  }
  return hash(JSON.stringify(rows));
}

async function syntheticUpgradeFixture({ existingImage = false, quotes = false, quoteTail = false, quoteInline = false, sharedProcess = false, contactAvatar = false, durableHistory = false, imageOpenIsolation = false } = {}) {
  const repositoryRoot = await mkdtemp(path.join(process.cwd(), '.tmp-notalone-image-upgrade-'));
  const buildsRoot = path.join(repositoryRoot, 'local-tools/wx-cli/.notalone-builds');
  const oldName = existingImage ? 'original-image-20261031-v1' : 'true-delta-20261031-c2';
  const newName = existingImage ? 'original-image-20261031-v2' : 'original-image-20261031-v1';
  const fromRoot = path.join(buildsRoot, oldName);
  const toRoot = path.join(buildsRoot, newName);
  const dbRoot = path.join(repositoryRoot, 'synthetic-wechat-root');
  const accountKey = 'synthetic-account';
  const historyPatch = 'synthetic history patch\n';
  const readonlyPatch = 'synthetic readonly patch\n';
  const readonlyTest = 'readonly-overlay-test';
  const wcdbBytes = 'synthetic WCDB library bytes';
  const wcdbSha256 = hash(wcdbBytes);
  const sourceCommit = 'synthetic-commit';
  const sourceTree = 'synthetic-tree';
  const goArchiveSha256 = '1'.repeat(64);
  const goVersion = 'synthetic-go';
  const commonLock = { gitSources: [{ name: 'wechat-cli', version: 'synthetic-version', commit: sourceCommit, tree: sourceTree }],
    archives: [{ name: 'go', version: goVersion, sha256: goArchiveSha256 }],
    cliPatch: { file: 'wechat-patches/readonly-cli.patch', sha256: hash(readonlyPatch),
      testFile: 'wechat-patches/readonly-cli-test.go', testSha256: hash(readonlyTest) } };
  const sourceLockBytes = `${JSON.stringify(commonLock, null, 2)}\n`;
  const common = { formatVersion: 1, kind: 'notalone-history-cli-development', architecture: 'arm64', version: 'synthetic-version',
    sourceCommit, sourceTree, sourceLockSha256: hash(sourceLockBytes), goVersion, goArchiveSha256,
    readonlyPatchSha256: hash(readonlyPatch), historyPatchSha256: hash(historyPatch), wcdbSha256,
    signing: 'ad-hoc-development', realWechatVerified: false };
  const oldCliBytes = 'synthetic old CLI';
  const newCliBytes = 'synthetic new CLI';
  const oldCliSha256 = hash(oldCliBytes);
  const newCliSha256 = hash(newCliBytes);
  const newProtocol = 'protocol with original image operation';
  const newImage = 'original image reader';
  const newImageTest = 'synthetic original image test';
  const oldFiles = { ...syntheticFileHashes, ...(existingImage ? {
    'cmd/wechat-cli/notalone_protocol.go': newProtocol,
    'cmd/wechat-cli/notalone_image.go': 'old original image reader',
    'cmd/wechat-cli/notalone_image_test.go': 'old original image regression test',
  } : {}) };
  const newFiles = { ...syntheticFileHashes,
    'cmd/wechat-cli/notalone_protocol.go': newProtocol,
    'cmd/wechat-cli/notalone_image.go': newImage,
    'cmd/wechat-cli/notalone_image_test.go': newImageTest };
  if(quotes)newFiles['cmd/wechat-cli/notalone_quote.go']='bounded exact quote reader';
  if(quoteTail){
    oldFiles['cmd/wechat-cli/notalone_quote.go']='bounded fixed snapshot quote reader';
    newFiles['cmd/wechat-cli/notalone_quote.go']='bounded normal and tail quote reader';
    oldFiles['cmd/wechat-cli/notalone_image.go']=newImage;
    oldFiles['cmd/wechat-cli/notalone_image_test.go']=newImageTest;
  }
  if(quoteInline)newFiles['cmd/wechat-cli/notalone_snapshot.go']='snapshot with bounded inline quote projection';
  if(sharedProcess){newFiles['cmd/wechat-cli/notalone_account_metadata.go']='account identity unchanged plus bounded all-session metadata';newFiles['cmd/wechat-cli/notalone_selection_test.go']='selection isolation regression';}
  if(contactAvatar){newFiles['cmd/wechat-cli/notalone_contact_avatar.go']='exact private contact avatar metadata';newFiles['cmd/wechat-cli/notalone_contact_avatar_test.go']='avatar scope and URL regression';}
  if(durableHistory){
    oldFiles['cmd/wechat-cli/notalone_checkpoint.go']='complete checkpoint only';
    newFiles['cmd/wechat-cli/notalone_checkpoint.go']='partial checkpoint with accepted parent';
    newFiles['cmd/wechat-cli/notalone_history_resume_test.go']='partial restart regression';
  }
  const write = async (file, data, mode = 0o600) => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, data, { mode });
  };
  await write(path.join(repositoryRoot, 'desktop/wechat-sources.lock.json'), sourceLockBytes);
  await write(path.join(repositoryRoot, 'desktop/wechat-history/history-cli.patch'), historyPatch);
  await write(path.join(repositoryRoot, 'desktop/wechat-patches/readonly-cli.patch'), readonlyPatch);
  await write(path.join(repositoryRoot, 'desktop/wechat-patches/readonly-cli-test.go'), readonlyTest);
  for (const [root, files, cliBytes, cliSha256, imageProtocol] of [
    [fromRoot, oldFiles, oldCliBytes, oldCliSha256, existingImage ? 'wechat-original-image-v1' : undefined],
    [toRoot, newFiles, newCliBytes, newCliSha256, 'wechat-original-image-v1'],
  ]) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const [name, content] of Object.entries(files)) await write(path.join(root, 'source', name), content);
    await write(path.join(root, 'history-cli.patch'), historyPatch);
    await write(path.join(root, 'readonly-cli.patch'), readonlyPatch);
    await write(path.join(root, 'lib/libWCDB.dylib'), wcdbBytes);
    await write(path.join(root, 'bin/wechat-cli'), cliBytes, 0o700);
    const manifest = { ...common, overlaySha256: overlaySha(files), cliSha256,
      ...(imageProtocol ? { originalImageProtocol: imageProtocol } : {}),
      ...(quoteTail?{originalImageQualityProof:'wechat-message-image-content-v1'}:existingImage && root === toRoot ? { originalImageQualityProof: 'wechat-cdn-big-hd-exact-content-v3' } : {}),
      ...(quotes&&(root===toRoot||quoteTail)?{quoteProtocol:'wechat-quote-message-v1'}:{}),
      ...(quoteTail&&root===toRoot?{quoteReader:'wechat-quote-normal-tail-v2'}:{}),
      ...(quoteInline&&root===toRoot?{quoteInline:'wechat-quote-inline-sync-v1'}:{}),
      ...(sharedProcess&&root===toRoot?{sharedProcessProtocol:'wechat-shared-process-v1'}:{}),
      ...(imageOpenIsolation&&root===toRoot?{imageOpenIsolation:'wechat-image-open-local-v1'}:{}) };
    await write(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const rootScope = hash(`${accountKey}\0${path.resolve(dbRoot)}`);
  const aliases = { ['a'.repeat(64)]: 'b'.repeat(64) };
  const oldRecord = { format: 'notalone-source-identity-aliases-v1', accountKey,
    artifactSha256: oldCliSha256, rootScope, aliases };
  const oldAliasPath = path.join(fromRoot, 'source-identity-aliases.json');
  await write(oldAliasPath, `${JSON.stringify(oldRecord)}\n`);
  await write(path.join(dbRoot, 'business.sqlite'), 'must remain unchanged');
  const identityFileNames = ['notalone_identity_aliases.go', 'notalone_watch_darwin.go', 'notalone_history.go',
    'notalone_snapshot.go', 'notalone_account_metadata.go'];
  const identityFiles = Object.fromEntries(identityFileNames.map(name => [`cmd/wechat-cli/${name}`, hash(oldFiles[`cmd/wechat-cli/${name}`])]));
  const protocolOldSha256 = hash(oldFiles['cmd/wechat-cli/notalone_protocol.go']);
  const protocolNewSha256 = hash(newProtocol);
  const inlineSourceChanges=quoteInline?{'cmd/wechat-cli/notalone_snapshot.go':{old:hash(oldFiles['cmd/wechat-cli/notalone_snapshot.go']),new:hash(newFiles['cmd/wechat-cli/notalone_snapshot.go'])}}:{};
  const sharedSourceChanges=sharedProcess?Object.fromEntries(['cmd/wechat-cli/notalone_account_metadata.go','cmd/wechat-cli/notalone_selection_test.go'].map(name=>[name,{old:oldFiles[name]?hash(oldFiles[name]):null,new:hash(newFiles[name])}])):{};
  const avatarSourceChanges=contactAvatar?Object.fromEntries(['cmd/wechat-cli/notalone_contact_avatar.go','cmd/wechat-cli/notalone_contact_avatar_test.go'].map(name=>[name,{old:null,new:hash(newFiles[name])}])):{};
  const historySourceChanges=durableHistory?Object.fromEntries(['cmd/wechat-cli/notalone_checkpoint.go','cmd/wechat-cli/notalone_history_resume_test.go'].map(name=>[name,{old:oldFiles[name]?hash(oldFiles[name]):null,new:hash(newFiles[name])}])):{};
  const updates=Object.entries({...inlineSourceChanges,...sharedSourceChanges}).filter(([name])=>Object.hasOwn(identityFiles,name)).sort(([a],[b])=>a.localeCompare(b));
  const identityAlgorithmSha256 = hash(JSON.stringify({ files: Object.entries(identityFiles).sort((left, right) => left[0].localeCompare(right[0])),
    protocol: [protocolOldSha256, protocolNewSha256],...(updates.length?{updates}:{}) }));
  const policy = { oldName, newName, commonManifest: common,
    ...(quotes?{newQuoteProtocol:'wechat-quote-message-v1',sourceChanges:{'cmd/wechat-cli/notalone_quote.go':{old:quoteTail?hash(oldFiles['cmd/wechat-cli/notalone_quote.go']):null,new:hash(newFiles['cmd/wechat-cli/notalone_quote.go'])},...inlineSourceChanges,...sharedSourceChanges}}:{}),
    ...(quoteTail?{oldQuoteProtocol:'wechat-quote-message-v1',newQuoteReader:'wechat-quote-normal-tail-v2'}:{}),
    ...(quoteInline?{newQuoteInline:'wechat-quote-inline-sync-v1'}:{}),
    ...(sharedProcess?{newSharedProcessProtocol:'wechat-shared-process-v1'}:{}),
    ...(imageOpenIsolation?{newImageOpenIsolation:'wechat-image-open-local-v1'}:{}),
    ...(contactAvatar?{newAvatarMetadataProtocol:'wechat-contact-avatar-metadata-v1',sourceChanges:avatarSourceChanges}:{}),
    ...(durableHistory?{newDurableHistoryProtocol:'wechat-partial-history-checkpoint-v1',sourceChanges:historySourceChanges}:{}),
    oldCliSha256, newCliSha256, oldOverlaySha256: overlaySha(oldFiles), newOverlaySha256: overlaySha(newFiles),
    newImageProtocol: 'wechat-original-image-v1', identityFiles, identityAlgorithmSha256,
    protocolOldSha256, protocolNewSha256, imageSha256: hash(newImage), imageTestSha256: hash(newImageTest),
    sourceLockSha256: hash(sourceLockBytes), historyPatchSha256: hash(historyPatch), readonlyPatchSha256: hash(readonlyPatch),
    readonlyTestSha256: hash(readonlyTest), wcdbSha256,
    ...(existingImage ? { oldImageProtocol: 'wechat-original-image-v1',newImageQualityProof:quoteTail?'wechat-message-image-content-v1':'wechat-cdn-big-hd-exact-content-v3',
      ...(quoteTail?{oldImageQualityProof:'wechat-message-image-content-v1'}:{}),
      oldImageSha256: hash(oldFiles['cmd/wechat-cli/notalone_image.go']),
      oldImageTestSha256: hash(oldFiles['cmd/wechat-cli/notalone_image_test.go']) } : {}) };
  return { repositoryRoot, buildsRoot, fromRoot, toRoot, dbRoot, accountKey, oldAliasPath, oldRecord,
    oldAliasBytes: await readFile(oldAliasPath), policy, aliases, tools: createUpgradeImageCliTools({ repositoryRoot, policy }) };
}

test('升级前后全部授权scope身份相同才通过，允许 artifact 摘要和动态快照descriptor变化', () => {
  const before = scopeEvidence('d'.repeat(64));
  const after = scopeEvidence('e'.repeat(64));
  assert.deepEqual(compareUpgradeScopeEvidence(before, after), { status: 'verified', scopeCount: 3 });

  after.scopes[0].target.tables.reverse();
  assert.deepEqual(compareUpgradeScopeEvidence(before, after), { status: 'verified', scopeCount: 3 });

  const changed = after.scopes[1];
  changed.target.tables[0].instance = 'f'.repeat(64);
  changed.inspection.tables[0].target = 'f'.repeat(64);
  changed.inspection.schemaFingerprint = '9'.repeat(64);
  changed.support.schemaFingerprint = '9'.repeat(64);
  assert.throws(() => compareUpgradeScopeEvidence(before, after), /history_image_upgrade_scope_mismatch/);
});

test('拒绝scope缺失或重复、缺失身份字段，以及零表scope的target分区不一致', () => {
  const before = scopeEvidence('d'.repeat(64));
  const after = scopeEvidence('e'.repeat(64));
  assert.throws(() => compareUpgradeScopeEvidence({ ...before, scopes: [] }, after), /history_image_upgrade_scope_mismatch/);
  assert.throws(() => compareUpgradeScopeEvidence(before, { ...after, scopes: after.scopes.slice(0, 2) }), /history_image_upgrade_scope_mismatch/);

  const duplicate = structuredClone(after);
  duplicate.scopes[1].scope.conversationKey = duplicate.scopes[0].scope.conversationKey;
  assert.throws(() => compareUpgradeScopeEvidence(before, duplicate), /history_image_upgrade_evidence_invalid/);

  const wrongEmptyPartition = structuredClone(after);
  wrongEmptyPartition.scopes[2].target.partitions = ['f'.repeat(64)];
  assert.throws(() => compareUpgradeScopeEvidence(before, wrongEmptyPartition), /history_image_upgrade_evidence_invalid/);

  const incomplete = structuredClone(after);
  delete incomplete.scopes[0].inspection.tables[0].sqlFingerprint;
  assert.throws(() => compareUpgradeScopeEvidence(before, incomplete), /history_image_upgrade_evidence_invalid/);

  const changedGeneration = structuredClone(after);
  const generation = '9'.repeat(64);
  changedGeneration.account.sourceGeneration = generation;
  for (const item of changedGeneration.scopes) {
    item.scope.sourceGeneration = generation;
    item.inspection.sourceGeneration = generation;
    item.support.sourceGeneration = generation;
    item.target.sourceGeneration = generation;
  }
  assert.throws(() => compareUpgradeScopeEvidence(before, changedGeneration), /history_image_upgrade_scope_mismatch/);
});

test('从已核验旧alias签发新制品独立sidecar与receipt，不改旧sidecar或业务数据库', async t => {
  const fixture = await syntheticUpgradeFixture();
  t.after(() => rm(fixture.repositoryRoot, { recursive: true, force: true }));
  const businessFile = path.join(fixture.dbRoot, 'business.sqlite');
  const businessBefore = await readFile(businessFile);
  const oldAliasBefore = await readFile(fixture.oldAliasPath);
  const previousUmask = process.umask(0o777);
  let result;
  try {
    result = await fixture.tools.prepareAliases({ fromRoot: fixture.fromRoot, toRoot: fixture.toRoot,
      accountKey: fixture.accountKey, dbRoot: fixture.dbRoot });
  } finally { process.umask(previousUmask); }

  assert.equal(result.status, 'prepared');
  const newAliasPath = path.join(fixture.toRoot, 'source-identity-aliases.json');
  const receiptPath = path.join(fixture.toRoot, 'source-identity-upgrade-receipt.json');
  const newAliasBytes = await readFile(newAliasPath);
  const newAlias = JSON.parse(newAliasBytes);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(newAlias.artifactSha256, fixture.policy.newCliSha256);
  assert.deepEqual(newAlias.aliases, fixture.oldRecord.aliases);
  assert.equal(newAlias.rootScope, fixture.oldRecord.rootScope);
  assert.equal(receipt.format, 'notalone-source-identity-upgrade-receipt-v1');
  assert.equal(receipt.fromArtifactSha256, fixture.policy.oldCliSha256);
  assert.equal(receipt.toArtifactSha256, fixture.policy.newCliSha256);
  assert.equal(receipt.sourceIdentityAlgorithmSha256, fixture.policy.identityAlgorithmSha256);
  assert.equal(receipt.priorAliasFileSha256, hash(oldAliasBefore));
  assert.equal(receipt.newAliasFileSha256, hash(newAliasBytes));
  assert.equal(receipt.checkpointPolicy, 'recreate-with-new-artifact');
  assert.equal(JSON.stringify(receipt).includes(fixture.dbRoot), false);
  assert.equal((await lstat(newAliasPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(receiptPath)).mode & 0o777, 0o600);
  assert.equal((await readdir(fixture.toRoot)).some(name => name.endsWith('.tmp')), false);
  assert.deepEqual(await readFile(fixture.oldAliasPath), oldAliasBefore);
  assert.deepEqual(await readFile(businessFile), businessBefore);
});

test('引用窄读取升级只允许固定新源码和声明协议，保留旧身份别名',async t=>{
 const fixture=await syntheticUpgradeFixture({existingImage:true,quotes:true});t.after(()=>rm(fixture.repositoryRoot,{recursive:true,force:true}));
 await fixture.tools.prepareAliases({fromRoot:fixture.fromRoot,toRoot:fixture.toRoot,accountKey:fixture.accountKey,dbRoot:fixture.dbRoot});
 const alias=JSON.parse(await readFile(path.join(fixture.toRoot,'source-identity-aliases.json'),'utf8'));assert.deepEqual(alias.aliases,fixture.aliases);
});

test('tail引用reader升级绑定既有quote源码及能力声明，图片合同保持不变',async t=>{
 const f=await syntheticUpgradeFixture({existingImage:true,quotes:true,quoteTail:true});t.after(()=>rm(f.repositoryRoot,{recursive:true,force:true}));
 assert.equal(f.policy.oldImageSha256,f.policy.imageSha256);
 assert.equal((await f.tools.prepareAliases(f)).status,'prepared');
 const aliases=JSON.parse(await readFile(path.join(f.toRoot,'source-identity-aliases.json'),'utf8'));assert.deepEqual(aliases.aliases,f.aliases);
});

async function syntheticImageQualityUpgradeFixture() {
 const fixture=await syntheticUpgradeFixture({existingImage:true});
 const preserved={quoteProtocol:'wechat-quote-message-v1',quoteReader:'wechat-quote-normal-tail-v2',quoteInline:'wechat-quote-inline-sync-v1',sharedProcessProtocol:'wechat-shared-process-v1'};
 for(const [root,proof] of [[fixture.fromRoot,'wechat-message-image-content-v1'],[fixture.toRoot,'wechat-message-image-content-v2']]){
  const file=path.join(root,'manifest.json'),manifest=JSON.parse(await readFile(file,'utf8'));
  await writeFile(file,JSON.stringify({...manifest,...preserved,originalImageQualityProof:proof}));
 }
 fixture.policy={...fixture.policy,oldImageQualityProof:'wechat-message-image-content-v1',newImageQualityProof:'wechat-message-image-content-v2',
  oldQuoteProtocol:preserved.quoteProtocol,newQuoteProtocol:preserved.quoteProtocol,oldQuoteReader:preserved.quoteReader,newQuoteReader:preserved.quoteReader,
  oldQuoteInline:preserved.quoteInline,newQuoteInline:preserved.quoteInline,oldSharedProcessProtocol:preserved.sharedProcessProtocol,newSharedProcessProtocol:preserved.sharedProcessProtocol};
 fixture.tools=createUpgradeImageCliTools({repositoryRoot:fixture.repositoryRoot,policy:fixture.policy});
 return fixture;
}

test('图片来源分类升级只改变两份图片源码，保留共享进程、引用能力和来源别名',async t=>{
 const f=await syntheticImageQualityUpgradeFixture();t.after(()=>rm(f.repositoryRoot,{recursive:true,force:true}));
 const before=await readFile(path.join(f.dbRoot,'business.sqlite'));
 assert.equal((await f.tools.prepareAliases(f)).status,'prepared');
 const aliases=JSON.parse(await readFile(path.join(f.toRoot,'source-identity-aliases.json'),'utf8'));
 assert.deepEqual(aliases.aliases,f.aliases);assert.equal(aliases.artifactSha256,f.policy.newCliSha256);
 assert.deepEqual(await readFile(path.join(f.dbRoot,'business.sqlite')),before);
});

test('图片分类升级拒绝伪称旧合同、丢失既有能力或夹带身份源码变化',async t=>{
 for(const change of ['proof','shared','source'])await t.test(change,async t=>{
  const f=await syntheticImageQualityUpgradeFixture();t.after(()=>rm(f.repositoryRoot,{recursive:true,force:true}));
  if(change==='source')await writeFile(path.join(f.toRoot,'source/cmd/wechat-cli/notalone_history.go'),'changed identity');
  else{const file=path.join(f.toRoot,'manifest.json'),manifest=JSON.parse(await readFile(file,'utf8'));
   if(change==='proof')manifest.originalImageQualityProof='wechat-message-image-content-v1';else delete manifest.sharedProcessProtocol;
   await writeFile(file,JSON.stringify(manifest));}
  await assert.rejects(f.tools.prepareAliases(f),change==='source'?/history_image_upgrade_source_mismatch/:/history_image_upgrade_manifest_mismatch/);
 });
});

test('未认证的tail引用能力声明不能复用固定升级证明',async t=>{
 const f=await syntheticUpgradeFixture({existingImage:true,quotes:true,quoteTail:true});t.after(()=>rm(f.repositoryRoot,{recursive:true,force:true}));
 const p=path.join(f.toRoot,'manifest.json'),m=JSON.parse(await readFile(p,'utf8'));m.quoteReader='unverified';await writeFile(p,JSON.stringify(m));
 await assert.rejects(f.tools.prepareAliases(f),/history_image_upgrade_manifest_mismatch/);
});

test('同步内联引用升级保留来源别名并精确核对内联协议',async t=>{
 const f=await syntheticUpgradeFixture({existingImage:true,quotes:true,quoteTail:true,quoteInline:true});t.after(()=>rm(f.repositoryRoot,{recursive:true,force:true}));
 assert.equal((await f.tools.prepareAliases(f)).status,'prepared');
 const aliases=JSON.parse(await readFile(path.join(f.toRoot,'source-identity-aliases.json'),'utf8'));assert.deepEqual(aliases.aliases,f.aliases);
 const invalid=await syntheticUpgradeFixture({existingImage:true,quotes:true,quoteTail:true,quoteInline:true});t.after(()=>rm(invalid.repositoryRoot,{recursive:true,force:true}));
 const p=path.join(invalid.toRoot,'manifest.json'),m=JSON.parse(await readFile(p,'utf8'));m.quoteInline='unverified';await writeFile(p,JSON.stringify(m));
 await assert.rejects(invalid.tools.prepareAliases(invalid),/history_image_upgrade_manifest_mismatch/);
});

test('原图修复组件仅图片源码变化，沿用相同协议和身份实现也须独立签发', async t => {
  const fixture = await syntheticUpgradeFixture({ existingImage: true });
  t.after(() => rm(fixture.repositoryRoot, { recursive: true, force: true }));
  const result = await fixture.tools.prepareAliases(fixture);
  assert.equal(result.status, 'prepared');
  assert.deepEqual(await readFile(fixture.oldAliasPath), fixture.oldAliasBytes);
  const record = JSON.parse(await readFile(path.join(fixture.toRoot, 'source-identity-aliases.json')));
  assert.equal(record.artifactSha256, fixture.policy.newCliSha256);
  assert.deepEqual(record.aliases, fixture.aliases);
});

test('receipt发布后遇错只清理本次新文件，不碰旧sidecar和业务数据库', async t => {
  const fixture = await syntheticUpgradeFixture();
  t.after(() => rm(fixture.repositoryRoot, { recursive: true, force: true }));
  const businessFile = path.join(fixture.dbRoot, 'business.sqlite');
  const businessBefore = await readFile(businessFile);
  const oldAliasBefore = await readFile(fixture.oldAliasPath);
  const tools = createUpgradeImageCliTools({ repositoryRoot: fixture.repositoryRoot, policy: fixture.policy,
    afterReceiptPublished: async () => { throw new Error('synthetic write interruption'); } });
  await assert.rejects(() => tools.prepareAliases({ fromRoot: fixture.fromRoot, toRoot: fixture.toRoot,
    accountKey: fixture.accountKey, dbRoot: fixture.dbRoot }), /history_image_upgrade_write_failed/);
  for (const name of ['source-identity-aliases.json', 'source-identity-upgrade-receipt.json']) {
    await assert.rejects(() => lstat(path.join(fixture.toRoot, name)), { code: 'ENOENT' });
  }
  assert.equal((await readdir(fixture.toRoot)).some(name => name.includes('.tmp')), false);
  assert.deepEqual(await readFile(fixture.oldAliasPath), oldAliasBefore);
  assert.deepEqual(await readFile(businessFile), businessBefore);
});

test('拒绝不匹配的来源、构建制品和旧alias证据', async t => {
  const cases = [
    ['身份算法源文件被改', async f => {
      const file = path.join(f.toRoot, 'source/cmd/wechat-cli/notalone_identity_aliases.go');
      await writeFile(file, `${await readFile(file, 'utf8')}\n// tampered`);
    }],
    ['新增未锁定源码差异', async f => {
      const file = path.join(f.toRoot, 'source/cmd/wechat-cli/notalone_extra.go');
      await writeFile(file, 'package main\n', { mode: 0o600 });
    }],
    ['manifest字段被改', async f => {
      const file = path.join(f.toRoot, 'manifest.json');
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      manifest.originalImageProtocol = 'unreviewed';
      await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
    }],
    ['CLI摘要不匹配', async f => writeFile(path.join(f.toRoot, 'bin/wechat-cli'), 'tampered executable')],
    ['WCDB摘要不匹配', async f => writeFile(path.join(f.toRoot, 'lib/libWCDB.dylib'), 'tampered library')],
    ['alias账户不匹配', async f => {
      const record = JSON.parse(await readFile(f.oldAliasPath, 'utf8'));
      record.accountKey = 'another-account';
      await writeFile(f.oldAliasPath, `${JSON.stringify(record)}\n`);
    }],
    ['alias root不匹配', async f => {
      const record = JSON.parse(await readFile(f.oldAliasPath, 'utf8'));
      record.rootScope = 'f'.repeat(64);
      await writeFile(f.oldAliasPath, `${JSON.stringify(record)}\n`);
    }],
    ['alias制品不匹配', async f => {
      const record = JSON.parse(await readFile(f.oldAliasPath, 'utf8'));
      record.artifactSha256 = 'f'.repeat(64);
      await writeFile(f.oldAliasPath, `${JSON.stringify(record)}\n`);
    }],
    ['alias循环', async f => {
      const record = JSON.parse(await readFile(f.oldAliasPath, 'utf8'));
      record.aliases['b'.repeat(64)] = 'a'.repeat(64);
      await writeFile(f.oldAliasPath, `${JSON.stringify(record)}\n`);
    }],
    ['alias重复JSON键', async f => {
      const bytes = await readFile(f.oldAliasPath, 'utf8');
      await writeFile(f.oldAliasPath, bytes.replace('"accountKey":"synthetic-account"',
        '"accountKey":"synthetic-account","accountKey":"synthetic-account"'));
    }],
    ['alias权限过宽', async f => chmod(f.oldAliasPath, 0o644)],
  ];
  for (const [name, mutate] of cases) await t.test(name, async t => {
    const fixture = await syntheticUpgradeFixture();
    t.after(() => rm(fixture.repositoryRoot, { recursive: true, force: true }));
    await mutate(fixture);
    await assert.rejects(() => fixture.tools.prepareAliases({ fromRoot: fixture.fromRoot, toRoot: fixture.toRoot,
      accountKey: fixture.accountKey, dbRoot: fixture.dbRoot }), /history_image_upgrade_/);
  });
});

test('拒绝预先存在的输出sidecar', async t => {
  const fixture = await syntheticUpgradeFixture();
  t.after(() => rm(fixture.repositoryRoot, { recursive: true, force: true }));
  const existing = path.join(fixture.toRoot, 'source-identity-aliases.json');
  await writeFile(existing, 'preexisting', { mode: 0o600 });
  await assert.rejects(() => fixture.tools.prepareAliases({ fromRoot: fixture.fromRoot, toRoot: fixture.toRoot,
    accountKey: fixture.accountKey, dbRoot: fixture.dbRoot }), /history_image_upgrade_output_exists/);
  assert.equal(await readFile(existing, 'utf8'), 'preexisting');
});

 test('共享进程升级精确绑定协议和源码，保留别名并拒绝未声明变化',async t=>{
 const f=await syntheticUpgradeFixture({existingImage:true,quotes:true,quoteTail:true,sharedProcess:true});t.after(()=>rm(f.repositoryRoot,{recursive:true,force:true}));
 assert.equal((await f.tools.prepareAliases(f)).status,'prepared');
 assert.deepEqual(JSON.parse(await readFile(path.join(f.toRoot,'source-identity-aliases.json'),'utf8')).aliases,f.aliases);
 const invalid=await syntheticUpgradeFixture({existingImage:true,quotes:true,quoteTail:true,sharedProcess:true});t.after(()=>rm(invalid.repositoryRoot,{recursive:true,force:true}));
 await writeFile(path.join(invalid.toRoot,'source/cmd/wechat-cli/notalone_history.go'),'unreviewed identity change');
 await assert.rejects(invalid.tools.prepareAliases(invalid),/history_image_upgrade_source_mismatch/);
 });

test('单图隔离升级：新制品清单声明隔离协议才通过，缺失或不同声明被拒绝，别名原样保留', async t => {
 const f=await syntheticUpgradeFixture({existingImage:true,imageOpenIsolation:true});t.after(()=>rm(f.repositoryRoot,{recursive:true,force:true}));
 assert.equal((await f.tools.prepareAliases(f)).status,'prepared');
 assert.deepEqual(JSON.parse(await readFile(path.join(f.toRoot,'source-identity-aliases.json'),'utf8')).aliases,f.aliases);
 for(const change of ['missing','other','old-side']){
  const invalid=await syntheticUpgradeFixture({existingImage:true,imageOpenIsolation:true});t.after(()=>rm(invalid.repositoryRoot,{recursive:true,force:true}));
  const target=path.join(change==='old-side'?invalid.fromRoot:invalid.toRoot,'manifest.json'),manifest=JSON.parse(await readFile(target,'utf8'));
  if(change==='missing')delete manifest.imageOpenIsolation;else manifest.imageOpenIsolation=change==='other'?'wechat-image-open-local-v2':'wechat-image-open-local-v1';
  await writeFile(target,`${JSON.stringify(manifest,null,2)}\n`,{mode:0o600});
  await assert.rejects(invalid.tools.prepareAliases(invalid),/history_image_upgrade_/);
 }
});

test('头像升级只新增固定窄元数据文件，沿用全部原来源别名', async t => {
 const f=await syntheticUpgradeFixture({existingImage:true,contactAvatar:true});t.after(()=>rm(f.repositoryRoot,{recursive:true,force:true}));
 assert.equal((await f.tools.prepareAliases(f)).status,'prepared');
 assert.deepEqual(JSON.parse(await readFile(path.join(f.toRoot,'source-identity-aliases.json'),'utf8')).aliases,f.aliases);
 for(const change of ['missing-protocol','avatar-bytes','identity-bytes']){
  const invalid=await syntheticUpgradeFixture({existingImage:true,contactAvatar:true});t.after(()=>rm(invalid.repositoryRoot,{recursive:true,force:true}));
  if(change==='missing-protocol'){
   delete invalid.policy.newAvatarMetadataProtocol;
   invalid.tools=createUpgradeImageCliTools({repositoryRoot:invalid.repositoryRoot,policy:invalid.policy});
  }else await writeFile(path.join(invalid.toRoot,'source/cmd/wechat-cli',change==='avatar-bytes'?'notalone_contact_avatar.go':'notalone_identity_aliases.go'),'unreviewed change');
  await assert.rejects(invalid.tools.prepareAliases(invalid),/history_image_upgrade_source_mismatch/);
 }
});

// 恢复协议的源码配对仍精确绑定，不允许夹带未审查的账号或来源身份改写。
test('分段历史恢复升级核验固定检查点源码并保留旧别名', async t => {
 const f=await syntheticUpgradeFixture({durableHistory:true});
 t.after(()=>rm(f.repositoryRoot,{recursive:true,force:true}));
 await f.tools.prepareAliases({fromRoot:f.fromRoot,toRoot:f.toRoot,accountKey:f.accountKey,dbRoot:f.dbRoot});
 const record=JSON.parse(await readFile(path.join(f.toRoot,'source-identity-aliases.json'),'utf8'));
 assert.deepEqual(record.aliases,f.aliases);
 assert.deepEqual(await readFile(f.oldAliasPath),f.oldAliasBytes);
 assert.equal(await readFile(path.join(f.dbRoot,'business.sqlite'),'utf8'),'must remain unchanged');
});

test('分段恢复scope比较仅允许明确声明的新能力，不放宽已有来源合同', () => {
 const before=scopeEvidence('d'.repeat(64)),after=scopeEvidence('e'.repeat(64));
 for(const row of before.scopes)row.support.capabilities.durableIncremental='supported';
 for(const row of after.scopes){row.support.capabilities.durableIncremental='supported';row.support.capabilities.durableHistory='supported';}
 assert.throws(()=>compareUpgradeScopeEvidence(before,after),/history_image_upgrade_scope_mismatch/);
 assert.deepEqual(compareUpgradeScopeEvidence(before,after,{durableHistoryUpgrade:true}),{status:'verified',scopeCount:3});
 after.scopes[0].support.capabilities.incrementalTail='unsupported';
 assert.throws(()=>compareUpgradeScopeEvidence(before,after,{durableHistoryUpgrade:true}),/history_image_upgrade_scope_mismatch/);
});


test('分段恢复升级对照混合普通与空会话，仅已有持久增量能力的范围新增能力', () => {
 const before=scopeEvidence('d'.repeat(64)),after=scopeEvidence('e'.repeat(64));
 for(const row of before.scopes.filter(row=>row.target.tables.length))row.support.capabilities.durableIncremental='supported';
 for(const row of after.scopes.filter(row=>row.target.tables.length)){
  row.support.capabilities.durableIncremental='supported';row.support.capabilities.durableHistory='supported';
 }
 const original=structuredClone(after),options={durableHistoryUpgrade:true};
 assert.deepEqual(compareUpgradeScopeEvidence(before,after,options),{status:'verified',scopeCount:3});
 assert.deepEqual(after,original,'升级比较不能改写输入证据');
 const reordered=structuredClone(after);reordered.scopes.reverse();
 assert.deepEqual(compareUpgradeScopeEvidence(before,reordered,options),{status:'verified',scopeCount:3});
 for(const unsupported of ['unsupported','unverified']){
  const previous=structuredClone(before),next=structuredClone(after);
  previous.scopes[2].support.capabilities.durableIncremental=unsupported;
  next.scopes[2].support.capabilities.durableIncremental=unsupported;
  assert.deepEqual(compareUpgradeScopeEvidence(previous,next,options),{status:'verified',scopeCount:3});
 }
 for(const mutate of [
  evidence=>{evidence.scopes[2].support.capabilities.durableHistory='supported';},
  evidence=>{delete evidence.scopes[0].support.capabilities.durableHistory;},
  evidence=>{evidence.scopes[0].support.capabilities.durableIncremental='unsupported';},
  evidence=>{evidence.scopes[2].support.capabilities.incrementalTail='unsupported';},
 ]){
  const invalid=structuredClone(after);mutate(invalid);
  assert.throws(()=>compareUpgradeScopeEvidence(before,invalid,options),/history_image_upgrade_scope_mismatch/);
 }
});
