import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import type { MediaPreview, MessageMediaSelection } from '../../shared/media-bridge.ts';

type Scope = MessageMediaSelection & { generation: number };
type PreviewConnection = NonNullable<ReturnType<BackendHost['captureMediaPreviewConnection']>>;
type Preview = { sessionId: string; scope: Scope; connection: PreviewConnection; revoking: boolean; acknowledged?: boolean; releasing?: Promise<void>; timer?: NodeJS.Timeout };
type MediaBackend = Pick<BackendHost,'getConnectionGeneration'|'onStateChanged'|'captureMediaPreviewConnection'|'openMediaPreview'|'releaseUnhandedMediaPreviews'>;
// 只管理聊天图片的只读预览：联系人范围或连接变化时先通知页面撤下，页面确认后才释放后台持有的原文件。
export class MessageMediaController {
  private readonly previews = new Map<string, Preview>();
  private readonly previewListeners = new Set<(sessionId: string) => void>();
  private readonly openings = new Set<Promise<MediaPreview>>();
  private readonly drainedListeners = new Set<() => void>();
  private readonly subscriptions: (() => void)[];
  private closing = false;
  private draining: Promise<void> | undefined;
  private epoch = 0;
  private readonly backend: MediaBackend;
  private readonly contacts: Pick<ContactSession,'getState'|'onStateChanged'>;
  constructor(backend: MediaBackend, contacts: Pick<ContactSession,'getState'|'onStateChanged'>) {
    this.backend=backend;this.contacts=contacts;
    this.subscriptions=[contacts.onStateChanged(() => this.synchronize()),backend.onStateChanged(() => this.synchronize())];
  }
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
    return this.trackOpening(this.acquireHistoryImagePreview({...input,contactId:scope.contactId,messageId:scope.messageId},scope,this.epoch));
  }
  private trackOpening(opening:Promise<MediaPreview>):Promise<MediaPreview> {
    this.openings.add(opening);
    const settled=()=>{this.openings.delete(opening);this.notifyDrained();};void opening.then(settled,settled);return opening;
  }
  private async acquireHistoryImagePreview(input:MessageMediaSelection&{fileId:string;mimeType:string},scope:Scope,epoch:number):Promise<MediaPreview> {
    if (!this.valid(scope)) throw new Error('联系人范围已变化。');
    const response=await this.backend.openMediaPreview({contactId:scope.contactId,messageId:scope.messageId,fileId:input.fileId,connectionGeneration:scope.generation});
    const value=response.data as MediaPreview;
    const validValue=!!value&&typeof value.sessionId==='string'&&/^[a-f0-9-]{36}$/i.test(value.sessionId)
      &&value.mimeType===input.mimeType&&typeof value.dataBase64==='string'&&value.dataBase64.length<=44_739_244
      &&/^[A-Za-z0-9+/]*={0,2}$/.test(value.dataBase64);
    if(!validValue){await response.connection.release();throw new Error('聊天图片预览无效。');}
    if(!this.valid(scope) || this.epoch!==epoch) {
      await response.connection.release();throw new Error('聊天图片范围已变化。');
    }
    const preview:Preview={sessionId:value.sessionId,scope,connection:response.connection,revoking:false};
    this.previews.set(value.sessionId,preview);
    if(!this.valid(scope)||response.generation!==scope.generation){await this.releasePreview(value.sessionId);throw new Error('联系人范围已变化。');}
    this.schedulePreview(preview);return value;
  }
  async releasePreview(sessionId:string):Promise<void> {
    const preview=this.previews.get(sessionId);if(!preview)return;
    clearTimeout(preview.timer);preview.acknowledged=true;
    // 调用者的DOM撤下是释放确认；失败仍保存该确认，后续排空只重试释放原session。
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
  async dispose():Promise<void> {await this.prepareClosing();for(const unsubscribe of this.subscriptions)unsubscribe();this.previewListeners.clear();}
  /** 联系人资料被清空或替换时：让在途打开作废，并通知页面撤下所有预览。 */
  invalidate():void {this.epoch+=1;for(const preview of this.previews.values())this.revokePreview(preview);}
}
