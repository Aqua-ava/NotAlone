import { ModelLedgerError, type ModelLedgerReceipt } from './model-ledger.ts';
import { createServer, type Socket } from 'node:net';
import { chmod, stat } from 'node:fs/promises';
import { openModelPermitJournal } from './model-permit-journal.ts';
import { captureProcessIdentity } from './process-identity.ts';
import { dirname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { ModelPermitArbiter, type ModelPermit } from './model-permits.ts';

/** 原任务领取凭证；类型不授予权限，宿主预约策略必须核对真实租约。 */
export interface ModelTaskClaim {
  task_id:string;step_id:string;step_name:string;worker_id:string;lease_generation:number;
}
export interface ModelPermitAccounting {
  /** 宿主从稳定request策略取得额度，不能信任客户端指定上限。 */
  reserve(receipt:ModelLedgerReceipt,claim?:ModelTaskClaim):Promise<void>;
  /** 必须验证已存在的同attempt预约，不允许仅凭完成消息创建授权。 */
  recordReserved(receipt:ModelLedgerReceipt):Promise<void>;
  unconfirmedRequests?(scope:{owner_id:string;contact_id:string|null}):Promise<string[]>;
}

/** 私有本机 socket 仅传许可元数据，不传模型输入、凭据或联系人资料。 */
export async function startModelPermitServer(options: {
  path: string; token: string; arbiter: ModelPermitArbiter; statePath?: string; accounting?: ModelPermitAccounting;
}) {
  if (Buffer.byteLength(options.token) < 32) throw new Error('model_permit_token_invalid');
  const directory = await stat(dirname(options.path));
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) throw new Error('model_permit_directory_not_private');
  if (options.statePath) {
    const stateDirectory = await stat(dirname(options.statePath));
    if (!stateDirectory.isDirectory() || (stateDirectory.mode & 0o077) !== 0) throw new Error('model_permit_directory_not_private');
  }
  const journal = await openModelPermitJournal(options.path, options.statePath);
  try { options.arbiter.attachJournal(journal); } catch (error) { await journal.release(); throw error; }
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    const controller = new AbortController();
    let buffer = '';
    let requested = false;
    let permit: ModelPermit | undefined;
    let closed = false;
    let busy = false;
    let attemptId: string | undefined;
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      closed = true;
      controller.abort();
      permit?.orphan();
      sockets.delete(socket);
    });
    socket.on('data', data => {
      buffer += data.toString('utf8');
      if (Buffer.byteLength(buffer) > 4096) { socket.destroy(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (busy) throw new Error('model_permit_protocol_busy');
          if (requested && permit && message.op === 'reserve') {
            if (!options.accounting || !attemptId || message.receipt?.permit_id !== permit.id) throw new Error('model_permit_accounting_invalid');
            busy = true;
            void options.accounting.reserve(message.receipt,message.claim).then(
              () => { busy = false; if (!closed) socket.write('{"state":"reserved"}\n'); },
              () => { busy = false; if (!closed) socket.write('{"state":"accounting_rejected"}\n'); });
            continue;
          }
          if (requested) {
            if (!permit || message.op !== 'settled') throw new Error('model_permit_protocol_invalid');
            permit.settle();
            permit = undefined;
            socket.end('{"state":"settled"}\n');
            return;
          }
          const token = Buffer.from(typeof message.token === 'string' ? message.token : '');
          const expected = Buffer.from(options.token);
          if (token.length !== expected.length || !timingSafeEqual(token, expected)) throw new Error('model_permit_auth_invalid');
          if (message.op === 'unconfirmed_requests') {
            if (!options.accounting?.unconfirmedRequests) throw new Error('model_permit_accounting_unavailable');
            if(message.after!==undefined&&(typeof message.after!=='string'||!/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(message.after)))throw new Error('model_permit_cursor_invalid');
            requested = true; busy = true;
            void options.accounting.unconfirmedRequests({owner_id:message.owner_id,contact_id:message.contact_id}).then(
              ids=>{const ordered=ids.sort().filter(id=>message.after===undefined||id>message.after),page=ordered.slice(0,64);if(!closed)socket.end(JSON.stringify({state:'unconfirmed_requests',request_ids:page,next_cursor:ordered.length>64?page[page.length-1]:null})+'\n');},
              ()=>{if(!closed)socket.end('{"state":"accounting_rejected"}\n');});
            continue;
          }
          if (message.op === 'record') {
            if (!options.accounting) throw new Error('model_permit_accounting_unavailable');
            requested = true; busy = true;
            void options.accounting.recordReserved(message.receipt).then(
              () => { if (!closed) socket.end('{"state":"recorded"}\n'); },
              error => { if (!closed) socket.end(JSON.stringify({state:'accounting_rejected',
                ...(error instanceof ModelLedgerError && error.code === 'model_ledger_scope_deleted' ? {reason:'scope_deleted'} : {})})+'\n'); });
            continue;
          }
          if (message.op !== 'acquire' || !['foreground', 'background'].includes(message.kind)) throw new Error('model_permit_protocol_invalid');
          requested = true;
          attemptId = message.attempt_id;
          const acquire = async () => {
            const worker = message.worker;
            if (!worker || !Number.isSafeInteger(worker.pid) || !Number.isSafeInteger(worker.parentPid) || typeof worker.executable !== 'string') throw new Error('model_permit_worker_invalid');
            const identity = await captureProcessIdentity(worker.pid, worker.parentPid, worker.executable);
            if (message.attempt_id !== undefined && (typeof message.attempt_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(message.attempt_id))) throw new Error('model_permit_attempt_invalid');
            return options.arbiter.acquire(message.kind, controller.signal, identity, message.attempt_id);
          };
          void acquire().then(value => {
            permit = value;
            if (closed) { permit.orphan(); return; }
            socket.write(JSON.stringify({state:'granted',permit_id:permit.id})+'\n');
          }, () => { if (!closed) socket.end('{"state":"stopped"}\n'); });
        } catch { socket.destroy(); return; }
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.path, () => { server.off('error', reject); resolve(); });
    });
    await chmod(options.path, 0o600);
  } catch (error) {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await journal.release();
    throw error;
  }
  let shutdownPromise: Promise<void> | undefined;
  function shutdown() {
    return shutdownPromise ??= (async () => {
      options.arbiter.stop();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await journal.release();
    })();
  }
  return {
    shutdown,
    unknownSettlements: journal.unknown,
    unconfirmedPermitIds: () => [...new Set([...journal.unknown().map(item=>item.id),...options.arbiter.orphanedPermitIds()])],
    /** 必须先停收并等待所有执行者结算；活跃/孤儿许可不能通过关闭服务抹除。 */
    async close() {
      const state = options.arbiter.snapshot();
      if (state.foregroundActive || state.backgroundActive) throw new Error('model_permits_not_drained');
      await shutdown();
    },
  };
}
