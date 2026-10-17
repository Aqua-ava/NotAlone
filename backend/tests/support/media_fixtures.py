"""D1/D2/D3 可复用合成 Reader；不是微信 schema 或真实关联证明。"""
from notalone.wechat_media.locator import MediaLocation
from contextlib import contextmanager
from threading import Event

class SyntheticReader:

    def __init__(self, path):
        self.path = path

    def locate(self, authorization, target):
        return (MediaLocation(authorization, 'synthetic-dataset', 'message-shard-0', 'SyntheticMessage', 'row-7', 'media-shard-0', 'SyntheticResource', 'row-9', 'synthetic-join-v1', 'original'),)

    def open(self, location):
        return self.path.open('rb')

class BlockingReader(SyntheticReader):

    def __init__(self, path):
        super().__init__(path)
        self.started = Event()
        self.release = Event()

    @contextmanager
    def open(self, location):
        self.started.set()
        if not self.release.wait(5):
            raise TimeoutError('synthetic reader timeout')
        with super().open(location) as source:
            yield source
