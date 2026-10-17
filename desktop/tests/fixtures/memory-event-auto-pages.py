"""自动版本页面场景复用公开导入与隔离库夹具，不启动浏览器。"""

from memory_event_updates_fixture import main

if __name__ == "__main__":
    main(mode="auto", page_protocol=True)
