# 原始证据位置更正

本任务仓库内三处 `private/` 共 13 份原始文件已逐字迁到用户指定的仓库外新子树，目录 0700、文件 0600。迁前后每份 bytes 与 SHA-256 一致，全部失败和原始日志保留；仓库内无私有原日志或 `private/` 目录。

`raw-location-correction.json` 只公开外部目录 basename、原校验相对路径及新文件 basename/SHA，不记录本机绝对位置。旧 SHA256SUMS 中指向已迁出文件的路径通过该 alias 映射解析；其余文件继续按原相对路径校验。全部 36 份原证据与 31 条原校验清单记录已复核，原静态 report、inputs、checks、handoff 及运行报告、绑定和校验清单均未改写。

公开保留原脱敏日志，迁出不代表重跑。原始错误不能改标通过；本轮未启动任何测试、PG、benchmark、宿主或 App，也未改产品、测试、index 或 Git。代码与总体结论沿用原审查，最终提交绑定仍须由 root 完成。

可提交范围固定在 `final-public-manifest.json` 的 `stage_files`；仅列出的公开文件允许进入本任务提交。`final-public-SHA256SUMS` 固定其内容，包含原冻结证据及本次位置更正。仓库外原始证据不在可提交范围。
