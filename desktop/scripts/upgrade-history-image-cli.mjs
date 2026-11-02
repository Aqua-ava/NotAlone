import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const digest = value => createHash('sha256').update(value).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const fail = code => { throw new Error(code); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requiredText = value => typeof value === 'string' && value.length > 0;

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return fail('history_image_upgrade_evidence_invalid');
}

function requireObject(value) {
  if (!isObject(value)) fail('history_image_upgrade_evidence_invalid');
  return value;
}

function requireHash(value) {
  if (typeof value !== 'string' || !hashPattern.test(value)) fail('history_image_upgrade_evidence_invalid');
  return value;
}

function requireStringSet(value, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
    || value.some(item => !requiredText(item)) || new Set(value).size !== value.length) {
    fail('history_image_upgrade_evidence_invalid');
  }
  return [...value].sort();
}

function requireExactKeys(value, keys) {
  if (!isObject(value) || canonical(Object.keys(value).sort()) !== canonical([...keys].sort())) {
    fail('history_image_upgrade_evidence_invalid');
  }
}

function accountIdentity(account) {
  requireObject(account);
  requireExactKeys(account, ['format', 'status', 'reason', 'accountKey', 'identityScheme', 'sourceGeneration',
    'supportProfile', 'programVersion', 'build', 'artifactSha256', 'wcdbSha256', 'configuredAccount',
    'continuity', 'normalHistory']);
  if (account.status !== 'verified' || account.configuredAccount !== 'verified'
    || account.format !== 'wechat-account-metadata-v1' || !requiredText(account.accountKey)
    || account.identityScheme !== 'wechat.account.v1' || !hashPattern.test(account.sourceGeneration)
    || account.reason !== null || !requiredText(account.supportProfile) || !requiredText(account.programVersion)
    || !requiredText(account.build) || !hashPattern.test(account.artifactSha256)
    || !hashPattern.test(account.wcdbSha256) || !requiredText(account.continuity)
    || typeof account.normalHistory !== 'boolean') fail('history_image_upgrade_evidence_invalid');
  const { artifactSha256: _artifact, ...stable } = account;
  return canonical(stable);
}

function inspectionIdentity(inspection, scope) {
  requireObject(inspection);
  requireExactKeys(inspection, ['format', 'status', 'scopeDigest', 'sourceGeneration', 'schemaFingerprint', 'tables', 'checkedPartitions']);
  if (inspection.format !== 'wechat-message-schema-v1' || inspection.status !== 'unverified'
    || inspection.scopeDigest !== digest(`${scope.accountKey}\0${scope.conversationKey}`)
    || inspection.sourceGeneration !== scope.sourceGeneration || !hashPattern.test(inspection.schemaFingerprint)
    || !Array.isArray(inspection.tables)) fail('history_image_upgrade_evidence_invalid');
  requireStringSet(inspection.checkedPartitions);
  const tableTargets = new Set();
  for (const table of inspection.tables) {
    requireObject(table);
    requireExactKeys(table, ['target', 'partition', 'role', 'columns', 'indexes', 'declaredPrimaryKey', 'autoIncrement',
      'schemaVersion', 'rootPage', 'sqlFingerprint', 'triggerFingerprints']);
    if (!hashPattern.test(table.partition) || !hashPattern.test(table.target)) {
      fail('history_image_upgrade_evidence_invalid');
    }
    if (!requiredText(table.role) || !Array.isArray(table.columns) || !Array.isArray(table.indexes)
      || !Array.isArray(table.declaredPrimaryKey) || table.declaredPrimaryKey.some(value => !requiredText(value))
      || typeof table.autoIncrement !== 'boolean' || !requiredText(table.schemaVersion) || !requiredText(table.rootPage)
      || !hashPattern.test(table.sqlFingerprint) || !Array.isArray(table.triggerFingerprints)
      || table.triggerFingerprints.some(value => !hashPattern.test(value))) fail('history_image_upgrade_evidence_invalid');
    for (const column of table.columns) {
      requireExactKeys(column, ['name', 'type', 'notNull', 'primaryKey', 'hidden']);
      if (typeof column.name !== 'string' || typeof column.type !== 'string' || typeof column.notNull !== 'boolean'
        || !Number.isSafeInteger(column.primaryKey) || !Number.isSafeInteger(column.hidden)) fail('history_image_upgrade_evidence_invalid');
    }
    for (const index of table.indexes) {
      requireExactKeys(index, ['id', 'unique', 'origin', 'partial', 'columns']);
      if (!hashPattern.test(index.id) || typeof index.unique !== 'boolean' || !requiredText(index.origin)
        || typeof index.partial !== 'boolean' || !Array.isArray(index.columns)) fail('history_image_upgrade_evidence_invalid');
      for (const column of index.columns) {
        requireExactKeys(column, ['sequence', 'name', 'descending', 'collation', 'key']);
        if (!Number.isSafeInteger(column.sequence) || typeof column.name !== 'string' || typeof column.descending !== 'boolean'
          || typeof column.collation !== 'string' || typeof column.key !== 'boolean') fail('history_image_upgrade_evidence_invalid');
      }
    }
    const key = `${table.partition}\0${table.target}`;
    if (tableTargets.has(key)) fail('history_image_upgrade_evidence_invalid');
    tableTargets.add(key);
  }
  const checked = requireStringSet(inspection.checkedPartitions);
  if (inspection.tables.some(table => !checked.includes(table.partition))) fail('history_image_upgrade_evidence_invalid');
  return canonical(inspection);
}

function supportIdentity(support, scope, inspection) {
  requireObject(support);
  requireExactKeys(support, ['protocol', 'profileId', 'adapterVersion', 'status', 'reason', 'accountKey', 'conversationKey',
    'sourceGeneration', 'programVersion', 'build', 'artifactSha256', 'schemaFingerprint', 'declaredPrimaryKey',
    'serverAliasSemantics', 'identity', 'statusSemantics', 'continuity', 'capabilities']);
  if (support.protocol !== 'private-history-v1' || support.status !== 'supported'
    || support.continuity !== 'same-source-instances-normal-use-v1'
    || support.accountKey !== scope.accountKey || support.conversationKey !== scope.conversationKey
    || support.sourceGeneration !== scope.sourceGeneration || support.schemaFingerprint !== inspection.schemaFingerprint
    || !hashPattern.test(support.artifactSha256) || !requiredText(support.profileId) || !requiredText(support.adapterVersion)
    || support.reason !== null || !requiredText(support.programVersion) || !requiredText(support.build)
    || !Array.isArray(support.declaredPrimaryKey) || support.declaredPrimaryKey.some(value => !requiredText(value))
    || !requiredText(support.serverAliasSemantics) || !requiredText(support.identity) || !requiredText(support.statusSemantics)
    || !isObject(support.capabilities) || Object.values(support.capabilities).some(value => !requiredText(value))) {
    fail('history_image_upgrade_evidence_invalid');
  }
  const { artifactSha256: _artifact, ...stable } = support;
  return canonical(stable);
}

