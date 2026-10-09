"""只替换本轮外部探针输入：微信不在前台，不读取或返回图帧。"""

import json
import sys


if __name__ == "__main__":
    if sys.argv[1:] != ["--session", "--json", "--minimal-region"]:
        raise ValueError("合成定位探针只允许一次会话元数据观察。")
    print(json.dumps({"ok": True, "wechat_in_front": False}))
