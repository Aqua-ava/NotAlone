"""只安排本轮随机合成库的旧快照或请求移除；业务断言经过公开HTTP。"""

import json
import os
import re
import sys
from uuid import UUID

import psycopg


def main() -> None:
    if os.environ.get("CONDA_DEFAULT_ENV") != "NotAlone":
        raise ValueError("本轮依据安排必须使用NotAlone环境。")
    values = json.load(sys.stdin)
    database_url = values["database_url"]
    name = re.search(
        r"(?:^|\s)dbname=(notalone_core_flow_[0-9a-f]{32}_test)(?:\s|$)",
        database_url,
    )
    if name is None:
        raise ValueError("只允许本轮随机合成测试库。")
    owner_id, contact_id, request_id = (
        UUID(values[key]) for key in ("owner_id", "contact_id", "request_id")
    )
    with psycopg.connect(database_url) as connection:
        if connection.info.dbname != name[1]:
            raise ValueError("测试库身份不一致。")
        if values["operation"] == "remove_request":
            connection.execute(
                "DELETE FROM public.reply_request "
                "WHERE owner_id=%s AND contact_id=%s AND id=%s",
                (owner_id, contact_id, request_id),
            )
        elif values["operation"] == "legacy_timing":
            connection.execute(
                """UPDATE public.reply_request
                SET context_snapshot=jsonb_set(context_snapshot, '{evidence}',
                    (SELECT jsonb_agg(item - 'timing')
                     FROM jsonb_array_elements(context_snapshot->'evidence') AS item))
                WHERE owner_id=%s AND contact_id=%s AND id=%s""",
                (owner_id, contact_id, request_id),
            )
        else:
            raise ValueError("未知依据安排。")


if __name__ == "__main__":
    main()
