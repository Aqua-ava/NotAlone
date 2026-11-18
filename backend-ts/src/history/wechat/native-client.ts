import { hasRawSourceSafety, rawSourceSafetyHistoryPatchSha256 } from './raw-source-safety.ts';
import { spawn, type ChildProcessWithoutNullStreams, type StdioOptions } from 'node:child_process';
import { sha256 } from '../../platform/sha256.ts';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { StorageFailure } from '../../storage/sqlite/contracts.ts';
import {readWechatQuotePayload,type WechatQuotePayload,type WechatQuoteSourceIdentity} from './quote-payload.ts';
import type { HistoryPage, HistoryRecord, HistoryRecoveryPosition, HistorySupportReport, HistoryTarget, HistoryTailPage } from '../sqlite/contracts.ts';
import { boundaryProtocol, type HistoryBoundaryCandidate } from '../sqlite/boundary.ts';
import { isPartitionGrowthTargetChange, isSafePartitionGrowth, historyTargetTransition } from '../partition-growth.ts';
import {
  responseLimit,
  pageResponseLimit,
  boundaryResponseLimit,
  stderrLimit,
  recoverableQuoteErrors,
  recoverableImageOpenErrors,
  fail,
  hashPattern,
  absentPrivateTargetProfile,
  systemConversations,
  allowedErrors,
  object,
  hash,
  exactInteger,
  integer,
  imageToken,
  imageIdentity,
  imageOpen,
  imageRead,
  list,
  unique,
  resolved,
  inspection,
  accountIdentity,
  accountSchema,
  accountMetadata,
  metadataDisplayName,
  privateSessionMetadata,
  opaque,
  unsigned,
  supportReport,
  historyTarget,
  historyRecord,
  historyPage,
  historyTailPage,
  historyBoundary,
  metadataKind,
  fixedSnapshotProof,
  metadataObservation,
  testMetadataObservation,
  receivedTestMetadataObservation,
  type TestMetadataState,
  metadataIdentity,
  signalValid,
  type ResolvedWechatScope,
  type WechatSchemaInspection,
  type WechatAccountSchema,
  type WechatFixedSnapshotProof,
  type WechatAccountMetadata,
  type WechatPrivateSessionMetadata,
  type WechatContactAvatarMetadata,
  type WechatMessageMetadataObservation,
  type WechatTestMetadataAction,
  type WechatTestMetadataObservation,
  type WechatReceivedTestMetadataObservation,
  type NarrowWechatClientOptions,
  type WechatImageSourceIdentity,
  type WechatImageRuntimeKey,
  type WechatImageOpenResult,
  type WechatImageReadResult,
} from './native-protocol.ts';
export type {
  ResolvedWechatScope,
  WechatSchemaColumn,
  WechatIndexColumn,
  WechatSchemaIndex,
  WechatTableSchema,
  WechatSchemaInspection,
  WechatAccountSchema,
  WechatFixedSnapshotProof,
  WechatAccountMetadata,
  WechatPrivateSessionMetadata,
  WechatContactAvatarMetadata,
  WechatMessageMetadataRecord,
  WechatMessageMetadataObservation,
  WechatTestMetadataAction,
  WechatTestMetadataObservation,
  WechatReceivedTestMetadataObservation,
  NarrowWechatClientOptions,
  WechatImageSourceIdentity,
  WechatImageRuntimeKey,
  WechatImageQualityProofV1,
  WechatImageQualityProofV2,
  WechatImageQualityProofV3,
  WechatImageQualityProofV4,
  WechatImageContentProof,
  WechatImageContentProofV2,
  WechatImageQualityProof,
  WechatImageOpenResult,
  WechatImageReadResult,
} from './native-protocol.ts';

