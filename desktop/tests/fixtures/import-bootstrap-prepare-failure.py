"""真实合成建库完成后返回损坏JSON，只验证普通页面首份准备失败边界。"""

from pathlib import Path
import runpy
import sys


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1:3] != ["create", "empty"]:
        raise ValueError("只允许本轮首份空库准备故障场景。")
    fixture = runpy.run_path(str(Path(__file__).with_name("contact-database.py")))
    fixture["create_database"]("empty", sys.argv[3])
    print("故障夹具：真实建库已完成，但JSON返回损坏")
