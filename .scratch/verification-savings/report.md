# 核验 local-ids-v3 体积量化
日期：2026-11-11；仅合成数据、本地纯函数与模型桩，无真实模型调用。
工作负载：复制现有合成存档候选；5/20/60 候选使用 min(N,20) 条 target 文字，60 候选循环引用20条；图文每候选引用1条文字及全部1/3张共享图。
请求B = system原文 + 紧凑user JSON + 紧凑tool.parameters JSON 的UTF-8字节之和；不含HTTP封装和各格式相同的图片字节。
响应仅含必填字段，沿用存档短说明（非数学最短JSON）；24份均通过schema及正式解码/重放准入。
分项字节、Unicode码点字符及token估算见 [metrics.csv](metrics.csv)；token粗估=字符/4，非供应商计费或真实生成量。合计减少=(旧请求+旧响应)−(v3请求+v3响应)，百分比分母为旧合计。
旧合同固定962ed44b965afbe4e7ca15b9eea46a4ae4e9f612（7769fe4ae^），现行源码基线f5317da93；文字旧格式名complete-claim-v1，nested/flat仅适用于图文。
* nested-v1存档无历史system/schema，此两部分按decoder结构重建，数值仅供参考；包含结构变化收益，不计主要平均值。
| 候选/图 | 格式 | 请求B | 响应B | 转v3合计减少B/% |
|---|---|---:|---:|---:|
| 5/0 | complete-claim-v1 | 28990 | 7042 | 368/1.02% |
| 5/0 | local-ids-v3 | 28711 | 6953 | 0/0% |
| 5/1 | nested-v1* | 14517 | 10627 | 5974/23.76% |
| 5/1 | flat-fields-v2 | 9385 | 11057 | 1272/6.22% |
| 5/1 | local-ids-v3 | 8972 | 10198 | 0/0% |
| 5/3 | nested-v1* | 15581 | 13497 | 7474/25.7% |
| 5/3 | flat-fields-v2 | 10449 | 13927 | 2772/11.37% |
| 5/3 | local-ids-v3 | 9786 | 11818 | 0/0% |
| 20/0 | complete-claim-v1 | 41940 | 27872 | 368/0.53% |
| 20/0 | local-ids-v3 | 41661 | 27783 | 0/0% |
| 20/1 | nested-v1* | 26917 | 42212 | 6994/10.12% |
| 20/1 | flat-fields-v2 | 21785 | 43932 | 3582/5.45% |
| 20/1 | local-ids-v3 | 21372 | 40763 | 0/0% |
| 20/3 | nested-v1* | 29151 | 53692 | 12244/14.78% |
| 20/3 | flat-fields-v2 | 24019 | 55412 | 8832/11.12% |
| 20/3 | local-ids-v3 | 23356 | 47243 | 0/0% |
| 60/0 | complete-claim-v1 | 68980 | 83432 | 368/0.24% |
| 60/0 | local-ids-v3 | 68701 | 83343 | 0/0% |
| 60/1 | nested-v1* | 52757 | 126452 | 9714/5.42% |
| 60/1 | flat-fields-v2 | 47625 | 131612 | 9742/5.44% |
| 60/1 | local-ids-v3 | 47212 | 122283 | 0/0% |
| 60/3 | nested-v1* | 58111 | 160892 | 24964/11.4% |
| 60/3 | flat-fields-v2 | 52979 | 166052 | 24992/11.41% |
| 60/3 | local-ids-v3 | 52316 | 141723 | 0/0% |
九窗口等权（文字complete、图文flat各自对v3）：每次平均少请求442.33字符、少响应5359字符（约1339.75 token），合计5801.33字符（约1450.33 token）；合计少5810.67B，不代表线上频率分布。
指纹在旧响应顶层每次仅一次：省89字符；flat响应节省=89+N×(29+125×图片数)，其中29为文字证据的两个null槽，125为每条图片证据file_id及sha256。
未发现哈希泄漏：9种窗口的system/user/schema均通过 /[a-f0-9]{64}/iu 及哈希字段断言，本地64位指纹仍保留。
复现：根目录 pnpm install；node .scratch/verification-savings/measure.mjs > .scratch/verification-savings/metrics.csv（--table显示此表）。
验证：backend-ts内 node --test test/verification-no-hash-in-request.test.mjs 9/9；node --test 文件名匹配verification|multimodal|complete-claim的11文件 60/60；另测extraction-window-digest-once与extraction-policy-retirement共6/6，合计13文件66/66，无跳过；公开历史基线扫描0命中。
边界：无src/desktop源码变更、未启动App、未读写NotAloneDesktop用户资料；工作树缺少architecture/README.md等忽略文档，按现有代码/夹具核验，未修范围外问题。
