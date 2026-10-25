"""冻结旧公开学习存储的空批次观察；不构造任务，不导入模型 SDK。"""
import json
from pathlib import Path
import socket
import sys
from uuid import UUID, uuid4


def main():
    value = json.loads(Path(sys.argv[1]).read_text())
    assert value['database'].startswith('notalone_ts_host_') and value['database'].endswith('_test')
    original = socket.socket.connect

    def pg_only(sock, address):
        assert isinstance(address, str) and address.startswith('/tmp/.s.PGSQL.'), 'non_pg_network_forbidden'
        return original(sock, address)

    socket.socket.connect = pg_only
    sys.path.insert(0, value['frozen_source'])
    from notalone.scopes import ContactScope
    from notalone.persistence.skill_learning import PostgresSkillLearningStore
    store = PostgresSkillLearningStore('host=/tmp dbname=' + value['database'])
    scope = ContactScope(UUID(value['scope']['owner_id']), UUID(value['scope']['contact_id']))
    store.configure(scope, enabled=True, operation_key=uuid4(), expected_revision=0)
    task = store.enqueue(scope)
    batch = store.capture(scope)
    assert task is None and batch.ready is False, 'taskless_empty_batch_required'
    print(json.dumps({'status': 'not_ready', 'task_id': None, 'batch_ready': batch.ready,
                     'entry': 'PostgresSkillLearningStore.configure/enqueue/capture'}))


if __name__ == '__main__':
    main()
