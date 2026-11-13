"""一次性运行时实验：只使用合成标记和本机模拟模型，不接入产品。"""

from __future__ import annotations

import argparse
import asyncio
import importlib.metadata
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class ModelServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), ModelHandler)
        self.requests = []
        self.slow_started = threading.Event()
        self.release_slow = threading.Event()


class ModelHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        messages = body.get("messages", [])
        humans = [str(m.get("content", "")) for m in messages if m["role"] == "user"]
        record = {
            "path": self.path,
            "humans": humans,
            "tools": [t.get("function", {}).get("name") for t in body.get("tools", [])],
            "extra_keys": sorted(set(body) - {"messages", "model", "stream", "stream_options", "max_tokens", "temperature", "max_completion_tokens"}),
        }
        self.server.requests.append(record)
        if record["tools"]:
            self.send_error(400, "实验禁止暴露工具")
            return
        markers = sorted(set(re.findall(r"MARK_[A-Z_]+", " ".join(humans))))
        slow = "WAIT_FOR_CANCEL" in humans[-1]
        if slow:
            self.server.slow_started.set()
            self.server.release_slow.wait(15)
        answer = json.dumps({"seen": markers, "turns": len(humans), "reply": "OLD_RESULT" if slow else "CURRENT_RESULT"})
        completion = {"id": "synthetic-only", "object": "chat.completion", "created": 1, "model": body["model"], "choices": [{"index": 0, "message": {"role": "assistant", "content": answer}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30}}
        try:
            if self.path.endswith('/messages'):
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                events = [
                    ('message_start', {'type': 'message_start', 'message': {'id': 'synthetic', 'type': 'message', 'role': 'assistant', 'model': body['model'], 'content': [], 'stop_reason': None, 'usage': {'input_tokens': 20, 'output_tokens': 0}}}),
                    ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}}),
                    ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': answer}}),
                    ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
                    ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 10}}),
                    ('message_stop', {'type': 'message_stop'}),
                ]
                for event, payload in events:
                    self.wfile.write(('event: ' + event + '\ndata: ' + json.dumps(payload) + '\n\n').encode())
                    self.wfile.flush()
                return
            if body.get("stream"):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for delta, finish in [({"role": "assistant", "content": answer}, None), ({}, "stop")]:
                    chunk = {"id": "synthetic-only", "object": "chat.completion.chunk", "created": 1, "model": body["model"], "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                    self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                    self.wfile.flush()
                self.wfile.write(b"data: [DONE]\n\n")
            else:
                payload = json.dumps(completion).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass


def clean_env():
    """子进程只继承运行必需路径，不继承业务凭据和 tracing 配置。"""
    result = {k: os.environ[k] for k in ("PATH", "HOME", "TMPDIR", "PYTHONPATH") if k in os.environ}
    result.update(NOTALONE_DISABLE_DOTENV="1", LANGSMITH_TRACING="false", NO_PROXY="127.0.0.1,localhost")
    return result


async def langchain_worker(args):
    from langchain.agents import create_agent
    from langchain_openai import ChatOpenAI
    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

    async with AsyncSqliteSaver.from_conn_string(str(args.root / "PROTOTYPE-checkpoints.sqlite")) as saver:
        graph = create_agent(
            ChatOpenAI(model="synthetic-model", api_key="synthetic-not-a-secret", base_url=args.endpoint, max_retries=0, timeout=20),
            tools=[], checkpointer=saver,
        )

        async def run(session, prompt):
            state = await graph.ainvoke({"messages": [{"role": "user", "content": prompt}]}, {"configurable": {"thread_id": session}})
            return json.loads(state["messages"][-1].content)

        outcomes = {}
        if args.stage == "initial":
            outcomes["first"] = await run("owner-A/contact-A/chat-1", "MARK_A_ONLY 帮我写邀约")
            outcomes["continued"] = await run("owner-A/contact-A/chat-1", "第二条自然一点")
            outcomes["other_contact"] = await run("owner-A/contact-B/chat-1", "MARK_B_ONLY 帮我回复")
            outcomes["new_chat"] = await run("owner-A/contact-A/chat-2", "全新讨论")
        else:
            outcomes["restored"] = await run("owner-A/contact-A/chat-1", "重启后继续")
            old = asyncio.create_task(run("owner-A/contact-A/chat-1", "WAIT_FOR_CANCEL"))
            # 等待模拟服务确认旧请求进入，避免用固定 sleep 猜测执行顺序。
            import httpx
            async with httpx.AsyncClient() as client:
                for _ in range(200):
                    status = await client.get(args.endpoint.replace("/v1", "/slow-status"))
                    if status.json()["started"]:
                        break
                    await asyncio.sleep(0.025)
                else:
                    raise AssertionError("旧请求未到达模拟模型")
                outcomes["parallel_other_contact"] = await asyncio.wait_for(run("owner-A/contact-B/chat-1", "切换联系人继续"), 5)
                old.cancel()
                try:
                    await old
                except asyncio.CancelledError:
                    outcomes["cancelled"] = True
                outcomes["replacement"] = await run("owner-A/contact-A/chat-1", "MARK_REPLACEMENT 改成喝咖啡")
                await client.get(args.endpoint.replace("/v1", "/release-slow"))
            snapshot = await graph.aget_state({"configurable": {"thread_id": "owner-A/contact-A/chat-1"}})
            outcomes["old_response_committed"] = any("OLD_RESULT" in str(m.content) for m in snapshot.values["messages"] if m.type == "ai")
        print(json.dumps(outcomes, ensure_ascii=False))


def get_control(self):
    if self.path == "/release-slow":
        self.server.release_slow.set()
    data = json.dumps({"started": self.server.slow_started.is_set()}).encode()
    self.send_response(200)
    self.send_header("Content-Type", "application/json")
    self.send_header("Content-Length", str(len(data)))
    self.end_headers()
    self.wfile.write(data)


ModelHandler.do_GET = get_control


def main(args):
    args.root.mkdir(parents=True, exist_ok=False)
    server = ModelServer()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    endpoint = f"http://127.0.0.1:{server.server_port}/v1"
    report = {"kind": "synthetic-runtime-mechanics-only", "versions": {p: importlib.metadata.version(p) for p in ("langchain", "langgraph", "langgraph-checkpoint", "langgraph-checkpoint-sqlite")}}
    try:
        results = {}
        for stage in ("initial", "restart"):
            completed = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--worker", "--root", str(args.root), "--endpoint", endpoint, "--stage", stage], cwd=args.root, env=clean_env(), text=True, capture_output=True, timeout=40)
            if completed.returncode:
                raise RuntimeError(completed.stderr)
            results.update(json.loads(completed.stdout))
        checks = {
            "same_session_carries_history": "MARK_A_ONLY" in results["continued"]["seen"] and results["continued"]["turns"] == 2,
            "different_contact_separate_thread": results["other_contact"]["seen"] == ["MARK_B_ONLY"],
            "new_session_starts_empty": results["new_chat"]["seen"] == [],
            "new_process_restores_history": "MARK_A_ONLY" in results["restored"]["seen"] and results["restored"]["turns"] == 3,
            "other_session_runs_while_first_waits": results["parallel_other_contact"]["seen"] == ["MARK_B_ONLY"],
            "cancel_then_replace": results["cancelled"] and results["replacement"]["reply"] == "CURRENT_RESULT" and not results["old_response_committed"],
        }
        report.update(results=results, checks=checks, model_requests=server.requests)
    finally:
        server.release_slow.set()
        server.shutdown()
        server.server_close()
    path = args.root / "langchain-result.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"checks": report["checks"], "report": str(path)}, ensure_ascii=False, indent=2))
    if not all(report["checks"].values()):
        raise SystemExit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--endpoint")
    parser.add_argument("--stage")
    options = parser.parse_args()
    if options.worker:
        asyncio.run(langchain_worker(options))
    else:
        main(options)
