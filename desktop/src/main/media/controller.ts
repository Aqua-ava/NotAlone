import { randomUUID } from 'node:crypto';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import type { MediaGoal, MediaPreview, MessageMediaSelection, MessageMediaState } from '../../shared/media-bridge.ts';
import { readMediaSnapshot } from './read.ts';

type Scope = MessageMediaSelection & { generation: number };
type PreviewConnection = NonNullable<ReturnType<BackendHost['captureMediaPreviewConnection']>>;
type Preview = { sessionId: string; scope: Scope; connection: PreviewConnection; kind: 'details' | 'history-image'; revoking: boolean; acknowledged?: boolean; releasing?: Promise<void>; timer?: NodeJS.Timeout };
type MediaBackend = Pick<BackendHost,'getConnectionGeneration'|'requestJson'|'onStateChanged'|'captureMediaPreviewConnection'|'openMediaPreview'|'releaseUnhandedMediaPreviews'>;
// 只跟踪用户明确打开的一条消息；刷新和重连不会执行提取或转换。
export class MessageMediaController {
  private state: MessageMediaState = {revision:0,contactId:null,scopeRevision:0,messageId:null,phase:'idle',snapshot:null,busy:null,retryGoal:null,error:null};
  private scope: Scope | undefined;
  private pending: AbortController | undefined;
  private revision = 0;
  private request: { scope: Scope; goal: MediaGoal; key: string } | undefined;
  private clearRequest: { scope: Scope; key: string } | undefined;
  private readonly previews = new Map<string, Preview>();
  private readonly historyPreviewRevisions = new Map<string, number>();
  private readonly historyPreviewOpenings = new Map<string, number>();
  private readonly clearingHistoryImages = new Set<string>();
  private readonly listeners = new Set<(state: MessageMediaState) => void>();
  private readonly previewListeners = new Set<(sessionId: string) => void>();
  private readonly openings = new Set<Promise<MediaPreview>>();
  private readonly drainedListeners = new Set<() => void>();
  private readonly subscriptions: (() => void)[];
  private closing = false;
  private draining: Promise<void> | undefined;
  private historyPreviewEpoch = 0;
  private readonly backend: MediaBackend;
  private readonly contacts: Pick<ContactSession,'getState'|'onStateChanged'>;
  constructor(backend: MediaBackend,
    contacts: Pick<ContactSession,'getState'|'onStateChanged'>) {
    this.backend=backend;this.contacts=contacts;
    this.subscriptions=[contacts.onStateChanged(() => this.synchronize()),backend.onStateChanged(() => this.synchronize())];
  }
  getState(): MessageMediaState { return structuredClone(this.state); }
  onStateChanged(listener: (state: MessageMediaState) => void) { this.listeners.add(listener);return () => {this.listeners.delete(listener);}; }
  onPreviewRevoking(listener: (sessionId: string) => void) { this.previewListeners.add(listener);return () => {this.previewListeners.delete(listener);}; }
  private valid(scope: Scope): boolean {
    const c = this.contacts.getState();
    return !this.closing && scope.generation === this.backend.getConnectionGeneration() && c.selectedContactId === scope.contactId && c.scopeRevision === scope.scopeRevision
      && ['ready','loading'].includes(c.directoryPhase) && c.contacts.some(c => c.contactId === scope.contactId);
  }
  private synchronize(): void {
    for (const preview of this.previews.values()) {
      if (!this.valid(preview.scope)) this.revokePreview(preview);
    }
    if (!this.scope || this.valid(this.scope)) return;
    this.cancel();this.scope=undefined;this.request=undefined;this.clearRequest=undefined;
    this.revokePreviews();this.publish({contactId:null,scopeRevision:this.contacts.getState().scopeRevision,messageId:null,phase:'idle',snapshot:null,busy:null,retryGoal:null,error:null});
  }
  private select(selection: MessageMediaSelection): Scope {
    this.synchronize();const generation=this.backend.getConnectionGeneration();
    const candidate={...selection,generation:generation ?? -1};
    if (generation === undefined || !this.valid(candidate)) throw new Error('媒体范围已变化，请重新确认联系人。');
    if (!this.scope || this.scope.contactId !== candidate.contactId || this.scope.messageId !== candidate.messageId || this.scope.scopeRevision !== candidate.scopeRevision) {
      this.cancel();this.revokePreviews(preview=>preview.kind==='details');this.request=undefined;this.clearRequest=undefined;this.scope=candidate;
      this.publish({contactId:selection.contactId,scopeRevision:selection.scopeRevision,messageId:selection.messageId,phase:'idle',snapshot:null,busy:null,retryGoal:null,error:null});
    }
    return this.scope;
  }
  private current(scope: Scope, revision: number): boolean { this.synchronize();return this.scope === scope && revision === this.revision && this.valid(scope); }
  private path(scope: Scope): string { return `/api/contacts/${scope.contactId}/messages/${scope.messageId}/media`; }
  async inspect(selection: MessageMediaSelection): Promise<void> {
    const scope=this.select(selection);this.cancel();const revision=this.revision, pending=new AbortController();this.pending=pending;
    this.publish({phase:'loading',snapshot:null,error:null,busy:null});
    try {
      await this.retryAcknowledgedPreviews();
      if(!this.current(scope,revision))return;
      const response=await this.backend.requestJson({method:'GET',path:this.path(scope),signal:pending.signal});
      if (!this.current(scope,revision) || response.generation !== scope.generation) return;
      const snapshot=readMediaSnapshot(response.data,scope.contactId,scope.messageId);
      if (snapshot.state === 'invalidated' || snapshot.state === 'deleting' || snapshot.state === 'cleared') this.revokePreviews();
      this.publish({phase:'ready',snapshot,error:null});
    } catch { if(this.current(scope,revision)){this.revokePreviews();this.publish({phase:'failed',snapshot:null,error:'媒体资料暂不可用，请重新读取。'});} }
    finally {if(this.pending === pending)this.pending=undefined;}
  }
  async extract(input: MessageMediaSelection & { goal: MediaGoal }): Promise<void> {
    const scope=this.select(input),snapshot=this.state.snapshot;
    const capability={extract:'extract',audio_conversion:'audioConversion'} as const;
    if (this.state.busy || !snapshot || !snapshot.capabilities[capability[input.goal]]) throw new Error('当前媒体操作不可用，请读取状态后重试。');
    this.request={scope,goal:input.goal,key:randomUUID()};await this.submit(scope);
  }
  async retry(selection: MessageMediaSelection): Promise<void> {
    const scope=this.select(selection);
    if (!this.request || this.request.scope !== scope || this.state.busy) throw new Error('没有可重查的媒体操作。');
    await this.submit(scope);
  }
  private async submit(scope: Scope): Promise<void> {
    const request=this.request!;this.cancel();const revision=this.revision,pending=new AbortController();this.pending=pending;
    this.publish({busy:request.goal,error:null,retryGoal:null});
    try {
      const response=await this.backend.requestJson({method:'POST',path:this.path(scope),body:{request_key:request.key,goal:request.goal},signal:pending.signal,timeoutMs:60_000});
      if(!this.current(scope,revision) || response.generation !== scope.generation)return;
      this.publish({phase:'ready',snapshot:readMediaSnapshot(response.data,scope.contactId,scope.messageId),retryGoal:null});this.request=undefined;
    } catch {if(this.current(scope,revision)){this.revokePreviews();this.publish({phase:'failed',snapshot:null,retryGoal:request.goal,error:'媒体操作结果尚未确认。可重查同次操作，或刷新状态；刷新不会重新执行。'});}}
    finally {if(this.current(scope,revision))this.publish({busy:null});if(this.pending===pending)this.pending=undefined;}
  }
  async clear(selection: MessageMediaSelection): Promise<void> {
    const scope=this.select(selection);if(this.state.busy==='clear' || this.state.busy==='preview')throw new Error('媒体操作尚在进行中。');
    const previewKey=this.historyPreviewKey(scope);
    this.clearingHistoryImages.add(previewKey);
    if ((this.historyPreviewOpenings.get(previewKey) ?? 0) > 0) {
      this.historyPreviewRevisions.set(previewKey,(this.historyPreviewRevisions.get(previewKey) ?? 0)+1);
    }
    if(this.clearRequest?.scope !== scope)this.clearRequest={scope,key:randomUUID()};
    this.cancel();const revision=this.revision;
    this.revokePreviews(preview=>preview.scope.contactId===scope.contactId&&preview.scope.messageId===scope.messageId);
    this.publish({snapshot:null,busy:'clear',retryGoal:null,error:null});
    try {
      await this.retryAcknowledgedPreviews();
      if(!this.current(scope,revision))return;
      const input={method:'DELETE' as const,path:this.path(scope),idempotencyKey:this.clearRequest.key,timeoutMs:15_000};
      const response=await this.backend.requestJson(input);
      if(!this.current(scope,revision) || response.generation !== scope.generation)return;
      const snapshot=readMediaSnapshot(response.data,scope.contactId,scope.messageId);
      this.publish({phase:'ready',snapshot});if(snapshot.cleanup?.state === 'completed' || snapshot.state==='cleared'&&snapshot.cleanup===null)this.clearRequest=undefined;
    } catch {if(this.current(scope,revision))this.publish({phase:'failed',snapshot:null,error:'清除尚未确认完成，请刷新或继续清理原操作。'});}
    finally {
      this.clearingHistoryImages.delete(previewKey);
      if (!this.historyPreviewOpenings.has(previewKey)) this.historyPreviewRevisions.delete(previewKey);
      if(this.current(scope,revision))this.publish({busy:null});
    }
  }
  openPreview(input: MessageMediaSelection & { fileId: string }): Promise<MediaPreview> {
    return this.trackOpening(this.acquirePreview(input));
  }
  openHistoryImagePreview(input: MessageMediaSelection & { fileId: string; mimeType: string }): Promise<MediaPreview> {
    if (!/^[a-f0-9-]{36}$/i.test(input.contactId) || !/^[a-f0-9-]{36}$/i.test(input.messageId)
      || !/^[a-f0-9-]{36}$/i.test(input.fileId) || !['image/png','image/jpeg','image/gif','image/bmp'].includes(input.mimeType)) {
      return Promise.reject(new Error('聊天图片暂不可用。'));
    }
    const generation=this.backend.getConnectionGeneration();
    const scope:Scope={contactId:input.contactId.toLowerCase(),messageId:input.messageId.toLowerCase(),scopeRevision:input.scopeRevision,generation:generation??-1};
    if (generation===undefined || !Number.isSafeInteger(scope.scopeRevision) || scope.scopeRevision<0 || !this.valid(scope)) {
      return Promise.reject(new Error('联系人范围已变化。'));
    }
    const previewKey=this.historyPreviewKey(scope);
    if (this.clearingHistoryImages.has(previewKey)) return Promise.reject(new Error('图片正在清除。'));
    if (!this.historyPreviewRevisions.has(previewKey)) this.historyPreviewRevisions.set(previewKey,0);
    const revision=this.historyPreviewRevisions.get(previewKey) ?? 0, epoch=this.historyPreviewEpoch;
    this.historyPreviewOpenings.set(previewKey,(this.historyPreviewOpenings.get(previewKey) ?? 0)+1);
    const opening=this.acquireHistoryImagePreview({...input,contactId:scope.contactId,messageId:scope.messageId},scope,previewKey,revision,epoch)
      .finally(()=>this.finishHistoryImageOpening(previewKey));
    return this.trackOpening(opening);
  }
  private historyPreviewKey(scope:Scope):string { return `${scope.contactId}:${scope.messageId}`; }
  private finishHistoryImageOpening(key:string):void {
    const remaining=(this.historyPreviewOpenings.get(key) ?? 1)-1;
    if (remaining>0) this.historyPreviewOpenings.set(key,remaining);
    else {this.historyPreviewOpenings.delete(key);this.historyPreviewRevisions.delete(key);}
  }
  private trackOpening(opening:Promise<MediaPreview>):Promise<MediaPreview> {
    this.openings.add(opening);
    const settled=()=>{this.openings.delete(opening);this.notifyDrained();};void opening.then(settled,settled);return opening;
  }
  private async acquirePreview(input: MessageMediaSelection & { fileId: string }): Promise<MediaPreview> {
    const scope=this.select(input),file=this.state.snapshot?.files.find(f=>f.fileId===input.fileId);
    if(this.state.busy || !file || !file.viewable && !file.playable)throw new Error('该文件暂不可查看或播放。');
    const revision=this.revision;this.publish({busy:'preview',error:null});
    try {
      const response=await this.backend.openMediaPreview({contactId:scope.contactId,messageId:scope.messageId,fileId:input.fileId,connectionGeneration:scope.generation});
      const value=response.data as MediaPreview;
      if(!value || typeof value.sessionId!=='string' || !/^[a-f0-9-]{36}$/i.test(value.sessionId) || value.mimeType!==file.mimeType
        || typeof value.dataBase64!=='string' || value.dataBase64.length>44_739_244 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.dataBase64)){await response.connection.release();throw new Error('预览资料格式无效。');}
      const connection=response.connection;
      if(!connection)throw new Error('媒体连接已变化。');
      const preview:Preview={sessionId:value.sessionId,scope,connection,kind:'details',revoking:false};this.previews.set(value.sessionId,preview);
      if(!this.current(scope,revision) || response.generation!==scope.generation){await this.releasePreview(value.sessionId);throw new Error('媒体范围已变化。');}
      this.schedulePreview(preview);return value;
    } finally {if(this.current(scope,revision))this.publish({busy:null});}
  }
  private async acquireHistoryImagePreview(input:MessageMediaSelection&{fileId:string;mimeType:string},scope:Scope,
    previewKey:string,revision:number,epoch:number):Promise<MediaPreview> {
    if (!this.valid(scope)) throw new Error('联系人范围已变化。');
    const response=await this.backend.openMediaPreview({contactId:scope.contactId,messageId:scope.messageId,fileId:input.fileId,connectionGeneration:scope.generation});
    const value=response.data as MediaPreview;
    const validValue=!!value&&typeof value.sessionId==='string'&&/^[a-f0-9-]{36}$/i.test(value.sessionId)
      &&value.mimeType===input.mimeType&&typeof value.dataBase64==='string'&&value.dataBase64.length<=44_739_244
      &&/^[A-Za-z0-9+/]*={0,2}$/.test(value.dataBase64);
    if(!validValue){await response.connection.release();throw new Error('聊天图片预览无效。');}
    if(!this.valid(scope) || this.historyPreviewEpoch!==epoch || this.historyPreviewRevisions.get(previewKey)!==revision
      || this.clearingHistoryImages.has(previewKey)) {
      await response.connection.release();throw new Error('聊天图片范围已变化。');
    }
    const preview:Preview={sessionId:value.sessionId,scope,connection:response.connection,kind:'history-image',revoking:false};
    this.previews.set(value.sessionId,preview);
    if(!this.valid(scope)||response.generation!==scope.generation){await this.releasePreview(value.sessionId);throw new Error('联系人范围已变化。');}
    this.schedulePreview(preview);return value;
  }
  async releasePreview(sessionId:string):Promise<void> {
    const preview=this.previews.get(sessionId);if(!preview)return;
    clearTimeout(preview.timer);preview.acknowledged=true;
    // 调用者的DOM撤下是释放确认；失败仍保存该确认，刷新只重试释放原session。
    preview.releasing??=preview.connection.release().then(()=>{this.previews.delete(sessionId);this.notifyDrained();}).finally(()=>{preview.releasing=undefined;});
    await preview.releasing;
  }
  private async retryAcknowledgedPreviews():Promise<void> {
    await this.backend.releaseUnhandedMediaPreviews();
    for(const preview of this.previews.values())if(preview.acknowledged)await this.releasePreview(preview.sessionId);
  }
  private schedulePreview(preview:Preview):void {
    if(preview.revoking)return;
    preview.timer=setTimeout(()=>void this.checkPreview(preview),500);preview.timer.unref?.();
  }
  private async checkPreview(preview:Preview):Promise<void> {
    if(!this.previews.has(preview.sessionId) || preview.revoking)return;
    try {
      const state=await preview.connection.status();
      if(state !== 'active')this.invalidate();else this.schedulePreview(preview);
    } catch {this.revokePreview(preview);}
  }
  private revokePreview(preview:Preview):void {if(preview.revoking)return;preview.revoking=true;clearTimeout(preview.timer);for(const listener of this.previewListeners)listener(preview.sessionId);}
  private revokePreviews(filter:(preview:Preview)=>boolean=()=>true):void {for(const preview of this.previews.values())if(filter(preview))this.revokePreview(preview);}
  private notifyDrained():void {if(!this.previews.size&&!this.openings.size)for(const listener of this.drainedListeners)listener();}
  invalidateAndDrain(timeoutMs=5_000):Promise<void> {
    this.invalidate();
    return this.draining??=this.drain(timeoutMs).finally(()=>{this.draining=undefined;});
  }
  private async drain(timeoutMs:number):Promise<void> {
    let timer:NodeJS.Timeout|undefined,finish:(()=>void)|undefined,active=true;
    try {
      await Promise.race([(async()=>{
        await this.retryAcknowledgedPreviews();await Promise.allSettled([...this.openings]);if(!active)return;await this.retryAcknowledgedPreviews();
        if(!active||!this.previews.size)return;
        await new Promise<void>(resolve=>{finish=resolve;this.drainedListeners.add(resolve);this.notifyDrained();});
      })(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('播放引用尚未确认释放。')),timeoutMs);})]);
    } finally {active=false;clearTimeout(timer);if(finish)this.drainedListeners.delete(finish);}
  }
  prepareClosing():Promise<void> {this.closing=true;return this.invalidateAndDrain();}
  async dispose():Promise<void> {await this.prepareClosing();for(const unsubscribe of this.subscriptions)unsubscribe();this.listeners.clear();this.previewListeners.clear();}
  invalidate():void {this.historyPreviewEpoch+=1;this.cancel();this.revokePreviews();this.publish({snapshot:null,phase:'idle',busy:null,error:null,retryGoal:null});}
  private cancel():void {++this.revision;this.pending?.abort();this.pending=undefined;}
  private publish(update:Partial<MessageMediaState>):void {this.state={...this.state,...update,revision:this.state.revision+1};for(const listener of this.listeners)listener(this.getState());}
}
