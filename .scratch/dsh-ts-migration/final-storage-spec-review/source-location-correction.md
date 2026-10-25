# 静态库源码公开位置更正

root公开预扫描排除`node_modules`路径，因此把原静态审查的四份pg 8.16.3源码证据逐字移到`dependency/pg-8.16.3/`。只改变文件位置，四份内容SHA256均与原冻结值相同；旧路径已移除。

原静态`SHA256SUMS`、`binding.json`及其他39份artifact字节均未改。原43项的路径并非都仍存在：四个旧位置必须通过`source-location-correction.json`的显式alias核验，不改checksum冒充旧位置仍存在。实际四份是`lib/client.js`、`lib/connection-parameters.js`、`lib/query.js`、`package.json`，原冻结输入没有`lib/result.js`。

原runtime-final manifest SHA256 `51054a471e1b9b169f54c44ffc87486f5c07d9e4d10cdb42105cdcfa3b56f48c`及其整份冻结清单不改；原始运行日志仍在root指定仓库外私有子树，仅保留公开脱敏副本与basename／SHA。

新增补充公开manifest列出本次四份新位置、alias更正及所有可提交公开材料。`verify-source-aliases.py`只重验文件摘要与位置，不执行产品、测试、数据库或任何宿主。Spec结论不变：input-v1未发现可登记偏离，独立接口9/9，最终代码结论仍待最终提交绑定；总体25／性能仍未批准。
