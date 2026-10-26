# v2 revision-03：精确catalog机制诊断

新授权的一次运行40/40事务成功，原Q40次、EXPLAIN40次均完整返回；10暖机+30计分，墙钟7.429秒。它没有复现完整HTTP的catalog残余1.8–2.1ms，不能据此相减或断言DSH/Node根因。产品与性能仍未批准。

## 固定输入与边界

- 产品精确1e90；普通businessTransaction/BEGIN，原Q SHA8a15efb91f36745a9d06eeef6e4b503d68092c95c3a1da581b33a28eb8617670、两数组各108参数不变。每单元真实fresh inspect后同lease追加一次同Q的EXPLAIN，无SQL变体、pg监听或global patch。
- 实际server_version_num=160015（16.15），read committed/read_only off；search_path=pg_catalog, public，statement_timeout=3s、lock_timeout=1s。Node固定v24.19.0、原dump/双依赖/源码/工具前后绑定通过。此前18版官方语义材料不冒充本机版本；本次选项及返回字段已在16.15实测接受。
- 初始化catalog执行0；首次暖机callback有1条设置核验控制查询，单列记录，不混入80目标执行。80执行均完成，40raw/40EXPLAIN配对同连接，5个原Q阶段各40全样本/30计分齐。
- 仅修采集：完整command/rowCount/rows先在私有0600保存，再检查rows数组/长度和QUERY PLAN结构。全部40实际返回command=EXPLAIN、rowCount=null、rows.length=1。保存发生在EXPLAIN客户端计时结束之后、断言之前，事务总时长含该保存，不拿它比较采集器版本性能。

## 30计分的描述性结果

| 边界 | n | p50 ms | p95 ms |
| --- | ---: | ---: | ---: |
| 原Q dispatch→resume | 30 | 0.906291 | 1.141993 |
| fresh文件核验 | 30 | 0.359812 | 0.565392 |
| 文件后catalog await→resume | 30 | 0.514666 | 0.643970 |
| EXPLAIN client await | 30 | 0.961375 | 1.067621 |
| EXPLAIN PG Planning | 30 | 0.195000 | 0.223050 |
| EXPLAIN PG Execution | 30 | 0.475000 | 0.542950 |
| 同次EXPLAIN Planning+Execution | 30 | 0.672500 | 0.748850 |
| 同次EXPLAIN未覆盖剩余 | 30 | 0.291312 | 0.338514 |
| 事务完整耗时（含新原件写入） | 30 | 2.299562 | 2.838698 |

同次两个PG区间可逐样本相加，但不能把两项p50相加；未覆盖剩余不是纯客户端开销。raw dispatch→resume包含重叠文件工作，不能减files；EXPLAIN输出的是计划JSON而非原catalog结果，且固定在原Q及原核验之后，不能跨执行相减。PG Planning不覆盖parse/rewrite，默认EXPLAIN也不覆盖正常结果转换/传输，观察本身有成本；首轮HTTP不能与本轮SQL中位数相减。

## name/text与实际索引计划

40份计划的节点/条件形状签名一致，完整事实在plan-facts.json。以首个计分计划为例：

- 主catalog的pg_class c_1采用Seq Scan，176返回/786过滤、loops=1、shared hits24/reads0；Hash Cond为`((required.relname)::text = c_1.relname)`。这只证明该计划选择，并未证明索引路径不可用或cast是原因。
- pg_attribute a使用pg_attribute_relid_attnam_index，Index Cond同时含`attrelid = c_1.oid`和`attname = required.attname`，loops=103；名称条件确实进入索引条件，不能声称text参数让组合索引全部失效。
- checked_tables的pg_class c使用pg_class_relname_nsp_index，Index Cond同时含relname的name[]匹配与relnamespace=n.oid，loops=1；visible分支使用pg_attribute_relid_attnum_index，attrelid与attnum条件均在Index Cond。

本轮PG Execution p50只有0.475ms；单一原计划、微小合成库和顺序对照不能说明上述Seq Scan导致完整宿主毫秒退化。当前结果削弱“这条SQL在所有环境必慢”和“name/text必然丢复合索引”的强断言，仍需完整宿主内同一次请求的证据；本轮不扩展新实验或提出产品patch。

## 旧失败和原件

- revision-02独立保留：0成功/1失败/39未执行、0计分，1原Q+1EXPLAIN已返回。其校验前未保存的实际EXPLAIN对象、rowCount/rows及计划继续unknown，不能把新run事实或纯内存单例倒灌旧记录。旧分母不替换。
- 修正前用已安装pg/lib/result.js做纯内存CommandComplete单例，确认EXPLAIN标签可对应rowCount=null而rows有一行；0PG。随后才经新授权运行revision-03，没有偷偷重跑旧目录。
- 新run的40份完整command/rowCount/rows原件初始即私有0600，全部原件与公开聚合中对应结构一致。独立原文件SHA与公开section SHA分别标注；它们不混称同一字节串。

## 数据与收尾

驱动、Node探针已退出；自有库/会话、源码及运行目录均0，独立核对0，权限违规0；所有绑定与私有源码未变。窗口已立即归还root，此后只有离线JSON分析。未读取原App/微信/资料/模型或改产品、依赖、index/commit；无HTTP/正式全量/96回复/40启动RSS验收。全部旧失败、unknown及新原始结果单列保留，性能/25/26仍不批准。
