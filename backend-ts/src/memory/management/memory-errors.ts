/** 管理入口错误只携带稳定错误码，不暴露正文或数据库细节。 */
import { HostStorageError } from '../../platform/database/host-storage.ts';
export class MemoryError extends HostStorageError {
  readonly status: number;
  constructor(code = 'memory_request_invalid', status = 400) { super(code); this.status=status; }
}