function targetIdentity(target, scope, inspection) {
  requireObject(target);
  requireExactKeys(target, ['protocol', 'descriptor', 'partitions', 'tables', 'sourceGeneration', 'checkedPartitions']);
  if (target.protocol !== 'private-history-v1' || !requiredText(target.descriptor)
    || target.sourceGeneration !== scope.sourceGeneration || !Array.isArray(target.tables)) {
    fail('history_image_upgrade_evidence_invalid');
  }
  const partitions = requireStringSet(target.partitions);
  const checkedPartitions = requireStringSet(target.checkedPartitions);
  const tables = [];
  const instances = new Set();
  for (const table of target.tables) {
    requireObject(table);
    requireExactKeys(table, ['partition', 'instance']);
    if (!hashPattern.test(table.partition) || !hashPattern.test(table.instance)
      || !partitions.includes(table.partition) || !checkedPartitions.includes(table.partition)) {
      fail('history_image_upgrade_evidence_invalid');
    }
    if (instances.has(table.instance)) fail('history_image_upgrade_evidence_invalid');
    instances.add(table.instance);
    tables.push({ partition: table.partition, instance: table.instance });
  }
  tables.sort((left, right) => `${left.partition}\0${left.instance}`.localeCompare(`${right.partition}\0${right.instance}`));
  const inspectionTables = inspection.tables.map(table => ({ partition: table.partition, instance: table.target }))
    .sort((left, right) => `${left.partition}\0${left.instance}`.localeCompare(`${right.partition}\0${right.instance}`));
  const expectedPartitions = tables.length ? [...new Set(tables.map(table => table.partition))].sort() : checkedPartitions;
  if (canonical(tables) !== canonical(inspectionTables)
    || canonical(partitions) !== canonical(expectedPartitions)
    || canonical(checkedPartitions) !== canonical(requireStringSet(inspection.checkedPartitions))) {
    fail('history_image_upgrade_evidence_invalid');
  }
  return canonical({ protocol: target.protocol, sourceGeneration: target.sourceGeneration,
    partitions, tables, checkedPartitions });
}

/** 对照同一账号的全量授权scope。descriptor是每次快照随机值，artifact摘要是唯一预期变化项。 */
export function compareUpgradeScopeEvidence(before, after) {
  requireObject(before); requireObject(after);
  const beforeAccount = accountIdentity(before.account);
  const afterAccount = accountIdentity(after.account);
  if (beforeAccount !== afterAccount) fail('history_image_upgrade_scope_mismatch');
  if (!Array.isArray(before.scopes) || !Array.isArray(after.scopes)
    || before.scopes.length === 0 || before.scopes.length !== after.scopes.length) {
    fail('history_image_upgrade_scope_mismatch');
  }
  const indexed = value => {
    const map = new Map();
    for (const item of value.scopes) {
      requireObject(item);
      const scope = requireObject(item.scope);
      requireExactKeys(scope, ['accountKey', 'conversationKey', 'displayName', 'sourceGeneration']);
      if (!requiredText(scope.accountKey) || !requiredText(scope.conversationKey)
        || typeof scope.displayName !== 'string' || !hashPattern.test(scope.sourceGeneration)
        || scope.accountKey !== value.account.accountKey || scope.sourceGeneration !== value.account.sourceGeneration
        || map.has(scope.conversationKey)) fail('history_image_upgrade_evidence_invalid');
      const inspection = requireObject(item.inspection);
      const target = requireObject(item.target);
      const stable = { scope: canonical(scope), inspection: inspectionIdentity(inspection, scope),
        support: supportIdentity(item.support, scope, inspection), target: targetIdentity(target, scope, inspection) };
      map.set(scope.conversationKey, canonical(stable));
    }
    return map;
  };
  const prior = indexed(before), current = indexed(after);
  if (prior.size === 0 || prior.size !== current.size) fail('history_image_upgrade_scope_mismatch');
  for (const [conversation, identity] of prior) {
    if (current.get(conversation) !== identity) fail('history_image_upgrade_scope_mismatch');
  }
  return { status: 'verified', scopeCount: prior.size };
}

const productionPolicy = Object.freeze({
  oldName: 'true-delta-20261031-c2',
  newName: 'original-image-20261031-v1',
  commonManifest: Object.freeze({
    formatVersion: 1,
    kind: 'notalone-history-cli-development',
    architecture: 'arm64',
    version: '2.0.1-rc.5',
    sourceCommit: '795071fa0591da5fc2c6ab94a70f22ccd93ef06c',
    sourceTree: '5d617ff3250c27fd9b33a60cb0182e153c521057',
    sourceLockSha256: 'ecb388fc62750b6f89d2f6d80792811c8b4d4514fa14def9ca702d017d20744a',
    goVersion: '1.26.5',
    goArchiveSha256: 'efb87ff28af9a188d0536ef5d42e63dd52ba8263cd7344a993cc48dd11dedb6a',
    readonlyPatchSha256: 'c143ef47728d32c5e647196c75efc33278b49647bd35f3f058b51aeb92ce06aa',
    historyPatchSha256: '3f862837a6fed12296456c06beeea9c26eda64e7a1751c894c18c4cad2ecebfa',
    wcdbSha256: '4f05cafc4626a142afca1818f0a88c4092a13d5f4c83e30cd5125b558ba0417d',
    signing: 'ad-hoc-development',
    realWechatVerified: false,
  }),
  oldCliSha256: '6c59fb7b968a81da3460c9626176d1dd772666763c6541c8cdad62d8d82a2444',
  newCliSha256: '703d233c2bd858a34d1bc6086d8f033839a8563d7701c237cbc9bbeb3a68dbde',
  oldOverlaySha256: '77c4dcb4290b746d26999a08045c67aaedf5e0779c7f15f04d0821219ef70427',
  newOverlaySha256: '43283d2ce078bb4cbf9166ad4c5620f33492f992b4a1978d286037625bc9b052',
  newImageProtocol: 'wechat-original-image-v1',
  protocolOldSha256: '4e75228bbfbf64c2d3dfacafcb50a6977d30750f2e8fa6eaf829b7524c67c6b2',
  protocolNewSha256: '1831b96e81c2d9229ef7c7b651106b2d8660dbf1173b6f315069a0f1ab2a0b5a',
  imageSha256: 'f7593556a902124f588680b6f29c82e1b2a434f5370ea68e4890400ac746e911',
  imageTestSha256: '9e8fdd171637eddcff5c91f079e46c67dd23f8a80a9aaf43742fd51017c57cd9',
  readonlyTestSha256: 'a534c8322564cb5ea409fe689aa775e1f5f4d59354ec63ec6be62f31bf0e02ce',
  identityFiles: Object.freeze({
    'cmd/wechat-cli/notalone_identity_aliases.go': 'a2060c261101e537a477b16e8ea706c7ccb1e90bbc1c99ebb203b23c9681193c',
    'cmd/wechat-cli/notalone_watch_darwin.go': '697b69668348c4f26fa79d0612b579258ff5667c32dbc5a73e21851f95e294df',
    'cmd/wechat-cli/notalone_history.go': '735ea75af0e2202e40d7cce08a2501b9e4bd5bf855077427bb8337ff34d4ca4f',
    'cmd/wechat-cli/notalone_snapshot.go': 'd9f9f40408ff6462b426d7ef01db9ee382c8c8456d635e076162c55fac3613fc',
    'cmd/wechat-cli/notalone_account_metadata.go': '58b4eb811c8b0ac4e16ee3279aab3ae81b60ad38827f3ae8f7f4808753c88858',
  }),
  identityAlgorithmSha256: 'cce943757bee0fbdfa1215924094a586917d6bf474325162fd7cd8462bc3c461',
});

