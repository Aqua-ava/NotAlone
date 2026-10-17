"""PostgreSQL 通知适配器：提交后唤醒，持久范围修订才是权威。"""

from threading import Event, Thread

import psycopg


class LayeredChangeFeed:
    def __init__(self, database_url, owner_id, callback):
        self._database_url = database_url
        self._owner_id = str(owner_id)
        self._callback = callback
        self._stopped = Event()
        self._thread = Thread(target=self._run, name='notalone-layered-changes', daemon=True)
        self._thread.start()

    def _run(self):
        while not self._stopped.is_set():
            try:
                with psycopg.connect(self._database_url, autocommit=True, application_name="notalone-layered-change-feed") as connection:
                    # 先订阅再补扫；连接中断期间的通知即使丢失也不丢持久目标。
                    connection.execute('LISTEN layered_memory_changed')
                    delay = 0.0
                    while not self._stopped.is_set():
                        notified = False
                        for notification in connection.notifies(timeout=min(delay, 0.5), stop_after=1):
                            notified |= notification.payload == self._owner_id
                        if self._stopped.is_set():
                            break
                        if notified or delay <= 0.5:
                            delay = self._callback()
                        else:
                            delay -= 0.5
            except (psycopg.Error, RuntimeError):
                # 重连只重建通知连接，仍交由原任务租约去重，不创建第二套执行器。
                self._stopped.wait(0.5)

    def stop(self):
        self._stopped.set()
        self._thread.join(timeout=1.5)
