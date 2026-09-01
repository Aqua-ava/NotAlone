"""微信增量同步命令：开关、双通道状态观察、一次性绑定确认与联系人列表。

命令只输出状态、计数和展示名称，不输出消息正文；候选展示只包含
display name、外部会话标识与最近活动时间。
"""

from __future__ import annotations

import argparse
import os
import sys
from uuid import UUID

from notalone.application.contact_directory import (
    ContactDirectory,
    ContactDirectoryError,
)
from notalone.front_sync.factory import (
    build_cli_full_sync_engine,
    owner_wechat_account_scope,
)
from notalone.front_sync.sync_engine import (
    BindingConfirmationError,
    FrontSyncCycleReport,
)
from notalone.persistence.contact_directory import PostgresContactDirectory
from notalone.runtime_config import load_project_env


def render_report_lines(report: FrontSyncCycleReport) -> list[str]:
    """把循环报告渲染为 key=value 行；不包含任何消息正文。"""

    lines = [
        f"sync={'enabled' if report.sync_enabled else 'disabled'}",
        f"phase={report.phase.value}",
        f"probe={'ok' if report.probe_available else 'unavailable'}",
        f"wechat_front={'yes' if report.wechat_in_front else 'no'}",
        f"cli={'ok' if report.cli_available else 'unavailable'}",
    ]
    if report.failure_code is not None:
        lines.append(f"failure={report.failure_code}")
    if report.active_contact_id is not None:
        lines.append(f"contact_id={report.active_contact_id}")
    if report.active_binding_display_name is not None:
        lines.append(f"binding_display={report.active_binding_display_name}")
    if report.decision_reason is not None:
        lines.append(f"decision={report.decision_reason.value}")
    lines.append(f"batch_messages={report.batch_message_count}")
    if report.sync_mode != "foreground":
        lines.extend(
            [
                f"sync_mode={report.sync_mode}",
                f"cli_phase={report.cli_sync_phase}",
                f"cli_mode={report.cli_sync_mode or 'none'}",
                f"cli_stream={'active' if report.cli_stream_active else 'inactive'}",
                f"cli_bound={report.cli_bound_count}",
                f"cli_pending={report.cli_pending_count}",
                f"cli_batch_messages={report.cli_batch_message_count}",
                f"foreground_phase={report.foreground_phase}",
            ]
        )
        if report.cli_failure_code is not None:
            lines.append(f"cli_failure={report.cli_failure_code}")
        if report.foreground_failure_code is not None:
            lines.append(f"foreground_failure={report.foreground_failure_code}")
    for index, candidate in enumerate(report.candidates, start=1):
        last_active = (
            "unknown"
            if candidate.last_timestamp is None
            else str(candidate.last_timestamp)
        )
        lines.append(
            f"candidate[{index}] username={candidate.username} "
            f"display={candidate.display_name} last_active={last_active}"
        )
    return lines


def front_sync_main(argv: list[str] | None = None) -> int:
    """CLI 后台读取与前台定位的端到端接线入口。"""

    load_project_env()
    parser = argparse.ArgumentParser(
        prog="notalone-front-sync",
        description="微信增量同步：开关、双通道状态观察与一次性绑定确认。",
    )
    subparsers = parser.add_subparsers(dest="action", required=True)
    subparsers.add_parser(
        "status", help="执行一次 CLI 后台 + 前台定位检查，并输出同步状态。"
    )
    subparsers.add_parser("enable", help="手动开启 CLI 后台增量同步开关。")
    subparsers.add_parser("disable", help="手动关闭 CLI 后台增量同步开关。")
    confirm = subparsers.add_parser(
        "confirm-binding", help="为当前前台会话完成一次性绑定选择。"
    )
    confirm.add_argument("--contact-id", required=True, type=UUID)
    confirm.add_argument(
        "--locator",
        required=True,
        help="status 输出中的候选 username（外部会话标识）。",
    )
    subparsers.add_parser(
        "contacts", help="列出当前 owner 的联系人，便于绑定确认时选择。"
    )
    args = parser.parse_args(argv)

    database_url = os.environ.get("NOTALONE_DATABASE_URL", "").strip()
    owner_value = os.environ.get("NOTALONE_OWNER_ID", "").strip()
    if not database_url:
        return _fail("缺少 NOTALONE_DATABASE_URL 环境变量。")
    if not owner_value:
        return _fail("缺少 NOTALONE_OWNER_ID 环境变量。")
    try:
        owner_id = UUID(owner_value)
    except ValueError:
        return _fail("NOTALONE_OWNER_ID 不是合法 UUID。")

    if args.action == "contacts":
        try:
            contacts = ContactDirectory(
                PostgresContactDirectory(database_url)
            ).list_contacts(owner_id)
        except ContactDirectoryError:
            return _fail("联系人列表读取失败。")
        for contact in contacts:
            print(
                f"contact_id={contact.contact_id} "
                f"display_name={contact.display_name}"
            )
        return 0

    account_scope = owner_wechat_account_scope(
        database_url=database_url,
        owner_id=owner_id,
    )
    if account_scope is None:
        return _fail("owner 还没有微信渠道身份；请先完成一次正式导入初始化。")

    engine = build_cli_full_sync_engine(
        database_url=database_url,
        owner_id=owner_id,
        account_scope=account_scope,
    )

    try:
        if args.action == "enable":
            engine.enable_sync()
            print("sync=enabled")
            return 0
        if args.action == "disable":
            engine.disable_sync()
            print("sync=disabled")
            return 0
        if args.action == "status":
            report = engine.cycle()
            for line in render_report_lines(report):
                print(line)
            return 0
        if args.action == "confirm-binding":
            try:
                report = engine.confirm_binding(
                    contact_id=args.contact_id, locator=args.locator
                )
            except BindingConfirmationError as error:
                return _fail(f"绑定确认失败：{error}")
            except (ValueError, TypeError) as error:
                return _fail(f"绑定确认失败：{error}")
            for line in render_report_lines(report):
                print(line)
            return 0
        return _fail("不支持的子命令。")
    finally:
        engine.close()


def _fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(front_sync_main())