async function artifactBytes(file: string, maximum: number): Promise<Buffer> {
  if (!path.isAbsolute(file) || path.normalize(file) !== file || await realpath(file) !== file) return fail('history_artifact_unverified');
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) return fail('history_artifact_unverified');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return fail('history_artifact_unverified');
    const bytes = await handle.readFile(); const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) return fail('history_artifact_unverified');
    return bytes;
  } finally { await handle.close(); }
}
async function verifyArtifacts(options: NarrowWechatClientOptions): Promise<void> {
  try {
    const executable = options.executable;
    if (typeof executable !== 'string' || !hashPattern.test(options.expectedCliSha256) || !hashPattern.test(options.expectedWcdbSha256)) fail('history_artifact_unverified');
    const root = path.dirname(path.dirname(executable));
    const cli = await artifactBytes(executable, 128 * 1024 * 1024);
    const wcdb = await artifactBytes(path.join(root, 'lib', 'libWCDB.dylib'), 128 * 1024 * 1024);
    const manifestBytes = await artifactBytes(path.join(root, 'manifest.json'), 64 * 1024);
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)) as Record<string, unknown>;
    if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object'
      || manifest.formatVersion !== 1 || manifest.kind !== 'notalone-history-cli-development' || manifest.architecture !== process.arch
      || manifest.sourceCommit !== '795071fa0591da5fc2c6ab94a70f22ccd93ef06c' || manifest.sourceTree !== '5d617ff3250c27fd9b33a60cb0182e153c521057'
      || manifest.readonlyPatchSha256 !== 'c143ef47728d32c5e647196c75efc33278b49647bd35f3f058b51aeb92ce06aa'
      || !hasRawSourceSafety(manifest, cli) || manifest.historyPatchSha256 !== rawSourceSafetyHistoryPatchSha256
      || manifest.signing !== 'ad-hoc-development' || manifest.realWechatVerified !== false
      || options.imageKeyChannel===true&&(manifest.originalImageProtocol!=='wechat-original-image-v1'||!['wechat-cdn-big-hd-exact-content-v4','wechat-message-image-content-v1','wechat-message-image-content-v2'].includes(manifest.originalImageQualityProof as string))
      || options.imageOpenIsolation===true&&(manifest.imageOpenIsolation!=='wechat-image-open-local-v1'||manifest.originalImageProtocol!=='wechat-original-image-v1')
      || manifest.cliSha256 !== options.expectedCliSha256 || manifest.wcdbSha256 !== options.expectedWcdbSha256
      || sha256(cli) !== options.expectedCliSha256 || sha256(wcdb) !== options.expectedWcdbSha256) fail('history_artifact_unverified');
  } catch { fail('history_artifact_unverified'); }
}
function validatedOptions(options: NarrowWechatClientOptions): NarrowWechatClientOptions {
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['executable', 'expectedCliSha256', 'expectedWcdbSha256', 'environment', 'imageKeyChannel','inlineQuotes','imageOpenIsolation'].includes(key))
      || typeof options.executable !== 'string' || typeof options.expectedCliSha256 !== 'string' || typeof options.expectedWcdbSha256 !== 'string') fail('history_request_invalid');
    if(options.imageKeyChannel!==undefined&&options.imageKeyChannel!==true)fail('history_request_invalid');
    if(options.inlineQuotes!==undefined&&options.inlineQuotes!==true)fail('history_request_invalid');
    if(options.imageOpenIsolation!==undefined&&options.imageOpenIsolation!==true)fail('history_request_invalid');
    if (options.environment !== undefined && (!options.environment || typeof options.environment !== 'object' || Array.isArray(options.environment)
      || Object.entries(options.environment).some(([key, value]) => !key.length || /[=\u0000]/.test(key) || value !== undefined && (typeof value !== 'string' || value.includes('\0'))))) fail('history_request_invalid');
    return { ...options, ...(options.environment ? { environment: { ...options.environment } } : {}) };
  } catch { return fail('history_request_invalid'); }
}
interface NativeProcess { child: ChildProcessWithoutNullStreams; exited: Promise<void>; output: Buffer; stderrBytes: number }
interface PendingResponse { operation: string; limit: number; recoverableErrors?: ReadonlySet<string>; parse(value: unknown): unknown; resolve(value: unknown): void; reject(error: StorageFailure): void }
interface ActiveImage { token: string; sourceGeneration: string; expectedBytes: number; expectedSha256: string; nextOffset: number }
/** 只提供已选目标的固定协议；正文分页另需当前支持认证，不提供通用命令、SQL或路径RPC。 */
export class NarrowWechatClient {
  readonly #stoppedSignal=Promise.withResolvers<void>();
  readonly #stopListeners=new Set<()=>void>();
  readonly #options: NarrowWechatClientOptions;
  #queue: Promise<void> = Promise.resolve();
  #native?: NativeProcess;
  #selected?: ResolvedWechatScope;
  #account?: WechatAccountMetadata;
  #schema?: WechatSchemaInspection;
  #support?: HistorySupportReport;
  #growthFromSchema?: string;
  #target?: HistoryTarget;
  #activeImage?: ActiveImage;
  #imageKeyChannelUsed=false;
  #imageKeySupplied=false;
  #tailCursor?: string;
  #lastTail?: { input: string; page: HistoryTailPage };
  #testMetadata?: TestMetadataState;
  #receivedTestMetadata?: TestMetadataState;
  #pending?: PendingResponse;
  #stopped = false;
  #failureCode = 'history_native_closed';
  #stopping?: Promise<void>;
  constructor(options: NarrowWechatClientOptions) { this.#options = validatedOptions(options); }
  get stopped():Promise<void>{return this.#stoppedSignal.promise;}
  /** 长寿命共享进程的可撤销守卫订阅；已关闭的会话必须释放订阅。 */
  onStopped(listener:()=>void):()=>void {
    if(typeof listener!=='function')return fail('history_request_invalid');
    if(this.#stopped){listener();return ()=>{};}
    this.#stopListeners.add(listener);
    return ()=>{this.#stopListeners.delete(listener);};
  }
  get stoppedReason():string|null{return this.#stopped?this.#failureCode:null;}
  inspectAccountSchema(signal?: AbortSignal): Promise<WechatAccountSchema> {
    try { signalValid(signal); } catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(() => this.#request({op:'inspect-account-schema',consent:'account-schema-v1'}, value => {
      const parsed = accountSchema(value);
      if (this.#selected && (parsed.accountKey !== this.#selected.accountKey || parsed.sourceGeneration !== this.#selected.sourceGeneration)
        || this.#account && (parsed.accountKey !== this.#account.accountKey || parsed.sourceGeneration !== this.#account.sourceGeneration)) fail('history_scope_changed');
      return parsed;
    }), signal);
  }
  accountMetadata(signal?: AbortSignal): Promise<WechatAccountMetadata> {
    try { signalValid(signal); } catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(() => this.#request({op:'metadata-account',consent:'account-session-metadata-v1'}, value => {
      const parsed = accountMetadata(value, this.#options);
      if (this.#account && JSON.stringify(parsed) !== JSON.stringify(this.#account)
        || this.#selected && (parsed.accountKey !== this.#selected.accountKey || parsed.sourceGeneration !== this.#selected.sourceGeneration)) fail('history_scope_changed');
      this.#account = structuredClone(parsed); return parsed;
    }), signal);
  }
  privateSessionMetadata(evidence: WechatAccountMetadata, signal?: AbortSignal): Promise<WechatPrivateSessionMetadata> {
    try { signalValid(signal); accountMetadata(evidence, this.#options); }
    catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(() => {
      if (!this.#account || JSON.stringify(evidence) !== JSON.stringify(this.#account)) return fail('history_scope_unverified');
      if (this.#account.status !== 'verified') return fail('history_metadata_profile_unverified');
      const account = this.#account;
      return this.#request({op:'metadata-sessions',account:account.accountKey,consent:'private-session-list-metadata-v1'}, value => privateSessionMetadata(value, account, this.#options), 4 * 1024 * 1024);
    }, signal);
  }
  /** 精确读取一位已确认联系人的展示头像；不枚举名单、不创建正文资格。 */
  contactAvatarMetadata(evidence: WechatAccountMetadata, username: string, signal?: AbortSignal): Promise<WechatContactAvatarMetadata> {
    try { signalValid(signal); accountMetadata(evidence, this.#options); accountIdentity(username);
      if (systemConversations.has(username) || username === evidence.accountKey || username.startsWith('@') || username.startsWith('gh_') || username.startsWith('biz_')
        || ['@chatroom', '@weclaw', '@openim', '@stranger'].some(suffix => username.endsWith(suffix))
        || ['brandsessionholder', 'brandservicesessionholder'].includes(username)) fail('history_request_invalid');
    } catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(() => {
      if (!this.#account || this.#account.status !== 'verified' || JSON.stringify(evidence) !== JSON.stringify(this.#account)) return fail('history_scope_unverified');
      return this.#request({op: 'metadata-avatar', account: evidence.accountKey, conversation: username, consent: 'selected-contact-avatar-metadata-v1'}, value => {
        const row = object(value, ['format', 'account', 'username', 'avatar']);
        const account = accountMetadata(row.account, this.#options);
        if (row.format !== 'wechat-contact-avatar-local-v1' || JSON.stringify(account) !== JSON.stringify(evidence) || row.username !== username) return fail();
        let avatar: WechatContactAvatarMetadata['avatar'] = null;
        if (row.avatar !== null) {
          const image = object(row.avatar, ['mimeType', 'dataBase64']);
          if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mimeType as string)
            || typeof image.dataBase64 !== 'string' || !image.dataBase64.length || image.dataBase64.length > Math.ceil(256 * 1024 / 3) * 4
            || image.dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.dataBase64)) return fail();
          const bytes = Buffer.from(image.dataBase64, 'base64');
          if (bytes.length > 256 * 1024 || bytes.toString('base64') !== image.dataBase64) return fail();
          avatar = {mimeType: image.mimeType as NonNullable<WechatContactAvatarMetadata['avatar']>['mimeType'], dataBase64: image.dataBase64};
        }
        return {format: 'wechat-contact-avatar-local-v1', account, username, avatar};
      }, Math.ceil(256 * 1024 / 3) * 4 + 16 * 1024);
    }, signal);
  }
  /** 仅释放会话资源；账号级来源守卫与一次性图片密钥通道继续属于当前进程。 */
  releaseSelection(signal?:AbortSignal):Promise<void> {
    try { signalValid(signal); } catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(async()=>{
      const scope=this.#selected;
      if(!scope)return;
      await this.#request({op:'release-selection',account:scope.accountKey,conversation:scope.conversationKey,consent:'selected-metadata-v1'},value=>{
        const row=object(value,['released']);if(row.released!==true)return fail();return true;
      });
      this.#selected=undefined;this.#schema=undefined;this.#support=undefined;this.#growthFromSchema=undefined;
      this.#target=undefined;this.#tailCursor=undefined;this.#lastTail=undefined;
      this.#testMetadata=undefined;this.#receivedTestMetadata=undefined;this.#activeImage=undefined;
    },signal);
  }
  allSessionMetadata(evidence:WechatAccountMetadata,options:{limit:number;keyword?:string},signal?:AbortSignal):Promise<{username:string;displayName:string;kind:string}[]> {
    try {signalValid(signal);accountMetadata(evidence,this.#options);
      if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['limit','keyword'].includes(key))||!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>5000
        ||options.keyword!==undefined&&(typeof options.keyword!=='string'||Buffer.byteLength(options.keyword)>255||/[\u0000-\u001f\u007f]/.test(options.keyword)))fail('history_request_invalid');
    }catch{return Promise.reject(new StorageFailure('history_request_invalid'));}
    return this.#enqueue(()=>{
      if(!this.#account||this.#account.status!=='verified'||JSON.stringify(evidence)!==JSON.stringify(this.#account))return fail('history_scope_unverified');
      return this.#request({op:'metadata-sessions-all',account:evidence.accountKey,consent:'all-session-list-metadata-v1',limit:options.limit,...(options.keyword===undefined?{}:{keyword:options.keyword})},value=>{
        const row=object(value,['format','account','sessions']),account=accountMetadata(row.account,this.#options);
        if(row.format!=='wechat-all-session-metadata-v1'||JSON.stringify(account)!==JSON.stringify(evidence))return fail();
        const sessions=list(row.sessions,options.limit,value=>{
          const item=object(value,['username','displayName','kind']),username=accountIdentity(item.username);
          if(typeof item.kind!=='string'||!['private','group','folded','bot','official_account','corp_im','stranger'].includes(item.kind))return fail();
          return {username,displayName:metadataDisplayName(item.displayName,username),kind:item.kind};
        });
        unique(sessions.map(row=>row.username));return sessions;
      },4*1024*1024);
    },signal);
  }
  resolveSelected(name: string, signal?: AbortSignal): Promise<ResolvedWechatScope> {
    try { signalValid(signal); if (typeof name !== 'string' || !name.length || Buffer.byteLength(name, 'utf8') > 255 || /[\u0000\r\n]/.test(name)) fail('history_request_invalid'); }
    catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(async () => {
      const scope = await this.#request({ op: 'resolve', displayName: name, consent: 'selected-metadata-v1' }, value => {
        const parsed = resolved(value);
        if (this.#account && (parsed.accountKey !== this.#account.accountKey || parsed.sourceGeneration !== this.#account.sourceGeneration)) return fail('history_scope_changed');
        return parsed;
      });
      this.#selected = { ...scope }; this.#schema = undefined; this.#support = undefined; this.#growthFromSchema=undefined; this.#target = undefined; this.#tailCursor = undefined; this.#lastTail = undefined; return scope;
    }, signal);
  }
  inspectSelected(signal?: AbortSignal): Promise<WechatSchemaInspection> {
    try { signalValid(signal); } catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(async () => {
      const scope = this.#selected;
      if (!scope) return fail('history_scope_unverified');
      return this.#request({ op: 'inspect', account: scope.accountKey, conversation: scope.conversationKey, consent: 'selected-schema-v1' }, value => {
        const parsed = inspection(value, scope);
        if(this.#schema&&this.#schema.schemaFingerprint!==parsed.schemaFingerprint){
          if(this.#growthFromSchema||this.#support?.capabilities?.partitionGrowth!=='supported'||!isSafePartitionGrowth(this.#schema,parsed))fail('history_support_changed');
          this.#growthFromSchema=this.#schema.schemaFingerprint;
        }
        if(this.#support&&this.#support.schemaFingerprint!==parsed.schemaFingerprint&&this.#growthFromSchema!==this.#support.schemaFingerprint)fail('history_support_changed');
        this.#schema = structuredClone(parsed); return parsed;
      });
    }, signal);
  }
  observeMetadataSelected(kind: HistoryRecord['kind'], signal?: AbortSignal): Promise<WechatMessageMetadataObservation> {
    try { signalValid(signal); if (!['text', 'image', 'voice', 'video', 'file', 'sticker', 'other'].includes(kind)) fail('history_request_invalid'); }
    catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(async () => {
      const scope = this.#selected, schema = this.#schema;
      if (!scope || !schema) return fail('history_scope_unverified');
      return this.#request({ op: 'observe-metadata', account: scope.accountKey, conversation: scope.conversationKey,
        consent: 'selected-message-metadata-v1', kind }, value => metadataObservation(value, scope, schema, kind));
    }, signal);
  }
  verifySnapshotMetadataSelected(signal?:AbortSignal):Promise<WechatFixedSnapshotProof>{
    try{signalValid(signal);}catch{return Promise.reject(new StorageFailure('history_request_invalid'));}
    return this.#enqueue(async()=>{
      const scope=this.#selected,schema=this.#schema;
      if(!scope||!schema)return fail('history_scope_unverified');
      return this.#request({op:'verify-snapshot-metadata',account:scope.accountKey,conversation:scope.conversationKey,consent:'selected-snapshot-metadata-v1'},
        value=>fixedSnapshotProof(value,scope,schema));
    },signal);
  }
  observeTestMetadataSelected(action: WechatTestMetadataAction, signal?: AbortSignal): Promise<WechatTestMetadataObservation> {
    try { signalValid(signal); if (!['arm', 'next', 'current'].includes(action)) fail('history_request_invalid'); }
    catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(async () => {
      const scope = this.#selected, schema = this.#schema, previous = this.#testMetadata;
      if (!scope || !schema) return fail('history_scope_unverified');
      if (action === 'arm' && previous) return fail('history_request_invalid');
      if (action !== 'arm' && !previous) return fail('history_snapshot_closed');
      if (previous && (previous.scopeDigest !== schema.scopeDigest || previous.sourceGeneration !== scope.sourceGeneration)) {
        await this.#stop('history_source_changed'); return fail('history_source_changed');
      }
      if (previous && previous.schemaFingerprint !== schema.schemaFingerprint) {
        await this.#stop('history_schema_changed'); return fail('history_schema_changed');
      }
      return this.#request({ op: 'observe-test-metadata', account: scope.accountKey, conversation: scope.conversationKey,
        consent: 'selected-test-lifecycle-metadata-v1', kind: action }, value => {
        const parsed = testMetadataObservation(value, scope, schema, action), identities = [...(previous?.identities ?? [])];
        if (action === 'arm' ? parsed.lockedCount !== 0 : parsed.lockedCount < identities.length
          || parsed.lockedCount > identities.length + (action === 'next' ? 1 : 0)) return fail('history_identity_ambiguous');
        parsed.records.forEach((record, index) => {
          if (index < identities.length) {
            if (record !== null && metadataIdentity(record) !== identities[index]) fail('history_identity_ambiguous');
          } else {
            if (record === null || record.localId === null || record.sender !== 'owner' || metadataKind(record.originalType) !== 'text') return fail('history_identity_ambiguous');
            const identity = metadataIdentity(record);
            if (identities.includes(identity)) fail('history_identity_ambiguous');
            identities.push(identity);
          }
        });
        this.#testMetadata = { scopeDigest: parsed.scopeDigest, sourceGeneration: parsed.sourceGeneration, schemaFingerprint: parsed.schemaFingerprint, identities };
        return parsed;
      });
    }, signal);
  }
  observeReceivedTestMetadataSelected(action: WechatTestMetadataAction, signal?: AbortSignal): Promise<WechatReceivedTestMetadataObservation> {
    try { signalValid(signal); if (!['arm', 'next', 'current'].includes(action)) fail('history_request_invalid'); }
    catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(async () => {
      const scope = this.#selected, schema = this.#schema, previous = this.#receivedTestMetadata;
      if (!scope || !schema) return fail('history_scope_unverified');
      if (action === 'arm' && previous) return fail('history_request_invalid');
      if (action !== 'arm' && !previous) return fail('history_snapshot_closed');
      if (previous && (previous.scopeDigest !== schema.scopeDigest || previous.sourceGeneration !== scope.sourceGeneration)) {
        await this.#stop('history_source_changed'); return fail('history_source_changed');
      }
      if (previous && previous.schemaFingerprint !== schema.schemaFingerprint) {
        await this.#stop('history_schema_changed'); return fail('history_schema_changed');
      }
      return this.#request({ op: 'observe-received-test-metadata', account: scope.accountKey, conversation: scope.conversationKey,
        consent: 'selected-received-test-lifecycle-metadata-v1', kind: action }, value => {
        const parsed = receivedTestMetadataObservation(value, scope, schema, action), identities = [...(previous?.identities ?? [])];
        if (action === 'arm' ? parsed.lockedCount !== 0 : parsed.lockedCount < identities.length
          || parsed.lockedCount > identities.length + (action === 'next' ? 1 : 0)
          || action === 'current' && parsed.lockedCount !== identities.length) return fail('history_identity_ambiguous');
        parsed.records.forEach((record, index) => {
          if (index < identities.length) {
            if (record !== null && metadataIdentity(record) !== identities[index]) fail('history_identity_ambiguous');
          } else {
            if (record === null || record.localId === null || record.sender !== 'contact' || metadataKind(record.originalType) !== 'text') return fail('history_identity_ambiguous');
            const identity = metadataIdentity(record);
            if (identities.includes(identity)) fail('history_identity_ambiguous');
            identities.push(identity);
          }
        });
        this.#receivedTestMetadata = { scopeDigest: parsed.scopeDigest, sourceGeneration: parsed.sourceGeneration, schemaFingerprint: parsed.schemaFingerprint, identities };
        return parsed;
      });
    }, signal);
  }
  supportSelected(signal?: AbortSignal): Promise<HistorySupportReport> {
    try { signalValid(signal); } catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(async () => {
      const scope = this.#selected;
      if (!scope) return fail('history_scope_unverified');
      return this.#request({ op: 'support', account: scope.accountKey, conversation: scope.conversationKey, consent: 'selected-schema-v1' }, value => {
        const parsed = supportReport(value, scope, this.#options.expectedCliSha256);
        if (parsed.status === 'supported' && (parsed.profileId === absentPrivateTargetProfile
          ? !this.#schema || this.#schema.tables.length > 0
          : this.#schema?.tables.length === 0)) fail();
        if (parsed.status === 'supported' && this.#schema && this.#schema.tables.some(table => JSON.stringify(table.declaredPrimaryKey) !== JSON.stringify(parsed.declaredPrimaryKey))) fail();
        const growth=this.#support&&this.#growthFromSchema===this.#support.schemaFingerprint&&isPartitionGrowthTargetChange(this.#support,parsed);
        if (this.#schema && parsed.schemaFingerprint !== this.#schema.schemaFingerprint
          || this.#support && parsed.schemaFingerprint !== this.#support.schemaFingerprint&&!growth
          || this.#support?.status === 'supported' && parsed.status === 'supported' && JSON.stringify(parsed) !== JSON.stringify(this.#support)&&!growth) fail('history_support_changed');
        if (parsed.status !== 'supported') { this.#target = undefined; this.#tailCursor = undefined; this.#lastTail = undefined; }
        this.#support = structuredClone(parsed);this.#growthFromSchema=undefined; return parsed;
      });
    }, signal);
  }
  targetSelected(signal?: AbortSignal): Promise<HistoryTarget> {
    try { signalValid(signal); } catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(async () => {
      const scope = this.#readableScope();
      return this.#request({ op: 'target', account: scope.accountKey, conversation: scope.conversationKey, consent: 'selected-history-v1' }, value => {
        const parsed = historyTarget(value, scope, this.#schema); this.#target = structuredClone(parsed); this.#tailCursor = undefined; this.#lastTail = undefined;  return parsed;
      });
    }, signal);
  }
  supplyImageRuntimeKey(key:WechatImageRuntimeKey|null,signal?:AbortSignal):Promise<void>{
    const keyBytes=key?.aesKey instanceof Uint8Array?key.aesKey:undefined;
    const operation=(async()=>{
      try{
        signalValid(signal);
        await this.#enqueue(async()=>{
          const scope=this.#readableScope();
          if(!this.#options.imageKeyChannel||this.#imageKeyChannelUsed)return fail('history_image_key_unavailable');
          const native=this.#native;
          if(!native||this.#stopped)return fail(this.#stopped?this.#failureCode:'history_image_key_unavailable');
          const pipe=native.child.stdio[3] as Writable|undefined;
          if(!pipe)return fail('history_image_key_unavailable');
          let payload:Buffer|undefined;
          try{
            if(key!==null){
              if(!key||typeof key!=='object'||Object.keys(key).length!==4||!['accountKey','rootSha256','aesKey','xorKey'].every(field=>Object.hasOwn(key,field))
                ||key.accountKey!==scope.accountKey||typeof key.rootSha256!=='string'||!hashPattern.test(key.rootSha256)
                ||!(key.aesKey instanceof Uint8Array)||key.aesKey.byteLength!==16||!Number.isInteger(key.xorKey)||key.xorKey<0||key.xorKey>255)
                return fail('history_image_key_unavailable');
              const encodedKey=Buffer.from(key.aesKey);
              try{
                const serialized=JSON.stringify({accountKey:key.accountKey,rootSha256:key.rootSha256,aesKey:encodedKey.toString('base64'),xorKey:key.xorKey});
                payload=Buffer.from(serialized,'utf8');
              }finally{encodedKey.fill(0);}
              if(payload.length>512)return fail('history_image_key_unavailable');
            }
            this.#imageKeyChannelUsed=true;
            await new Promise<void>((resolve,reject)=>{
              const onError=(error:Error)=>{pipe.off('error',onError);reject(new StorageFailure('history_image_key_unavailable'));};
              pipe.once('error',onError);
              try{if(payload)pipe.end(payload,()=>{pipe.off('error',onError);resolve();});else pipe.end(()=>{pipe.off('error',onError);resolve();});}
              catch(error){pipe.off('error',onError);reject(error);}
            });
            if(key!==null)this.#imageKeySupplied=true;
          }finally{payload?.fill(0);}
        },signal);
      }finally{keyBytes?.fill(0);}
    })();
    return operation;
  }
  openImageSelected(target: HistoryTarget, identity: WechatImageSourceIdentity, signal?: AbortSignal): Promise<WechatImageOpenResult> {
    let source:WechatImageSourceIdentity;
    try { signalValid(signal); source=imageIdentity(identity); }
    catch { return Promise.reject(new StorageFailure('history_image_request_invalid')); }
    return this.#enqueue(async()=>{
      const scope=this.#readableScope(),accepted=this.#target;
      const parsed=historyTarget(target,scope,this.#schema);
      if(!accepted||JSON.stringify(parsed)!==JSON.stringify(accepted))return fail('history_target_unverified');
      if(this.#activeImage)return fail('history_image_request_invalid');
      if(!accepted.tables.some(item=>item.partition===source.partition&&item.instance===source.table))return fail('history_image_association_unverified');
      const request:Record<string,string|number|boolean>={op:'image-open',account:scope.accountKey,conversation:scope.conversationKey,consent:'selected-image-v1',
        target:accepted.descriptor,partition:source.partition,table:source.table,localId:source.localId,serverId:source.serverId,sentAt:source.sentAt};
      if(this.#imageKeySupplied)request.imageKeySupplied=true;
      const opened=await this.#request(request,
        value=>imageOpen(value,scope,accepted,source,32*1024*1024),undefined,this.#options.imageOpenIsolation?recoverableImageOpenErrors:undefined);
      this.#activeImage={token:opened.resourceToken,sourceGeneration:opened.sourceGeneration,expectedBytes:opened.expectedBytes,expectedSha256:opened.expectedSha256,nextOffset:0};
      return opened;
    },signal);
  }
  readQuoteSelected(target:HistoryTarget,source:WechatQuoteSourceIdentity,signal?:AbortSignal):Promise<WechatQuotePayload> {
    try{signalValid(signal);hash(source.partition);hash(source.table);unsigned(source.localId);unsigned(source.serverId);if(source.sentAt!==null)unsigned(source.sentAt);}
    catch{return Promise.reject(new StorageFailure('history_quote_request_invalid'));}
    return this.#enqueue(async()=>{
      const scope=this.#readableScope(),accepted=this.#target,parsed=historyTarget(target,scope,this.#schema);
      if(!accepted||JSON.stringify(parsed)!==JSON.stringify(accepted))return fail('history_target_unverified');
      if(!accepted.tables.some(item=>item.partition===source.partition&&item.instance===source.table))return fail('history_quote_association_unverified');
      return this.#request({op:'quote-read',account:scope.accountKey,conversation:scope.conversationKey,consent:'selected-quote-v1',
        target:accepted.descriptor,...source,sentAt:source.sentAt??''},value=>readWechatQuotePayload(value,scope,source),256*1024,recoverableQuoteErrors);
    },signal);
  }
  readImageSelected(resourceToken:string, offset:number, signal?:AbortSignal):Promise<WechatImageReadResult> {
    let token:string;
    try {signalValid(signal);token=imageToken(resourceToken);integer(offset,32*1024*1024);}
    catch {return Promise.reject(new StorageFailure('history_image_request_invalid'));}
    return this.#enqueue(async()=>{
      const active=this.#activeImage;
      if(!active||active.token!==token)return fail('history_image_token_invalid');
      if(offset!==active.nextOffset||offset>=active.expectedBytes)return fail('history_image_offset_invalid');
      return this.#request({op:'image-read',resourceToken:active.token,offset},
        value=>imageRead(value,active,offset));
    },signal);
  }
  closeImageSelected(resourceToken:string, signal?:AbortSignal):Promise<void> {
    let token:string;
    try {signalValid(signal);token=imageToken(resourceToken);}
    catch {return Promise.reject(new StorageFailure('history_image_request_invalid'));}
    return this.#enqueue(async()=>{
      const active=this.#activeImage;
      if(!active||active.token!==token)return fail('history_image_token_invalid');
      await this.#request({op:'image-close',resourceToken:active.token},value=>{
        const row=object(value,['closed']);if(row.closed!==true)return fail('history_image_token_invalid');return true;
      });
      this.#activeImage=undefined;
    },signal);
  }
  recoverTargetSelected(previous:HistoryTarget,positions:readonly HistoryRecoveryPosition[],signal?:AbortSignal):Promise<{target:HistoryTarget;cursor:string;anchors:readonly HistoryRecord[]}> {
    try { signalValid(signal); } catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(async()=>{
      const scope=this.#readableScope();
      if(this.#support?.capabilities?.recoverFromLocalIds!=='supported')return fail('history_tail_unsupported');
      const old=historyTarget(previous,scope);
      const current=this.#schema&&{protocol:'private-history-v1' as const,descriptor:'current-schema',sourceGeneration:scope.sourceGeneration,
        partitions:this.#schema.tables.length?[...new Set(this.#schema.tables.map(table=>table.partition))]:this.#schema.checkedPartitions,
        tables:this.#schema.tables.map(table=>({partition:table.partition,instance:table.target})),checkedPartitions:this.#schema.checkedPartitions};
      if(!current||!historyTargetTransition(old,current,this.#support.capabilities?.partitionGrowth==='supported'))return fail('history_target_unverified');
      const checked=list(positions,128,value=>{
        const row=object(value,['partition','table','maxLocalId','anchorLocalIds']);
        const partition=hash(row.partition),table=hash(row.table),maxLocalId=exactInteger(row.maxLocalId,true);
        const anchorLocalIds=list(row.anchorLocalIds,8,id=>exactInteger(id,true));unique(anchorLocalIds);
        if(!old.tables.some(item=>item.partition===partition&&item.instance===table)||anchorLocalIds.some(id=>BigInt(id)>BigInt(maxLocalId)))return fail('history_request_invalid');
        return {partition,table,maxLocalId,anchorLocalIds};
      });
      unique(checked.map(row=>row.partition));if(checked.length!==old.tables.length)return fail('history_request_invalid');
      const requested=new Set(checked.flatMap(row=>row.anchorLocalIds.map(id=>JSON.stringify([row.partition,row.table,id]))));
      return this.#request({op:'recover-target',account:scope.accountKey,conversation:scope.conversationKey,consent:'selected-history-v1',previousTarget:old,positions:checked},value=>{
        const row=object(value,['target','cursor','anchors']);
        const target=historyTarget(row.target,scope,this.#schema),cursor=opaque(row.cursor);
        if(!historyTargetTransition(old,target,this.#support?.capabilities?.partitionGrowth==='supported'))return fail('history_target_unverified');
        const anchors=list(row.anchors,1024,value=>historyRecord(value,target));
        const identities=anchors.map(row=>JSON.stringify([row.partition,row.table,row.localId]));unique(identities);
        if(identities.some(id=>!requested.has(id)))return fail();
        this.#target=structuredClone(target);this.#tailCursor=undefined;this.#lastTail=undefined;
        return {target,cursor,anchors};
      },pageResponseLimit);
    },signal);
  }
  resumeTargetSelected(previous: HistoryTarget, cursor: string, signal?: AbortSignal): Promise<HistoryTarget | null> {
    try { signalValid(signal); opaque(cursor); } catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(async () => {
      const scope=this.#readableScope();
      if(this.#support?.capabilities?.durableIncremental!=='supported')return fail('history_tail_unsupported');
      const old=historyTarget(previous,scope);
      const current=this.#schema&&{protocol:'private-history-v1' as const,descriptor:'current-schema',sourceGeneration:scope.sourceGeneration,
        partitions:this.#schema.tables.length?[...new Set(this.#schema.tables.map(table=>table.partition))]:this.#schema.checkedPartitions,
        tables:this.#schema.tables.map(table=>({partition:table.partition,instance:table.target})),checkedPartitions:this.#schema.checkedPartitions};
      if(!current||!historyTargetTransition(old,current,this.#support.capabilities?.partitionGrowth==='supported'))return fail('history_target_unverified');
      return this.#request({op:'resume-target',account:scope.accountKey,conversation:scope.conversationKey,consent:'selected-history-v1',target:old.descriptor,cursor},value=>{
        if(value===null)return null;
        const parsed=historyTarget(value,scope,this.#schema);
        if(!historyTargetTransition(old,parsed,this.#support?.capabilities?.partitionGrowth==='supported'))return fail('history_target_unverified');
        this.#target=structuredClone(parsed);this.#tailCursor=undefined;this.#lastTail=undefined;return parsed;
      });
    },signal);
  }
  pageSelected(target: HistoryTarget, cursor: string | null, signal?: AbortSignal, options?:{checkpoint?:boolean}): Promise<HistoryPage> {
    try { signalValid(signal); if (cursor !== null) opaque(cursor);
      if(options!==undefined&&(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='checkpoint')||options.checkpoint!==undefined&&typeof options.checkpoint!=='boolean'))return fail('history_request_invalid');
    }
    catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(async () => {
      const scope = this.#readableScope();
      const checkpoint=options?.checkpoint===true;
      if(checkpoint&&(this.#support?.capabilities?.durableHistory!=='supported'||this.#support?.capabilities?.durableIncremental!=='supported'))return fail('history_request_invalid');
      let parsed: HistoryTarget;
      try { parsed = historyTarget(target, scope, this.#schema); } catch { return fail('history_target_unverified'); }
      if (!this.#target || JSON.stringify(parsed) !== JSON.stringify(this.#target)) return fail('history_target_unverified');
      const accepted = this.#target;
      return this.#request({ op: 'page', account: scope.accountKey, conversation: scope.conversationKey, consent: 'selected-history-v1', target: accepted.descriptor, cursor: cursor ?? '',...(checkpoint?{checkpoint:true}:{}) }, value => {
        const inlineQuoteScope=this.#options.inlineQuotes?scope:undefined;
        const page = historyPage(value, accepted, cursor,inlineQuoteScope,checkpoint);
        if (page.resumeCursor && this.#support?.capabilities?.incrementalTail !== 'supported') return fail();
        if (page.resumeCursor) this.#tailCursor = page.resumeCursor;
        return page;
      }, pageResponseLimit);
    }, signal);
  }
  /** 恢复检查点先读完本轮差异快照；增量只接受本轮终页给出的游标。 */
  tailSelected(target: HistoryTarget, cursor: string, signal?: AbortSignal): Promise<HistoryTailPage> {
    try { signalValid(signal); opaque(cursor); }
    catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(() => {
      const scope = this.#readableScope();
      if (this.#support?.capabilities?.incrementalTail !== 'supported') return fail('history_tail_unsupported');
      const parsed = historyTarget(target, scope, this.#schema);
      if (!this.#target || JSON.stringify(parsed) !== JSON.stringify(this.#target)) return fail('history_target_unverified');
      const replay = this.#lastTail?.input === cursor;
      if (cursor !== this.#tailCursor && !replay) return fail('history_cursor_invalid');
      return this.#request({ op: 'tail', account: scope.accountKey, conversation: scope.conversationKey, consent: 'selected-history-v1', target: parsed.descriptor, cursor }, value => {
        const page = historyTailPage(value, parsed, cursor,this.#options.inlineQuotes?scope:undefined);
        // 重放仍交给原生守卫复验，只接受上一页的相同响应，不能改变已交付检查点。
        if (replay) { if (JSON.stringify(page) !== JSON.stringify(this.#lastTail!.page)) return fail('history_protocol_invalid'); }
        else { this.#tailCursor = page.cursorOut; this.#lastTail = { input: cursor, page: structuredClone(page) }; }
        return page;
      }, pageResponseLimit);
    }, signal);
  }
  /** 返回元数据边界，正文/媒体不属于此协议；能力未经认证时零RPC拒绝。 */
  boundarySnapshotSelected(signal?: AbortSignal): Promise<HistoryBoundaryCandidate> {
    try { signalValid(signal); } catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(() => {
      const scope = this.#readableScope(), schema = this.#schema, support = this.#support!;
      if (!schema) return fail('history_scope_unverified');
      if (support.capabilities?.[boundaryProtocol] !== 'supported') return fail('history_boundary_unsupported');
      return this.#request({ op: 'boundary-snapshot', account: scope.accountKey, conversation: scope.conversationKey, consent: 'selected-history-boundary-v1' }, value => historyBoundary(value, scope, schema, structuredClone(support)), boundaryResponseLimit);
    }, signal);
  }
  #readableScope(): ResolvedWechatScope {
    if (!this.#selected) return fail('history_scope_unverified');
    if (this.#support?.status === 'unsupported') return fail('history_support_unsupported');
    if (this.#support?.status !== 'supported') return fail('history_support_unverified');
    return this.#selected;
  }
  #enqueue<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new StorageFailure('history_native_cancelled'));
    const abort = () => { void this.#stop('history_native_cancelled'); };
    signal?.addEventListener('abort', abort, { once: true });
    const operation = this.#queue.then(async () => {
      if (this.#stopped) return fail(this.#failureCode);
      if (signal?.aborted) return fail('history_native_cancelled');
      const timer = setTimeout(() => { void this.#stop('history_native_timeout'); }, 10_000);
      try { return await work(); }
      catch (error) {
        if (error instanceof StorageFailure && allowedErrors.has(error.code)) throw error;
        return fail('history_native_unavailable');
      } finally { clearTimeout(timer); }
    }).finally(() => signal?.removeEventListener('abort', abort));
    this.#queue = operation.then(() => {}, () => {});
    return operation;
  }
  async #start(): Promise<NativeProcess> {
    if (this.#stopped) return fail(this.#failureCode);
    if (this.#native) return this.#native;
    await verifyArtifacts(this.#options);
    if (this.#stopped) return fail(this.#failureCode);
    const environment = this.#options.environment ?? Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    // 微信沿用主进程明确选定的账号配置；DSH 的 HOME 仍保持隔离，不继承其余宿主环境。
    if (!this.#options.environment && process.env.NOTALONE_WECHAT_CONFIG !== undefined) {
      const configPath = process.env.NOTALONE_WECHAT_CONFIG;
      if (!path.isAbsolute(configPath) || configPath.length > 1024 || /[\0\r\n]/.test(configPath)) fail('history_account_unavailable');
      environment.WECHAT_CLI_CONFIG = configPath;
    }
    delete environment.NOTALONE_IMAGE_KEY_FD;
    if(this.#options.imageKeyChannel)environment.NOTALONE_IMAGE_KEY_FD='3';
    const stdio:StdioOptions=this.#options.imageKeyChannel?['pipe','pipe','pipe','pipe']:['pipe','pipe','pipe'];
    const child = spawn(this.#options.executable, ['notalone-history'], { stdio, env: environment, shell: false }) as ChildProcessWithoutNullStreams;
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
    const native: NativeProcess = { child, exited, output: Buffer.alloc(0), stderrBytes: 0 };
    this.#native = native;
    child.once('error', () => { void this.#stop('history_native_unavailable'); });
    child.once('close', () => { if (!this.#stopped) void this.#stop('history_native_unavailable'); });
    child.stdin.on('error', () => { void this.#stop('history_native_unavailable'); });
    child.stdout.on('error', () => { void this.#stop('history_native_unavailable'); });
    child.stderr.on('error', () => { void this.#stop('history_native_unavailable'); });
    if(this.#options.imageKeyChannel)(child.stdio[3] as Writable|undefined)?.on('error',()=>{void this.#stop('history_native_unavailable');});
    child.stdout.on('data', (chunk: Buffer) => this.#output(native, chunk));
    child.stdout.once('end', () => { if (!this.#stopped) void this.#stop('history_native_unavailable'); });
    child.stderr.on('data', (chunk: Buffer) => {
      native.stderrBytes += chunk.length;
      if (native.stderrBytes > stderrLimit) void this.#stop('history_stderr_limit');
    });
    return native;
  }
  async #request<T>(request: Record<string, string | number | boolean | HistoryTarget | readonly HistoryRecoveryPosition[]>, parse: (value: unknown) => T, limit = responseLimit, recoverableErrors?: ReadonlySet<string>): Promise<T> {
    let native: NativeProcess;
    try { native = await this.#start(); }
    catch (error) { const code = error instanceof StorageFailure ? error.code : 'history_native_unavailable'; await this.#stop(code); return fail(code); }
    if (this.#stopped) return fail(this.#failureCode);
    return new Promise<T>((resolve, reject) => {
      this.#pending = { operation:typeof request.op==='string'?request.op:'', limit, recoverableErrors, parse, resolve: value => resolve(value as T), reject };
      try { native.child.stdin.write(`${JSON.stringify(request)}\n`, error => { if (error) void this.#stop('history_native_unavailable'); }); }
      catch { void this.#stop('history_native_unavailable'); }
    });
  }
  #output(native: NativeProcess, chunk: Buffer): void {
    if (this.#stopped) return;
    const pending = this.#pending;
    if (!pending) { void this.#stop('history_protocol_invalid'); return; }
    if (native.output.length + chunk.length > pending.limit + 1) { void this.#stop('history_response_too_large'); return; }
    native.output = Buffer.concat([native.output, chunk]);
    const end = native.output.indexOf(10);
    if (end < 0) {
      if (native.output.length > pending.limit) void this.#stop('history_response_too_large');
      return;
    }
    if (end > pending.limit) { void this.#stop('history_response_too_large'); return; }
    if (end !== native.output.length - 1) { void this.#stop('history_protocol_invalid'); return; }
    try {
      const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(native.output.subarray(0, end))) as unknown;
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return fail();
      const success = (envelope as Record<string, unknown>).ok;
      if (success === false) {
        const row = object(envelope, ['ok', 'error']); const error = object(row.error, ['code']);
        const code = typeof error.code === 'string' && allowedErrors.has(error.code) ? error.code : 'history_protocol_invalid';
        if(code==='history_image_key_unavailable'&&this.#options.imageKeyChannel){
          native.output=Buffer.alloc(0);this.#pending=undefined;pending.reject(new StorageFailure(code));return;
        }
        // 单图隔离：只有当前明确登记的 image-open 收到合法回执才局部失败，进程、选择范围与其他守卫保持有效。
        if((pending.operation==='quote-read'||pending.operation==='image-open')&&pending.recoverableErrors?.has(code)){
          native.output=Buffer.alloc(0);this.#pending=undefined;pending.reject(new StorageFailure(code));return;
        }
        void this.#stop(code); return;
      }
      if (success !== true) return fail();
      const row = object(envelope, ['ok', 'data']); const value = pending.parse(row.data);
      native.output = Buffer.alloc(0); this.#pending = undefined; pending.resolve(value);
    } catch (error) { void this.#stop(error instanceof StorageFailure && allowedErrors.has(error.code) ? error.code : 'history_protocol_invalid'); }
  }
  async #stop(code: string): Promise<void> {
    if (this.#stopped) { await this.#stopping; return; }
    this.#stopped = true; this.#failureCode = allowedErrors.has(code) ? code : 'history_native_unavailable'; this.#selected = undefined; this.#account = undefined; this.#schema = undefined; this.#support = undefined; this.#target = undefined; this.#activeImage=undefined; this.#tailCursor = undefined; this.#lastTail = undefined;  this.#testMetadata = undefined; this.#receivedTestMetadata = undefined;
    this.#stoppedSignal.resolve();
    const listeners=[...this.#stopListeners];this.#stopListeners.clear();
    for(const listener of listeners)try{listener();}catch{/* 订阅者失败不得阻止进程排空。 */}
    const pending = this.#pending; this.#pending = undefined;
    this.#stopping = (async () => {
      const native = this.#native;
      if (native) { native.child.kill('SIGKILL'); await native.exited; native.output = Buffer.alloc(0); }
      this.#native = undefined;
    })();
    await this.#stopping;
    pending?.reject(new StorageFailure(this.#failureCode));
  }
  async close(): Promise<void> { await this.#stop('history_native_closed'); await this.#queue; }
}
