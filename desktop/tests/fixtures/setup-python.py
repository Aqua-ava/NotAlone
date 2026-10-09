"""受控解释器边界：只为真实后端加载本轮独立配置，不读私人 dotenv。"""

import os
from pathlib import Path
import runpy
import sys


selected = Path(os.environ["NOTALONE_ENV_FILE"])
directory = Path(os.environ["NOTALONE_TEST_SETUP_DIRECTORY"])
if selected.parent != directory or selected.name != "synthetic.env":
    raise SystemExit("首启测试配置范围无效。")
if selected.is_file():
    for line in selected.read_text(encoding="utf-8").splitlines():
        key, separator, value = line.partition("=")
        if separator and key in {"NOTALONE_OWNER_ID", "NOTALONE_DEEPSEEK_API_KEY"}:
            os.environ[key] = value
# 即使意外发起模型请求，也只能访问无服务的本机端口。
os.environ["NOTALONE_DEEPSEEK_BASE_URL"] = "http://127.0.0.1:1"
os.environ["NOTALONE_DISABLE_DOTENV"] = "1"
if len(sys.argv) < 3 or sys.argv[1] != "-m":
    raise SystemExit("首启测试只允许模块入口。")
module = sys.argv[2]
if module == "notalone.server.command" and (directory / "restart-unavailable").exists():
    raise SystemExit("合成机器启动边界暂不可用。")
sys.argv = [module, *sys.argv[3:]]
runpy.run_module(module, run_name="__main__")
