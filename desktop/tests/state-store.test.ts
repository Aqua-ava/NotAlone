import test from 'node:test';
import assert from 'node:assert/strict';
import { StateStore } from '../src/main/state-store.ts';

interface Sample { revision: number; phase: 'idle' | 'busy'; items: string[]; note?: string }

class Shallow extends StateStore<Sample> {
  constructor() { super({ revision: 0, phase: 'idle', items: [] }); }
  set(update: Partial<Sample>) { this.publish(update); }
  replaceAll(next: Omit<Sample, 'revision'>) { this.replaceState(next); }
  dispose() { this.clearListeners(); }
  peek() { return this.state; }
}
class Deep extends Shallow {
  override getState(): Sample { return structuredClone(this.state); }
}

test('publish 浅合并更新、revision 递增并向每个监听者各发一份快照', () => {
  const store = new Shallow();
  const first: Sample[] = [], second: Sample[] = [];
  store.onStateChanged((state) => first.push(state));
  store.onStateChanged((state) => second.push(state));
  store.set({ phase: 'busy' });
  store.set({ note: 'n' });
  assert.deepEqual(first.map((state) => state.revision), [1, 2]);
  assert.deepEqual(first[1], { revision: 2, phase: 'busy', items: [], note: 'n' });
  assert.notEqual(first[0], second[0]);
});

test('取消订阅后不再通知，clearListeners 一次清空全部监听者', () => {
  const store = new Shallow();
  let calls = 0;
  const off = store.onStateChanged(() => { calls += 1; });
  store.onStateChanged(() => { calls += 10; });
  store.set({ phase: 'busy' });
  off();
  store.set({ phase: 'idle' });
  assert.equal(calls, 21);
  store.dispose();
  store.set({ phase: 'busy' });
  assert.equal(calls, 21);
  assert.equal(store.getState().revision, 3);
});

test('默认快照为浅拷贝，覆盖 getState 后嵌套数据与内部状态隔离', () => {
  const shallow = new Shallow(), deep = new Deep();
  shallow.set({ items: ['a'] }); deep.set({ items: ['a'] });
  shallow.getState().items.push('leak'); deep.getState().items.push('leak');
  assert.deepEqual(shallow.peek().items, ['a', 'leak']);
  assert.deepEqual(deep.peek().items, ['a']);
  shallow.getState().phase = 'busy';
  assert.equal(shallow.peek().phase, 'idle');
});

test('replaceState 整体替换而非合并，仍递增 revision', () => {
  const store = new Shallow();
  store.set({ note: 'keep?', phase: 'busy' });
  const seen: Sample[] = [];
  store.onStateChanged((state) => seen.push(state));
  store.replaceAll({ phase: 'idle', items: ['x'] });
  assert.deepEqual(seen, [{ revision: 2, phase: 'idle', items: ['x'] }]);
});
