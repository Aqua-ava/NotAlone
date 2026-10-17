"""真实子进程的App寿命边界；不使用业务库或外部读取工具。"""

import fcntl
import os
import select
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class ParentLifetimeTest(unittest.TestCase):
    def test_parent_eof_holds_database_lock_until_lingering_backend_exits(self):
        with tempfile.TemporaryDirectory(prefix="notalone-lifetime-") as directory:
            lock_path = Path(directory) / "owned-lifetime"
            lock_path.touch(mode=0o600)
            source = """
import os, sys, threading, time
from notalone.parent_lifetime import ParentLifetime
stopped = threading.Event()
with ParentLifetime(int(sys.argv[1]), sys.argv[2]) as lifetime:
    lifetime.on_exit(stopped.set)
    threading.Thread(target=lambda: time.sleep(30), daemon=False).start()
    print("ready", flush=True)
    stopped.wait()
print("cleaned", flush=True)
time.sleep(.2)
"""
            child = subprocess.Popen([sys.executable, "-B", "-c", source, str(os.getpid()), str(lock_path)],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            try:
                self.assertTrue(select.select([child.stdout], [], [], 2)[0])
                self.assertEqual(child.stdout.readline(), b"ready\n")
                child.stdin.close()
                self.assertTrue(select.select([child.stdout], [], [], 2)[0])
                self.assertEqual(child.stdout.readline(), b"cleaned\n")
                with lock_path.open("rb") as lock:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                child.wait(timeout=8)
                self.assertIsNotNone(child.returncode)
                with lock_path.open("rb") as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=3)
                child.stdout.close()