// 已审查的图片解码修复配对；来源身份实现保持逐字一致。
const decodingFixPolicy = Object.freeze({
  ...productionPolicy,oldName:'original-image-20261031-v1',newName:'original-image-20261031-v2',
  oldCliSha256:'703d233c2bd858a34d1bc6086d8f033839a8563d7701c237cbc9bbeb3a68dbde',newCliSha256:'286452d82c06e33971d2996e1c69389f2557e681bcf73f9cce208b899a86d76b',
  oldOverlaySha256:'43283d2ce078bb4cbf9166ad4c5620f33492f992b4a1978d286037625bc9b052',newOverlaySha256:'40a7192ca2f2a0edb555e9a3026202306a69179020a0ca9b68c510bba3882220',
  oldImageProtocol:'wechat-original-image-v1',newImageQualityProof:'wechat-cdn-big-hd-exact-content-v3',
  protocolOldSha256:'1831b96e81c2d9229ef7c7b651106b2d8660dbf1173b6f315069a0f1ab2a0b5a',protocolNewSha256:'1831b96e81c2d9229ef7c7b651106b2d8660dbf1173b6f315069a0f1ab2a0b5a',
  oldImageSha256:productionPolicy.imageSha256,oldImageTestSha256:productionPolicy.imageTestSha256,
  imageSha256:'eea3a6853093b92b6e5c45be304a7d4767afbc7ca157c0f4df966f3a5fb231f2',imageTestSha256:'be12ac930763045c4e870bf078b54cf626860c192cbd31dbccbee0bc30c94619',
  identityAlgorithmSha256:'1b46174417812d86bfeeaaf68b37ddd87af5f8b7647314663716375979daa821',
});

// 当前账号图片密钥及 WXGF 解码的固定升级配对，不修改来源身份算法。
const wxgfImagePolicy = Object.freeze({
 ...decodingFixPolicy,oldName:'original-image-20261031-v2',newName:'original-image-20261031-v3',
 oldCliSha256:'286452d82c06e33971d2996e1c69389f2557e681bcf73f9cce208b899a86d76b',newCliSha256:'9d6da5197d410b8727386863eac45fd6ad12f61ce484b0ee17ba9e6b6fd6d893',
 oldOverlaySha256:'40a7192ca2f2a0edb555e9a3026202306a69179020a0ca9b68c510bba3882220',newOverlaySha256:'001b643bd04fbc97706aeb8618ca33b4ad50708ede61fdfc3ce44b228a5ccf15',
 oldImageQualityProof:'wechat-cdn-big-hd-exact-content-v3',newImageQualityProof:'wechat-cdn-big-hd-exact-content-v4',
 protocolOldSha256:'1831b96e81c2d9229ef7c7b651106b2d8660dbf1173b6f315069a0f1ab2a0b5a',protocolNewSha256:'dde1590bf04f1c407f371c9a89dc6e6df24fc6ffa0534694fb316ca0d5c3744d',
 oldImageSha256:'eea3a6853093b92b6e5c45be304a7d4767afbc7ca157c0f4df966f3a5fb231f2',oldImageTestSha256:'be12ac930763045c4e870bf078b54cf626860c192cbd31dbccbee0bc30c94619',
 imageSha256:'b6fa04c71f3c1b50c8062d0022a306020b0ad4e4612123a9c3e01ef8123f211e',imageTestSha256:'b6bc9ff5aad59b4d59d8d4625b2be4778ba3970552da990f6ca8d66f5955e89e',
 identityAlgorithmSha256:'0d74d4ccd82206f5ff1f14281e3b76564b4368b9458001837dab379de18555d2',
});

// 引用回复窄读取固定配对；普通消息和来源身份实现不变。
const quoteSyncPolicy=Object.freeze({
 ...wxgfImagePolicy,oldName:'original-image-20261031-v3',newName:'quote-sync-20261101-v1',
 oldCliSha256:'9d6da5197d410b8727386863eac45fd6ad12f61ce484b0ee17ba9e6b6fd6d893',newCliSha256:'6a95270fb64fe6d2d92b727965d3217ad96f19f236ee5262f2bcdb5dfa6427cc',
 oldOverlaySha256:'001b643bd04fbc97706aeb8618ca33b4ad50708ede61fdfc3ce44b228a5ccf15',newOverlaySha256:'7ab302bbbe6a8ad5fb48eb32620cc60b6496f7eb52587d4e0845dc48370ab480',
 oldImageQualityProof:'wechat-cdn-big-hd-exact-content-v4',newImageQualityProof:'wechat-cdn-big-hd-exact-content-v4',
 protocolOldSha256:'dde1590bf04f1c407f371c9a89dc6e6df24fc6ffa0534694fb316ca0d5c3744d',protocolNewSha256:'2b5351608063c70af73e80e9cee6868d342ffb2b32d8f46caf64cdb14846d60c',
 oldImageSha256:wxgfImagePolicy.imageSha256,oldImageTestSha256:wxgfImagePolicy.imageTestSha256,
 newQuoteProtocol:'wechat-quote-message-v1',sourceChanges:Object.freeze({"cmd/wechat-cli/notalone_quote.go":{"old":null,"new":"23d14f47cb72a0758c9086af04b300487c13bb4a3ce85b2b822888ba3186725e"},"cmd/wechat-cli/notalone_quote_test.go":{"old":null,"new":"d9b54a037616d020fff0f589444382bd9c8bd99865b63fccb6738c32d300a6af"}}),
 identityAlgorithmSha256:'e14f91c04b22b0abfd2c1035ef3030cdf4b93a0c06032ef1b0a7f365eee570f8',
});


// 图片只验证来源和完整解码，固定升级仍保持账号、来源及引用协议不变。
const imageContentPolicy=Object.freeze({
 ...quoteSyncPolicy,oldName:'quote-sync-20261101-v1',newName:'image-content-20261101-v2',
 oldCliSha256:'6a95270fb64fe6d2d92b727965d3217ad96f19f236ee5262f2bcdb5dfa6427cc',newCliSha256:'71dee721e15f74348ece3ae8428444b1fc6018f752dcc7e0040f010529b636d3',
 oldOverlaySha256:'7ab302bbbe6a8ad5fb48eb32620cc60b6496f7eb52587d4e0845dc48370ab480',newOverlaySha256:'d85391e316ff9ce8c5760940bf4e732f79ec7ee920aa18ebf82a2b1a28e125be',
 oldImageQualityProof:'wechat-cdn-big-hd-exact-content-v4',newImageQualityProof:'wechat-message-image-content-v1',
 protocolOldSha256:'2b5351608063c70af73e80e9cee6868d342ffb2b32d8f46caf64cdb14846d60c',protocolNewSha256:'2b5351608063c70af73e80e9cee6868d342ffb2b32d8f46caf64cdb14846d60c',
 oldImageSha256:'b6fa04c71f3c1b50c8062d0022a306020b0ad4e4612123a9c3e01ef8123f211e',oldImageTestSha256:'b6bc9ff5aad59b4d59d8d4625b2be4778ba3970552da990f6ca8d66f5955e89e',
 imageSha256:'e511286e25d979894d527eff48731551052db7f3ee7adacdb218707885c28eb6',imageTestSha256:'79590545dffd31afd210f2e84d02eb5910ea18caacf46ccedbbd327e0f29750b',
 oldQuoteProtocol:'wechat-quote-message-v1',newQuoteProtocol:'wechat-quote-message-v1',sourceChanges:Object.freeze({}),
 identityAlgorithmSha256:'b486521e243caec817a865aaf0d8fd44808a1ea167ac892d41a32dd8d37d71e6',
});

