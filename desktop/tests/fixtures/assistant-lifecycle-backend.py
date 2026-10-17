"""生命周期验收：生产同步宿主配合固定非微信合成输入，不访问真实桌面。"""

import importlib.util
import json
import os
import sys
from pathlib import Path


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


rewrite = load("lifecycle_rewrite", "rewrite-backend.py")
support = load("lifecycle_sync", "continuous-sync-support.py")


class LifecycleFixture(rewrite.DesktopRewriteFixture):
    def sync_control(self, owner_id):
        directory = Path(os.environ["NOTALONE_ENV_FILE"]).parent
        (directory / "probe-state.json").write_text(json.dumps({"wechat_in_front": False}))
        (directory / "cli-state.json").write_text(json.dumps({"sessions": [], "messages": {}}))
        host = support.build_sync(self, owner_id)
        host.enable()
        return host


if __name__ == "__main__":
    LifecycleFixture._prepared_database_name = rewrite.bind_prepared_database()
    rewrite.DesktopRewriteFixture = LifecycleFixture
    rewrite.main()
