"""通过公开追踪和记忆接口检查自动候选终结，不依赖存储内部字典。"""

from uuid import UUID


def failed_automatic_candidate(test, store, scope, traces):
    """保留失败候选供原始字段断言，同时确认它没有成为待确认任务。"""
    test.assertEqual(store.list_pending_candidates(scope), ())
    batch, = traces.list_batches(scope)
    detail = traces.get_batch(scope, batch["trace_id"])
    failure, = [event["payload"] for event in detail["events"]
                if event["stage"] == "candidate_result"
                and event["payload"].get("disposition") == "automatic_write_failed"]
    candidate = store.get_candidate(scope=scope, candidate_id=UUID(failure["candidate_id"]))
    test.assertEqual(candidate.status.value, "rejected")
    test.assertIsNotNone(candidate.failure_reason)
    return candidate