// 仅修复普通历史结束后的引用读取；保留已接入的图片内容合同和源码。
const quoteTailPolicy=Object.freeze({
 ...imageContentPolicy,oldName:'image-content-20261101-v2',newName:'quote-tail-20261101-v1',
 oldCliSha256:'71dee721e15f74348ece3ae8428444b1fc6018f752dcc7e0040f010529b636d3',newCliSha256:'90cda91a6e39dffc6cd07efa1ce832f5d1c69b209838c3d8e40f72b6edf00b7a',
 oldOverlaySha256:'d85391e316ff9ce8c5760940bf4e732f79ec7ee920aa18ebf82a2b1a28e125be',newOverlaySha256:'f299e92bab366fd69c4b02422fee4195aa99e18ad648ef387c81e3a440b8e283',
 oldImageQualityProof:'wechat-message-image-content-v1',newImageQualityProof:'wechat-message-image-content-v1',
 oldImageSha256:imageContentPolicy.imageSha256,oldImageTestSha256:imageContentPolicy.imageTestSha256,
 newQuoteReader:'wechat-quote-normal-tail-v1',
 sourceChanges:Object.freeze({
  'cmd/wechat-cli/notalone_quote.go':{old:'23d14f47cb72a0758c9086af04b300487c13bb4a3ce85b2b822888ba3186725e',new:'d67399218c0378176b6c903401f02e64d7b97dd5e05f5d9ea4f36c9ece4f71ea'},
  'cmd/wechat-cli/notalone_quote_test.go':{old:'d9b54a037616d020fff0f589444382bd9c8bd99865b63fccb6738c32d300a6af',new:'1b2ce2ae7c35ad8fba7d0fa75707ba24fdce2002c419271dda65415a6a75e63f'},
 }),
});

// 关闭临时引用读取器失败时清空内容并停用会话；保留已签发的首版升级合同。
const quoteTailClosePolicy=Object.freeze({
 ...quoteTailPolicy,oldName:'quote-tail-20261101-v1',newName:'quote-tail-20261101-v2',
 oldCliSha256:'90cda91a6e39dffc6cd07efa1ce832f5d1c69b209838c3d8e40f72b6edf00b7a',newCliSha256:'93e85f1b7087cd901cb69ab5ab7fa714e14cbf67ad3e86c20619159c0b4c30b8',
 oldOverlaySha256:'f299e92bab366fd69c4b02422fee4195aa99e18ad648ef387c81e3a440b8e283',newOverlaySha256:'be01c0776a3472d0262c6a1ca130f004dfb6ab421e97500bef0d021b130fe69a',
 oldQuoteReader:'wechat-quote-normal-tail-v1',newQuoteReader:'wechat-quote-normal-tail-v2',
 sourceChanges:Object.freeze({
  'cmd/wechat-cli/notalone_quote.go':{old:'d67399218c0378176b6c903401f02e64d7b97dd5e05f5d9ea4f36c9ece4f71ea',new:'8bcf887f071e5ff9d4e6f5ac39d5d084ae50b1c222619368d49691367a8b01c4'},
  'cmd/wechat-cli/notalone_quote_test.go':{old:'1b2ce2ae7c35ad8fba7d0fa75707ba24fdce2002c419271dda65415a6a75e63f',new:'7df32876fdeb4559c2667bb49aea24afcd55dcbc73a0f593086c92aff42a257e'},
 }),
});

// 正常同步直接携带引用详情；已保存占位继续使用原有补齐协议。
const quoteInlinePolicy=Object.freeze({
 ...quoteTailClosePolicy,oldName:'quote-tail-20261101-v2',newName:'quote-inline-20261101-v1',
 oldCliSha256:"93e85f1b7087cd901cb69ab5ab7fa714e14cbf67ad3e86c20619159c0b4c30b8",newCliSha256:"ad9f9a095f902aee7c5709f1d864b91cb2479f45f016f9271194ab60a9b1f9dd",
 oldOverlaySha256:"be01c0776a3472d0262c6a1ca130f004dfb6ab421e97500bef0d021b130fe69a",newOverlaySha256:"707cc2a3f2463fb5ff7f0a2e446018d07bb3c745c549c0aca4252f03f4664488",
 oldQuoteReader:'wechat-quote-normal-tail-v2',newQuoteReader:'wechat-quote-normal-tail-v2',newQuoteInline:'wechat-quote-inline-sync-v1',
 protocolOldSha256:"2b5351608063c70af73e80e9cee6868d342ffb2b32d8f46caf64cdb14846d60c",protocolNewSha256:"3d629049d5d0f911e5eba16c78a23eef9cf824981230613e1314bac7968177fa",
 sourceChanges:Object.freeze({"cmd/wechat-cli/notalone_quote.go":{"old":"8bcf887f071e5ff9d4e6f5ac39d5d084ae50b1c222619368d49691367a8b01c4","new":"12097d887c1b01f079bf5d90871f8b48a86736e2e2193c4c5d0e94fd6ab95f9d"},"cmd/wechat-cli/notalone_quote_inline.go":{"old":null,"new":"22786a35d6187ff689e09bb355ae26d855a7bbea107ad1491163f1f6ad110ef4"},"cmd/wechat-cli/notalone_quote_test.go":{"old":"7df32876fdeb4559c2667bb49aea24afcd55dcbc73a0f593086c92aff42a257e","new":"8322da44188a0e1b5017865cd527ed3f81e4f3accde586d51b2a2b3175986a65"},"cmd/wechat-cli/notalone_snapshot.go":{"old":"d9f9f40408ff6462b426d7ef01db9ee382c8c8456d635e076162c55fac3613fc","new":"9f0e158ef32491f20e334c91e0d8d890d3539c5d4efd3cb64174b818219b2928"},"cmd/wechat-cli/notalone_tail.go":{"old":"3f5708629b7744458057b8d8e4369b498e946643cc3ea2a889b9d3a7c42782fb","new":"f08df4256aa00fa32743abc5fb3cb0e6d32d2efb3591b34f295979e8eb37df29"}}),
 identityAlgorithmSha256:"0b708ebbdcb462c637286077048abe79958cdc95248007a8cd42269d9009b860",
});

// 单进程切换的固定升级配对；账号和来源身份算法保持，新增会话释放与有界名单协议。
const sharedProcessPolicy=Object.freeze({
 ...quoteInlinePolicy,
 oldName:"quote-inline-20261101-v1",
 newName:"shared-cli-20261102-v2",
 oldCliSha256:"ad9f9a095f902aee7c5709f1d864b91cb2479f45f016f9271194ab60a9b1f9dd",
 newCliSha256:"62600db86b0eb04cec57adf32cd03fe688e2a2d4241cf3f3f99a34126d348bcc",
 oldOverlaySha256:"707cc2a3f2463fb5ff7f0a2e446018d07bb3c745c549c0aca4252f03f4664488",
 newOverlaySha256:"a30971e780e77290dfb6f5425c1917f7c46bfcc847322a2b53196989629479f2",
 oldQuoteInline:"wechat-quote-inline-sync-v1",
 newQuoteInline:"wechat-quote-inline-sync-v1",
 newSharedProcessProtocol:"wechat-shared-process-v1",
 protocolOldSha256:"3d629049d5d0f911e5eba16c78a23eef9cf824981230613e1314bac7968177fa",
 protocolNewSha256:"e57b08c66dea2a5c6ee63c0122ac64ca1008b8b78b54b2d51d8e8619cd16de83",
 identityFiles:{"cmd/wechat-cli/notalone_identity_aliases.go":"a2060c261101e537a477b16e8ea706c7ccb1e90bbc1c99ebb203b23c9681193c","cmd/wechat-cli/notalone_watch_darwin.go":"697b69668348c4f26fa79d0612b579258ff5667c32dbc5a73e21851f95e294df","cmd/wechat-cli/notalone_history.go":"735ea75af0e2202e40d7cce08a2501b9e4bd5bf855077427bb8337ff34d4ca4f","cmd/wechat-cli/notalone_snapshot.go":"9f0e158ef32491f20e334c91e0d8d890d3539c5d4efd3cb64174b818219b2928","cmd/wechat-cli/notalone_account_metadata.go":"58b4eb811c8b0ac4e16ee3279aab3ae81b60ad38827f3ae8f7f4808753c88858"},
 sourceChanges:{"cmd/wechat-cli/notalone_account_metadata.go":{"old":"58b4eb811c8b0ac4e16ee3279aab3ae81b60ad38827f3ae8f7f4808753c88858","new":"934b33f197171a3eb4b0ccaf38ed0bf43996efd0fb761343360f7926acb1a78d"},"cmd/wechat-cli/notalone_selection_test.go":{"old":null,"new":"317338c933194208c08ab0c4d50d74a78564d5a4340f06a55e902a6672f36a6b"}},
 identityAlgorithmSha256:"57f92f51358595d049d3bc7d82f13ca2eccf939f611dfc057573198fc2116b0d"
});

