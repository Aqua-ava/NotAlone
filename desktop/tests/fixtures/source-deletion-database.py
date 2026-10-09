"""仅安排本轮来源删除的随机合成库，建库前保存精确归属。"""

import runpy
import sys
from pathlib import Path


if __name__ == "__main__":
    fixture = runpy.run_path(str(Path(__file__).with_name("contact-database.py")))
    if len(sys.argv) == 3 and sys.argv[1] == "create":
        import json

        print(json.dumps(fixture["create_database"]("ready", sys.argv[2])))
    elif len(sys.argv) == 3 and sys.argv[1] == "drop":
        fixture["drop_database"](sys.argv[2])
    else:
        raise ValueError("只允许本轮来源删除库的具名准备和精确清理。")
