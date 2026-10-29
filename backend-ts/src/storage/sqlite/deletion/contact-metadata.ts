import { randomUUID } from 'node:crypto';
import { SqliteContactService } from '../../../contacts/sqlite/service.ts';
import { SqliteContactHttp } from '../../../contacts/sqlite/http.ts';
import type { ContactMetadataPort } from '../../../contacts/sqlite/contracts.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqliteStorage } from '../client.ts';
import type { ActiveHolders } from './holders.ts';

/** 名单包含多位联系人；删除先关闭整个旧预览，再按持久资格重新创建空服务。 */
export class ContactMetadataLifetime {
  private readonly storage: SqliteStorage;
  private readonly ownerId: string;
  private readonly holders: ActiveHolders;
  private readonly createMetadata: () => ContactMetadataPort;
  private service?: SqliteContactService;
  private http?: SqliteContactHttp;
  private released = true;
  private stopping = false;
  private reopening?: Promise<void>;
  constructor(storage: SqliteStorage, ownerId: string, holders: ActiveHolders, createMetadata: () => ContactMetadataPort) {
    this.storage = storage; this.ownerId = ownerId; this.holders = holders; this.createMetadata = createMetadata;
  }
  async initialize(): Promise<void> {
    const service = this.create();
    await service.initialize();
    this.service = service; this.http = new SqliteContactHttp(service);
    if (await this.available()) this.bind(service); else await service.close();
  }
  private create(): SqliteContactService { return new SqliteContactService(this.storage, this.ownerId, this.createMetadata()); }
  private available(): Promise<boolean> { return this.storage.execute('deletion.metadataAvailable', {ownerId: this.ownerId}); }
  private bind(service: SqliteContactService): void {
    this.holders.register({key: `identity:metadata_${randomUUID()}`, ownerId: this.ownerId, generation: 0n, coversAllContacts: true,
      close: async () => { if (this.service === service) this.released = true; await service.close(); }});
    this.service = service; this.http = new SqliteContactHttp(service); this.released = false;
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (this.released && !this.stopping) {
      this.reopening ??= (async () => {
        if (await this.available() && !this.stopping) this.bind(this.create());
      })().finally(() => { this.reopening = undefined; });
      await this.reopening;
    }
    return this.http!.handle(req, res);
  }
  async close(): Promise<void> {
    this.stopping = true;
    await this.reopening;
    await this.service?.close();
  }
}