function exactKeys(value, keys, code) {
  if (!isObject(value) || canonical(Object.keys(value).sort()) !== canonical([...keys].sort())) fail(code);
}

function assertUniqueJsonKeys(text) {
  let index = 0;
  const whitespace = () => { while (/[\t\n\r ]/.test(text[index] ?? '')) index++; };
  const string = () => {
    if (text[index] !== '"') fail('history_image_upgrade_json_invalid');
    const start = index++;
    while (index < text.length) {
      const code = text.charCodeAt(index++);
      if (code === 34) return JSON.parse(text.slice(start, index));
      if (code < 32) fail('history_image_upgrade_json_invalid');
      if (code === 92) {
        if (index >= text.length) fail('history_image_upgrade_json_invalid');
        index++;
      }
    }
    return fail('history_image_upgrade_json_invalid');
  };
  const value = depth => {
    if (depth > 64) fail('history_image_upgrade_json_invalid');
    whitespace();
    if (text[index] === '{') {
      index++; whitespace();
      const keys = new Set();
      if (text[index] === '}') { index++; return; }
      for (;;) {
        whitespace();
        const key = string();
        if (keys.has(key)) fail('history_image_upgrade_json_invalid');
        keys.add(key); whitespace();
        if (text[index++] !== ':') fail('history_image_upgrade_json_invalid');
        value(depth + 1); whitespace();
        if (text[index] === '}') { index++; return; }
        if (text[index++] !== ',') fail('history_image_upgrade_json_invalid');
      }
    }
    if (text[index] === '[') {
      index++; whitespace();
      if (text[index] === ']') { index++; return; }
      for (;;) {
        value(depth + 1); whitespace();
        if (text[index] === ']') { index++; return; }
        if (text[index++] !== ',') fail('history_image_upgrade_json_invalid');
      }
    }
    if (text[index] === '"') { string(); return; }
    const start = index;
    while (index < text.length && !/[\s,\]}]/.test(text[index])) index++;
    if (start === index) fail('history_image_upgrade_json_invalid');
    JSON.parse(text.slice(start, index));
  };
  value(0); whitespace();
  if (index !== text.length) fail('history_image_upgrade_json_invalid');
}

function parseStrictJson(bytes, code) {
  let text, value;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    assertUniqueJsonKeys(text);
    value = JSON.parse(text);
  } catch { return fail(code); }
  return value;
}

function fileMode(stat) { return Number(stat.mode & 0o777n); }
function fileIdentity(stat) { return { dev: stat.dev, ino: stat.ino }; }
function sameIdentity(left, right) { return left?.dev === right?.dev && left?.ino === right?.ino; }
function sameReadSnapshot(left, right) {
  return sameIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs && left.uid === right.uid && left.mode === right.mode;
}
function safeUserId(stat) { return typeof process.getuid === 'function' && stat.uid === BigInt(process.getuid()); }

async function assertDirectory(directory, code = 'history_image_upgrade_path_invalid') {
  let stat;
  try { stat = await lstat(directory, { bigint: true }); } catch { return fail(code); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !safeUserId(stat) || (stat.mode & 0o022n) !== 0n) fail(code);
  try { if (await realpath(directory) !== path.resolve(directory)) fail(code); } catch { return fail(code); }
  return stat;
}

async function readSecureFile(file, code, { maxBytes = 16 * 1024 ** 2, exactMode, executable = false } = {}) {
  let handle;
  try {
    const before = await lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || !safeUserId(before) || before.size < 1n || before.size > BigInt(maxBytes)
      || (before.mode & 0o022n) !== 0n || exactMode !== undefined && fileMode(before) !== exactMode
      || executable && (before.mode & 0o111n) === 0n) fail(code);
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!sameReadSnapshot(before, opened) || !opened.isFile()) fail(code);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const named = await lstat(file, { bigint: true });
    if (!sameReadSnapshot(before, after) || !sameReadSnapshot(before, named) || BigInt(bytes.length) !== after.size
      || named.isSymbolicLink()) fail(code);
    return bytes;
  } catch (error) {
    if (error?.message === code) throw error;
    return fail(code);
  } finally { await handle?.close().catch(() => {}); }
}

async function scanSourceTree(root) {
  await assertDirectory(root);
  const files = new Map();
  const limits = { entries: 0, bytes: 0n };
  async function visit(directory, prefix, depth) {
    if (depth > 32) fail('history_image_upgrade_source_mismatch');
    let names;
    try { names = (await readdir(directory)).sort(); } catch { return fail('history_image_upgrade_source_mismatch'); }
    if (names.length > 40_000) fail('history_image_upgrade_source_mismatch');
    for (const name of names) {
      if (++limits.entries > 40_000) fail('history_image_upgrade_source_mismatch');
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) fail('history_image_upgrade_source_mismatch');
      const file = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      let stat;
      try { stat = await lstat(file, { bigint: true }); } catch { return fail('history_image_upgrade_source_mismatch'); }
      if (stat.isSymbolicLink() || !safeUserId(stat) || (stat.mode & 0o022n) !== 0n) fail('history_image_upgrade_source_mismatch');
      if (stat.isDirectory()) {
        await assertDirectory(file, 'history_image_upgrade_source_mismatch');
        await visit(file, relative, depth + 1);
      } else if (stat.isFile()) {
        limits.bytes += stat.size;
        if (limits.bytes > 2n * 1024n ** 3n) fail('history_image_upgrade_source_mismatch');
        const bytes = await readSecureFile(file, 'history_image_upgrade_source_mismatch', { maxBytes: 512 * 1024 ** 2 });
        files.set(relative, digest(bytes));
      } else fail('history_image_upgrade_source_mismatch');
    }
  }
  await visit(root, '', 0);
  return files;
}

function identityAlgorithmDigest(policy) {
  const files = Object.entries(policy.identityFiles).sort(([left], [right]) => left.localeCompare(right));
  const updates=Object.entries(policy.sourceChanges??{}).filter(([name])=>Object.hasOwn(policy.identityFiles,name)).sort(([left],[right])=>left.localeCompare(right));
  return digest(JSON.stringify({ files, protocol: [policy.protocolOldSha256, policy.protocolNewSha256],...(updates.length?{updates}:{}) }));
}

function sourceOverlayDigest(files, expectedReadonlyTestSha256) {
  const readonlyPath = 'cmd/wechat-cli/notalone_readonly_test.go';
  const readonlyHash = files.get(readonlyPath);
  if (readonlyHash !== expectedReadonlyTestSha256) fail('history_image_upgrade_overlay_mismatch');
  const command = [...files.keys()].filter(name => name.startsWith('cmd/wechat-cli/notalone_') && name.endsWith('.go') && name !== readonlyPath).sort();
  const wcdb = [...files.keys()].filter(name => name.startsWith('internal/wcdb/notalone_') && name.endsWith('.go')).sort();
  if (!command.length || !wcdb.length) fail('history_image_upgrade_overlay_mismatch');
  const rows = [[readonlyPath, readonlyHash], ...command.map(name => [name, files.get(name)]), ...wcdb.map(name => [name, files.get(name)])];
  return digest(JSON.stringify(rows));
}

