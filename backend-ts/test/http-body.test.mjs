import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {readHttpBody, HttpBodyError} from '../src/platform/http/body.ts';

// 合成请求流只替代 HTTP 传输，不改变正文读取的限额、截止时间或异常合同。
function request(headers = {'transfer-encoding': 'chunked'}) {
  return Object.assign(new PassThrough(), {headers, complete: false});
}

function released(req) {
  for (const event of ['data', 'end', 'aborted', 'error', 'close']) {
    assert.equal(req.listenerCount(event), 0, `${event} 监听器应在读取结算后释放`);
  }
}

test('HTTP 正文按字节合并多个块，成功后释放读取监听器', async () => {
  const req = request({'content-length': '6'});
  const result = readHttpBody(req, 6);
  req.write(Buffer.from('中'));
  req.write(Buffer.from('文'));
  req.complete = true;
  req.end();
  assert.equal((await result).toString('utf8'), '中文');
  released(req);
});

test('HTTP 无正文请求立即返回空缓冲区且不开始读取', async () => {
  for (const headers of [{}, {'content-length': '0'}]) {
    const req = request(headers);
    assert.equal((await readHttpBody(req)).length, 0);
    released(req);
  }
});

test('HTTP 非法长度和已知超限在读取前返回原协议错误', async () => {
  for (const [headers, status, code] of [
    [{'content-length': '-1'}, 400, 'request_length_invalid'],
    [{'content-length': ['1', '2']}, 400, 'request_length_invalid'],
    [{'content-length': '4'}, 413, 'request_body_too_large'],
  ]) {
    const req = request(headers);
    await assert.rejects(readHttpBody(req, 3), error => {
      assert.ok(error instanceof HttpBodyError);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      return true;
    });
    released(req);
  }
});

test('HTTP 分块传输按累计字节拒绝超限且保留响应套接字', async () => {
  const req = request();
  const result = readHttpBody(req, 3);
  req.write(Buffer.from('12'));
  req.write(Buffer.from('34'));
  await assert.rejects(result, {status: 413, code: 'request_body_too_large'});
  assert.equal(req.isPaused(), true);
  assert.equal(req.destroyed, false);
  released(req);
});

test('HTTP 未达到声明长度时不返回部分正文', async () => {
  const req = request({'content-length': '4'});
  const result = readHttpBody(req);
  req.complete = true;
  req.end(Buffer.from('12'));
  await assert.rejects(result, {status: 400, code: 'request_body_incomplete'});
  released(req);
});

test('HTTP 读取中断、流错误和提前关闭均拒绝部分正文', async () => {
  for (const event of ['aborted', 'error', 'close']) {
    const req = request();
    const result = readHttpBody(req);
    req.write(Buffer.from('partial'));
    req.emit(event, event === 'error' ? new Error('合成传输错误') : undefined);
    await assert.rejects(result, {status: 400, code: 'request_body_incomplete'});
    released(req);
  }
});

test('HTTP 已销毁请求立即拒绝读取且释放监听器', async () => {
  const req = request();
  req.destroy();
  await assert.rejects(readHttpBody(req), {status: 400, code: 'request_body_incomplete'});
  released(req);
});

test('HTTP 截止时间从读取开始计算，收到部分数据也不延长', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const req = request();
  const result = readHttpBody(req, 32, 100);
  t.mock.timers.tick(60);
  req.write(Buffer.from('partial'));
  t.mock.timers.tick(40);
  await assert.rejects(result, {status: 408, code: 'request_body_timeout'});
  assert.equal(req.destroyed, false);
  released(req);
});
