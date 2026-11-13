"""DSH 发布版本的隔离 stdio 验证，共用 probe.py 的合成模型。"""
import argparse
import json
from pathlib import Path
import queue
import subprocess
import threading
import time

from probe import ModelServer, clean_env


class Runtime:
    def __init__(self, binary, root, endpoint):
        env = clean_env()
        env.update(DSH_HOME=str(root / 'home'), DEEPSEEK_API_KEY='synthetic-not-a-secret', DEEPSEEK_BASE_URL=endpoint)
        self.stderr = (root / 'stderr.log').open('a')
        self.process = subprocess.Popen([binary, '--profile', 'sdk-minimal', '--patch', str(root / 'probe.patch.yml')], cwd=root, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr, text=True)
        self.messages = queue.Queue()
        self.transcript = []
        self.counter = 0
        threading.Thread(target=self.read, daemon=True).start()
        try:
            self.call('initialize', {'cwd': str(root), 'provider': 'deepseek-official', 'model': 'deepseek-v4-flash', 'maxTokens': 128})
        except Exception:
            self.process.terminate()
            self.process.wait(timeout=5)
            self.stderr.close()
            raise

    def read(self):
        for line in self.process.stdout:
            try:
                data = json.loads(line)
            except ValueError:
                continue
            self.transcript.append(data)
            self.messages.put(data)

    def call(self, method, params):
        self.counter += 1
        self.process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': self.counter, 'method': method, 'params': params}) + '\n')
        self.process.stdin.flush()
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            data = self.messages.get(timeout=max(.1, deadline-time.monotonic()))
            if data.get('id') == self.counter:
                if 'error' in data:
                    raise RuntimeError(data['error'])
                return data.get('result')
        raise TimeoutError(method)

    def run(self, session, prompt):
        start = len(self.transcript)
        self.call('session/prompt', {'sessionId': session, 'contentBlocks': [{'type': 'text', 'text': prompt}]})
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            events = self.transcript[start:]
            if any(d.get('method') == 'session.status' and d['params'].get('sessionId') == session and d['params'].get('status') == 'idle' for d in events):
                completed = [d['params']['event'] for d in events if d.get('method') == 'session.event' and d['params'].get('sessionId') == session and d['params']['event']['type'] == 'assistant/message']
                if not completed:
                    raise AssertionError('会话空闲但没有模型回复')
                return events
            time.sleep(.02)
        raise TimeoutError('等待会话完成')

    def close(self):
        try:
            self.call('shutdown', {})
        finally:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
            self.stderr.close()


def main(args):
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=False)
    (root / 'probe.patch.yml').write_text(''.join('- id: ' + name + '\n  disabled: true\n' for name in ['persistent-bash', 'persistent-pwsh', 'session-log-deepseek', 'plugin-package-inventory-deepseek']))
    server = ModelServer()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    endpoint = f'http://127.0.0.1:{server.server_port}'
    report = {'version': '0.2.0-rc.2', 'stages': {}}
    runtime = None
    try:
        runtime = Runtime(args.binary, root, endpoint)
        for label, session, prompt in [('first', 'probe-contact-a-chat-1', 'MARK_A_ONLY 邀约'), ('continued', 'probe-contact-a-chat-1', '自然一点'), ('other', 'probe-contact-b-chat-1', 'MARK_B_ONLY 回复'), ('new', 'probe-contact-a-chat-2', '全新讨论')]:
            report['stages'][label] = runtime.run(session, prompt)
        runtime.close()
        runtime = None
        runtime = Runtime(args.binary, root, endpoint)
        report['stages']['restored'] = runtime.run('probe-contact-a-chat-1', '重启后继续')
    except Exception as error:
        report['error'] = repr(error)
    finally:
        if runtime:
            runtime.close()
        server.shutdown()
        server.server_close()
        report['model_requests'] = server.requests
        expected = [('first', ['MARK_A_ONLY'], 1), ('continued', ['MARK_A_ONLY'], 2), ('other', ['MARK_B_ONLY'], 1), ('new', [], 1), ('restored', ['MARK_A_ONLY'], 3)]
        report['checks'] = {}
        for label, markers, turns in expected:
            events = report['stages'].get(label, [])
            replies = [d['params']['event']['data']['message']['content'][0]['text'] for d in events if d.get('method') == 'session.event' and d['params']['event']['type'] == 'assistant/message']
            answer = json.loads(replies[-1]) if replies else {}
            report['checks'][label] = answer.get('seen') == markers and answer.get('turns') == turns
        (root / 'dsh-result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'error': report.get('error'), 'requests': len(server.requests), 'report': str(root / 'dsh-result.json')}, ensure_ascii=False))
    if report.get('error'):
        raise SystemExit(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    parser.add_argument('--root', type=Path, required=True)
    main(parser.parse_args())