function assertSourcePair(oldFiles, newFiles, policy) {
  const protocol = 'cmd/wechat-cli/notalone_protocol.go';
  const image = 'cmd/wechat-cli/notalone_image.go';
  const imageTest = 'cmd/wechat-cli/notalone_image_test.go';
  if (oldFiles.get(protocol) !== policy.protocolOldSha256 || newFiles.get(protocol) !== policy.protocolNewSha256
    || oldFiles.get(image) !== policy.oldImageSha256 || oldFiles.get(imageTest) !== policy.oldImageTestSha256 || newFiles.get(image) !== policy.imageSha256
    || newFiles.get(imageTest) !== policy.imageTestSha256) fail('history_image_upgrade_source_mismatch');
  for (const [file, sha] of Object.entries(policy.identityFiles)) {
    const expectedNew=policy.sourceChanges?.[file]?.new??sha;
    if (oldFiles.get(file) !== sha || newFiles.get(file) !== expectedNew) fail('history_image_upgrade_source_mismatch');
  }
  const permitted = new Set([protocol, image, imageTest]);
  for(const [name,pair] of Object.entries(policy.sourceChanges??{})){
    // 内联同步只额外开放固定页／增量投影文件；每份仍绑定旧、新摘要，不接受任意身份源码变化。
    const allowed=/^cmd\/wechat-cli\/notalone_quote(?:_[a-z0-9]+)*\.go$/.test(name)
      ||policy.newQuoteInline==='wechat-quote-inline-sync-v1'&&/^cmd\/wechat-cli\/notalone_(?:snapshot|tail)(?:_test)?\.go$/.test(name)
      ||policy.newSharedProcessProtocol==='wechat-shared-process-v1'&&/^cmd\/wechat-cli\/notalone_(?:account_metadata|selection)(?:_test)?\.go$/.test(name);
    if(!allowed||!isObject(pair)
      ||!(pair.old===null||hashPattern.test(pair.old))||!hashPattern.test(pair.new)
      ||(oldFiles.get(name)??null)!==pair.old||newFiles.get(name)!==pair.new)fail('history_image_upgrade_source_mismatch');
    permitted.add(name);
  }
  const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  for (const name of paths) {
    if (permitted.has(name)) continue;
    if (oldFiles.get(name) !== newFiles.get(name)) fail('history_image_upgrade_source_mismatch');
  }
  // 后续图片修复允许协议保持逐字相同；允许变化的每份源码仍分别绑定旧、新摘要。
  if (![...permitted].some(name => oldFiles.get(name) !== newFiles.get(name))) fail('history_image_upgrade_source_mismatch');
}

