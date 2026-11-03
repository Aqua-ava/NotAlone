import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connect} from 'node:net';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {ModelPermitArbiter} from '../src/platform/models/model-permits.ts';
import {startModelPermitServer} from '../src/platform/models/model-permit-server.ts';

async function waitFor(predicate) {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, '本机socket状态应在2秒内更新');
    await delay(10);
  }
}

for (const kind of ['foreground', 'background']) test(`真实Unix断线的${kind}许可只冻结自身通道`, {timeout: 10000}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'na-permit-lanes-'));
  const path = join(directory, 'p.sock'), token = 'synthetic-lanes-token-'.repeat(3), arbiter = new ModelPermitArbiter(3);
  const server = await startModelPermitServer({path, token, arbiter}), sockets = [];
  t.after(async () => { for (const socket of sockets) socket.destroy(); await server.shutdown(); await rm(directory, {recursive: true, force: true}); });
  async function channel(workKind) {
    const socket = connect(path); sockets.push(socket);
    const lines = createInterface({input: socket})[Symbol.asyncIterator]();
    await once(socket, 'connect');
    socket.write(JSON.stringify({op: 'acquire', token, kind: workKind,
      worker: {pid: process.pid, parentPid: process.ppid, executable: process.execPath}}) + '\n');
    return {socket, read: async () => JSON.parse((await lines.next()).value)};
  }
  const lost = await channel(kind), lostGrant = await lost.read(); assert.equal(lostGrant.state, 'granted');
  lost.socket.destroy();
  await waitFor(() => arbiter.snapshot().orphaned === 1);
  const same = await channel(kind), otherKind = kind === 'foreground' ? 'background' : 'foreground';
  const other = await channel(otherKind); assert.equal((await other.read()).state, 'granted');
  await waitFor(() => arbiter.snapshot()[`${kind}Waiting`] === 1);
  assert.deepEqual(server.unconfirmedPermitIds(), [lostGrant.permit_id]);
  other.socket.write('{"op":"settled"}\n'); assert.equal((await other.read()).state, 'settled');
  assert.deepEqual(server.unconfirmedPermitIds(), [lostGrant.permit_id]);
  assert.equal(arbiter.snapshot()[`${kind}Waiting`], 1);
  same.socket.destroy(); await waitFor(() => arbiter.snapshot()[`${kind}Waiting`] === 0);
  assert.equal(arbiter.snapshot().orphaned, 1, '取消等待不能回收已断线调用');
});
