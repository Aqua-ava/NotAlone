"""单轮前台观察的有限预算；不改变五秒新鲜度及单帧边界。"""

# 实机完整原生观察曾超过900ms；为启动、窗口采集及OCR保留有限余量。
FRESH_PROBE_SECONDS = 2.5
FOREGROUND_OBSERVATION_SECONDS = 3.2