function validateAliasRecord(record, { artifactSha256, accountKey, rootScope }) {
  exactKeys(record, ['format', 'accountKey', 'artifactSha256', 'rootScope', 'aliases'], 'history_image_upgrade_alias_invalid');
  if (record.format !== 'notalone-source-identity-aliases-v1' || record.artifactSha256 !== artifactSha256
    || record.accountKey !== accountKey || record.rootScope !== rootScope || !isObject(record.aliases)) {
    fail('history_image_upgrade_alias_invalid');
  }
  const entries = Object.entries(record.aliases);
  if (entries.length < 1 || entries.length > 4096) fail('history_image_upgrade_alias_invalid');
  const used = new Set();
  for (const [canonicalHash, legacyHash] of entries) {
    if (!hashPattern.test(canonicalHash) || !hashPattern.test(legacyHash) || canonicalHash === legacyHash || used.has(legacyHash)
      || Object.hasOwn(record.aliases, legacyHash)) fail('history_image_upgrade_alias_invalid');
    used.add(legacyHash);
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function sourceRootScope(accountKey, dbRoot) {
  if (!/^[A-Za-z0-9_.@-]{1,255}$/.test(accountKey) || typeof dbRoot !== 'string' || !path.isAbsolute(dbRoot)
    || path.normalize(dbRoot) !== dbRoot || /[\r\n\0]/.test(dbRoot)) fail('history_image_upgrade_scope_invalid');
  return digest(`${accountKey}\0${dbRoot}`);
}

async function writeExclusive(file, bytes, ownedFiles) {
  let handle;
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const stat = await handle.stat({ bigint: true });
    ownedFiles.set(file, fileIdentity(stat));
    if (!stat.isFile() || !safeUserId(stat)) fail('history_image_upgrade_write_failed');
    await handle.chmod(0o600);
    const secured = await handle.stat({ bigint: true });
    const named = await lstat(file, { bigint: true });
    if (!sameIdentity(stat, secured) || !sameIdentity(stat, named) || !secured.isFile()
      || fileMode(secured) !== 0o600 || !safeUserId(secured) || named.isSymbolicLink()) {
      fail('history_image_upgrade_write_failed');
    }
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if (error?.message === 'history_image_upgrade_write_failed') throw error;
    return fail('history_image_upgrade_write_failed');
  } finally { await handle?.close().catch(() => {}); }
}

async function removeOwnedFiles(ownedFiles) {
  for (const [file, identity] of [...ownedFiles].reverse()) {
    try {
      const current = await lstat(file, { bigint: true });
      if (current.isFile() && !current.isSymbolicLink() && sameIdentity(current, identity)) await unlink(file);
    } catch { /* 仅清理本次创建且仍为同一实例的文件。 */ }
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

function manifestForSide(policy, side) {
  const isNew = side === 'new';
  return { ...policy.commonManifest,
    overlaySha256: isNew ? policy.newOverlaySha256 : policy.oldOverlaySha256,
    cliSha256: isNew ? policy.newCliSha256 : policy.oldCliSha256,
    ...((isNew ? policy.newImageProtocol : policy.oldImageProtocol)
      ? { originalImageProtocol: isNew ? policy.newImageProtocol : policy.oldImageProtocol } : {}),
    ...((isNew ? policy.newImageQualityProof : policy.oldImageQualityProof)
      ? { originalImageQualityProof: isNew ? policy.newImageQualityProof : policy.oldImageQualityProof } : {}),
    ...((isNew?policy.newQuoteProtocol:policy.oldQuoteProtocol)?{quoteProtocol:isNew?policy.newQuoteProtocol:policy.oldQuoteProtocol}:{}),
    ...((isNew?policy.newQuoteReader:policy.oldQuoteReader)?{quoteReader:isNew?policy.newQuoteReader:policy.oldQuoteReader}:{}),
    ...((isNew?policy.newQuoteInline:policy.oldQuoteInline)?{quoteInline:isNew?policy.newQuoteInline:policy.oldQuoteInline}:{}),
    ...((isNew?policy.newSharedProcessProtocol:policy.oldSharedProcessProtocol)?{sharedProcessProtocol:isNew?policy.newSharedProcessProtocol:policy.oldSharedProcessProtocol}:{}) };
}

export function createUpgradeImageCliTools({ repositoryRoot, policy, afterReceiptPublished } = {}) {
  if (typeof repositoryRoot !== 'string' || !path.isAbsolute(repositoryRoot) || !isObject(policy)
    || afterReceiptPublished !== undefined && typeof afterReceiptPublished !== 'function') {
    fail('history_image_upgrade_arguments_invalid');
  }
  if (identityAlgorithmDigest(policy) !== policy.identityAlgorithmSha256) fail('history_image_upgrade_policy_invalid');

  async function prepareAliases({ fromRoot, toRoot, accountKey, dbRoot } = {}) {
    const buildsRoot = path.join(repositoryRoot, 'local-tools/wx-cli/.notalone-builds');
    const expectedFrom = path.join(buildsRoot, policy.oldName);
    const expectedTo = path.join(buildsRoot, policy.newName);
    if (fromRoot !== expectedFrom || toRoot !== expectedTo || !path.isAbsolute(fromRoot) || !path.isAbsolute(toRoot)) {
      fail('history_image_upgrade_path_invalid');
    }
    const rootScope = sourceRootScope(accountKey, dbRoot);
    await assertDirectory(repositoryRoot);
    for (const directory of [path.join(repositoryRoot, 'local-tools'), path.join(repositoryRoot, 'local-tools/wx-cli'), buildsRoot,
      fromRoot, toRoot, path.join(fromRoot, 'source'), path.join(toRoot, 'source'),
      path.join(fromRoot, 'bin'), path.join(fromRoot, 'lib'), path.join(toRoot, 'bin'), path.join(toRoot, 'lib'),
      path.join(repositoryRoot, 'desktop'), path.join(repositoryRoot, 'desktop/wechat-history'),
      path.join(repositoryRoot, 'desktop/wechat-patches')]) await assertDirectory(directory);
    const sidecarPath = path.join(toRoot, 'source-identity-aliases.json');
    const receiptPath = path.join(toRoot, 'source-identity-upgrade-receipt.json');
    for (const output of [sidecarPath, receiptPath]) {
      try { await lstat(output); fail('history_image_upgrade_output_exists'); }
      catch (error) { if (error?.message === 'history_image_upgrade_output_exists') throw error; if (error?.code !== 'ENOENT') fail('history_image_upgrade_file_invalid'); }
    }

    const [lockBytes, historyPatchBytes, readonlyPatchBytes, readonlyTestBytes,
      oldManifestBytes, newManifestBytes, oldAliasBytes,
      oldPatchBytes, newPatchBytes, oldReadonlyBytes, newReadonlyBytes,
      oldCliBytes, newCliBytes, oldWcdbBytes, newWcdbBytes,
      oldSourceFiles, newSourceFiles] = await Promise.all([
      readSecureFile(path.join(repositoryRoot, 'desktop/wechat-sources.lock.json'), 'history_image_upgrade_lock_invalid', { maxBytes: 2 * 1024 ** 2 }),
      readSecureFile(path.join(repositoryRoot, 'desktop/wechat-history/history-cli.patch'), 'history_image_upgrade_patch_mismatch', { maxBytes: 4 * 1024 ** 2 }),
      readSecureFile(path.join(repositoryRoot, 'desktop/wechat-patches/readonly-cli.patch'), 'history_image_upgrade_patch_mismatch', { maxBytes: 4 * 1024 ** 2 }),
      readSecureFile(path.join(repositoryRoot, 'desktop/wechat-patches/readonly-cli-test.go'), 'history_image_upgrade_patch_mismatch', { maxBytes: 2 * 1024 ** 2 }),
      readSecureFile(path.join(fromRoot, 'manifest.json'), 'history_image_upgrade_manifest_invalid', { maxBytes: 1024 ** 2, exactMode: 0o600 }),
      readSecureFile(path.join(toRoot, 'manifest.json'), 'history_image_upgrade_manifest_invalid', { maxBytes: 1024 ** 2, exactMode: 0o600 }),
      readSecureFile(path.join(fromRoot, 'source-identity-aliases.json'), 'history_image_upgrade_alias_invalid', { maxBytes: 1024 ** 2, exactMode: 0o600 }),
      readSecureFile(path.join(fromRoot, 'history-cli.patch'), 'history_image_upgrade_patch_mismatch', { maxBytes: 4 * 1024 ** 2, exactMode: 0o600 }),
      readSecureFile(path.join(toRoot, 'history-cli.patch'), 'history_image_upgrade_patch_mismatch', { maxBytes: 4 * 1024 ** 2, exactMode: 0o600 }),
      readSecureFile(path.join(fromRoot, 'readonly-cli.patch'), 'history_image_upgrade_patch_mismatch', { maxBytes: 4 * 1024 ** 2, exactMode: 0o600 }),
      readSecureFile(path.join(toRoot, 'readonly-cli.patch'), 'history_image_upgrade_patch_mismatch', { maxBytes: 4 * 1024 ** 2, exactMode: 0o600 }),
      readSecureFile(path.join(fromRoot, 'bin/wechat-cli'), 'history_image_upgrade_artifact_mismatch', { maxBytes: 512 * 1024 ** 2, executable: true }),
      readSecureFile(path.join(toRoot, 'bin/wechat-cli'), 'history_image_upgrade_artifact_mismatch', { maxBytes: 512 * 1024 ** 2, executable: true }),
      readSecureFile(path.join(fromRoot, 'lib/libWCDB.dylib'), 'history_image_upgrade_artifact_mismatch', { maxBytes: 512 * 1024 ** 2 }),
      readSecureFile(path.join(toRoot, 'lib/libWCDB.dylib'), 'history_image_upgrade_artifact_mismatch', { maxBytes: 512 * 1024 ** 2 }),
      scanSourceTree(path.join(fromRoot, 'source')),
      scanSourceTree(path.join(toRoot, 'source')),
    ]);

    if (digest(lockBytes) !== policy.commonManifest.sourceLockSha256 || digest(historyPatchBytes) !== policy.commonManifest.historyPatchSha256
      || digest(readonlyPatchBytes) !== policy.commonManifest.readonlyPatchSha256 || digest(readonlyTestBytes) !== policy.readonlyTestSha256
      || digest(oldPatchBytes) !== policy.commonManifest.historyPatchSha256 || digest(newPatchBytes) !== policy.commonManifest.historyPatchSha256
      || digest(oldReadonlyBytes) !== policy.commonManifest.readonlyPatchSha256 || digest(newReadonlyBytes) !== policy.commonManifest.readonlyPatchSha256) {
      fail('history_image_upgrade_patch_mismatch');
    }
    const lock = parseStrictJson(lockBytes, 'history_image_upgrade_lock_invalid');
    const source = lock?.gitSources?.find(item => item?.name === 'wechat-cli');
    const go = lock?.archives?.find(item => item?.name === 'go');
    const cliPatch = lock?.cliPatch;
    if (source?.commit !== policy.commonManifest.sourceCommit || source?.tree !== policy.commonManifest.sourceTree
      || source?.version !== policy.commonManifest.version || go?.version !== policy.commonManifest.goVersion
      || go?.sha256 !== policy.commonManifest.goArchiveSha256 || cliPatch?.sha256 !== policy.commonManifest.readonlyPatchSha256
      || cliPatch?.testSha256 !== policy.readonlyTestSha256 || cliPatch?.file !== 'wechat-patches/readonly-cli.patch'
      || cliPatch?.testFile !== 'wechat-patches/readonly-cli-test.go') fail('history_image_upgrade_lock_invalid');
    for (const relative of [cliPatch.file, cliPatch.testFile]) {
      if (typeof relative !== 'string' || path.posix.isAbsolute(relative) || path.posix.normalize(relative) !== relative
        || relative.split('/').some(part => part === '..' || part === '.')) fail('history_image_upgrade_lock_invalid');
    }

    const oldManifest = parseStrictJson(oldManifestBytes, 'history_image_upgrade_manifest_invalid');
    const newManifest = parseStrictJson(newManifestBytes, 'history_image_upgrade_manifest_invalid');
    if (canonical(oldManifest) !== canonical(manifestForSide(policy, 'old'))
      || canonical(newManifest) !== canonical(manifestForSide(policy, 'new'))) fail('history_image_upgrade_manifest_mismatch');
    if (digest(oldCliBytes) !== oldManifest.cliSha256 || digest(newCliBytes) !== newManifest.cliSha256
      || digest(oldWcdbBytes) !== oldManifest.wcdbSha256 || digest(newWcdbBytes) !== newManifest.wcdbSha256
      || oldManifest.wcdbSha256 !== newManifest.wcdbSha256 || oldManifest.wcdbSha256 !== policy.commonManifest.wcdbSha256) {
      fail('history_image_upgrade_artifact_mismatch');
    }
    assertSourcePair(oldSourceFiles, newSourceFiles, policy);
    if (sourceOverlayDigest(oldSourceFiles, policy.readonlyTestSha256) !== oldManifest.overlaySha256
      || sourceOverlayDigest(newSourceFiles, policy.readonlyTestSha256) !== newManifest.overlaySha256) fail('history_image_upgrade_overlay_mismatch');

    const oldRecord = parseStrictJson(oldAliasBytes, 'history_image_upgrade_alias_invalid');
    const aliases = validateAliasRecord(oldRecord, { artifactSha256: oldManifest.cliSha256, accountKey, rootScope });
    const newAliasBytes = Buffer.from(`${JSON.stringify({ format: 'notalone-source-identity-aliases-v1', accountKey,
      artifactSha256: newManifest.cliSha256, rootScope, aliases })}\n`);
    const receipt = { format: 'notalone-source-identity-upgrade-receipt-v1',
      fromArtifactSha256: oldManifest.cliSha256, toArtifactSha256: newManifest.cliSha256,
      priorAliasFileSha256: digest(oldAliasBytes), newAliasFileSha256: digest(newAliasBytes),
      sourceIdentityAlgorithmSha256: identityAlgorithmDigest(policy), sourceCommit: newManifest.sourceCommit,
      sourceTree: newManifest.sourceTree, sourceLockSha256: newManifest.sourceLockSha256,
      readonlyPatchSha256: newManifest.readonlyPatchSha256, historyPatchSha256: newManifest.historyPatchSha256,
      oldOverlaySha256: oldManifest.overlaySha256, newOverlaySha256: newManifest.overlaySha256,
      wcdbSha256: newManifest.wcdbSha256, accountKeySha256: digest(accountKey), rootScope,
      checkpointPolicy: 'recreate-with-new-artifact' };
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
    const temporarySuffix = randomUUID();
    const receiptTemporary = path.join(toRoot, `.source-identity-upgrade-receipt-${temporarySuffix}.tmp`);
    const aliasTemporary = path.join(toRoot, `.source-identity-aliases-${temporarySuffix}.tmp`);
    const ownedFiles = new Map();
    try {
      await writeExclusive(receiptTemporary, receiptBytes, ownedFiles);
      await writeExclusive(aliasTemporary, newAliasBytes, ownedFiles);
      const receiptIdentity = ownedFiles.get(receiptTemporary);
      await link(receiptTemporary, receiptPath);
      ownedFiles.set(receiptPath, receiptIdentity);
      const receiptStat = await lstat(receiptPath, { bigint: true });
      if (!sameIdentity(receiptIdentity, receiptStat) || !receiptStat.isFile() || receiptStat.isSymbolicLink()) {
        fail('history_image_upgrade_write_failed');
      }
      if (afterReceiptPublished) await afterReceiptPublished();
      const aliasIdentity = ownedFiles.get(aliasTemporary);
      await link(aliasTemporary, sidecarPath);
      ownedFiles.set(sidecarPath, aliasIdentity);
      const aliasStat = await lstat(sidecarPath, { bigint: true });
      if (!sameIdentity(aliasIdentity, aliasStat) || !aliasStat.isFile() || aliasStat.isSymbolicLink()) {
        fail('history_image_upgrade_write_failed');
      }
      await syncDirectory(toRoot);
      await unlink(receiptTemporary); ownedFiles.delete(receiptTemporary);
      await unlink(aliasTemporary); ownedFiles.delete(aliasTemporary);
      await syncDirectory(toRoot);
      ownedFiles.clear();
    } catch (error) {
      await removeOwnedFiles(ownedFiles);
      if (error?.message?.startsWith('history_image_upgrade_')) throw error;
      return fail('history_image_upgrade_write_failed');
    }
    return { status: 'prepared', artifactSha256: newManifest.cliSha256,
      sidecarPath, receiptPath, receiptSha256: digest(receiptBytes) };
  }

  return { prepareAliases };
}

const repositoryRoot = path.dirname(fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, ''));
const productionTools = createUpgradeImageCliTools({ repositoryRoot, policy: productionPolicy });
const decodingFixTools = createUpgradeImageCliTools({ repositoryRoot, policy: decodingFixPolicy });
const wxgfImageTools = createUpgradeImageCliTools({repositoryRoot,policy:wxgfImagePolicy});
const quoteSyncTools=createUpgradeImageCliTools({repositoryRoot,policy:quoteSyncPolicy});
const imageContentTools=createUpgradeImageCliTools({repositoryRoot,policy:imageContentPolicy});
const quoteTailTools=createUpgradeImageCliTools({repositoryRoot,policy:quoteTailPolicy});
const quoteTailCloseTools=createUpgradeImageCliTools({repositoryRoot,policy:quoteTailClosePolicy});
const quoteInlineTools=createUpgradeImageCliTools({repositoryRoot,policy:quoteInlinePolicy});
const sharedProcessTools=createUpgradeImageCliTools({repositoryRoot,policy:sharedProcessPolicy});
export const prepareAliases = input => input?.fromRoot===path.join(repositoryRoot,'local-tools/wx-cli/.notalone-builds',sharedProcessPolicy.oldName)
 &&input?.toRoot===path.join(repositoryRoot,'local-tools/wx-cli/.notalone-builds',sharedProcessPolicy.newName)
 ?sharedProcessTools.prepareAliases(input):input?.fromRoot===path.join(repositoryRoot,'local-tools/wx-cli/.notalone-builds',quoteInlinePolicy.oldName)
 &&input?.toRoot===path.join(repositoryRoot,'local-tools/wx-cli/.notalone-builds',quoteInlinePolicy.newName)
 ?quoteInlineTools.prepareAliases(input):input?.fromRoot===path.join(repositoryRoot,'local-tools/wx-cli/.notalone-builds',quoteTailClosePolicy.oldName)
 &&input?.toRoot===path.join(repositoryRoot,'local-tools/wx-cli/.notalone-builds',quoteTailClosePolicy.newName)
 ?quoteTailCloseTools.prepareAliases(input):input?.fromRoot===path.join(repositoryRoot,'local-tools/wx-cli/.notalone-builds',quoteTailPolicy.oldName)
 &&input?.toRoot===path.join(repositoryRoot,'local-tools/wx-cli/.notalone-builds',quoteTailPolicy.newName)
 ?quoteTailTools.prepareAliases(input):input?.fromRoot===path.join(repositoryRoot,'local-tools/wx-cli/.notalone-builds',imageContentPolicy.oldName)
 &&input?.toRoot===path.join(repositoryRoot,'local-tools/wx-cli/.notalone-builds',imageContentPolicy.newName)
 ?imageContentTools.prepareAliases(input):input?.fromRoot===path.join(repositoryRoot,'local-tools/wx-cli/.notalone-builds',quoteSyncPolicy.oldName)
 &&input?.toRoot===path.join(repositoryRoot,'local-tools/wx-cli/.notalone-builds',quoteSyncPolicy.newName)
 ?quoteSyncTools.prepareAliases(input):input?.fromRoot === path.join(repositoryRoot,'local-tools/wx-cli/.notalone-builds',wxgfImagePolicy.oldName)
 && input?.toRoot === path.join(repositoryRoot,'local-tools/wx-cli/.notalone-builds',wxgfImagePolicy.newName)
 ? wxgfImageTools.prepareAliases(input) : input?.fromRoot === path.join(repositoryRoot,'local-tools/wx-cli/.notalone-builds',decodingFixPolicy.oldName)
  && input?.toRoot === path.join(repositoryRoot,'local-tools/wx-cli/.notalone-builds',decodingFixPolicy.newName)
  ? decodingFixTools.prepareAliases(input) : productionTools.prepareAliases(input);
