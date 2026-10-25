# 有限业务 SQL 诊断计划

- 范围：一次固定合成 dump、自有随机 `_test` 库、单连接串行；不运行 HTTP、宿主、App、模型或正式评测，不修改生产／测试。
- 旧臂固定 `3c168296e9e8edaa43b8b323ff693e790e709069`；新业务代码须匹配 `production-03` 六个业务文件的 SHA256。HostStorage WIP 不作为本次直接 SQL 执行对象。
- 完整 `diagnosing-bugs` HTTP 复现仍未执行；已有记录是失败信号，本次只做用户明确授权的 SQL 分段归因，不冒充原反馈回路。

## 执行前的可证伪预测

1. 若 sources 的额外业务往返是主要业务成本，三次范围版本与两次锁应占六步总 SQL 等待的大部分；逐样本记录六步，保留前读→联系人锁→owner 锁→锁后复读→目录→末尾复读的顺序及比较，不跳过保护。
2. 若 contacts 新的 observation EXISTS／SQL JSON 构造增加主要数据库执行成本，新旧主 SELECT 的实际计划或服务端执行时间应出现稳定差异；同库同连接交替执行，保留结果数量和规范化摘要，随后各取一次 EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)。
3. 若大结果量／大 DTO 解释 sources 延迟，应看到非空目录或较大结果；现有全部计分响应已经独立匹配空列表，本次确认行数。直接 SQL 的 Python 解码不代表新 pg/JS 解码，不能据此排除所有适配成本。
4. 若只有业务 SQL 即能解释全部 HTTP 回退，测得的可重复业务差异应与 HTTP 增量同量级；若远小于增量，则继续保留 HostStorage、调度和适配成本未知，不从两个不同运行的中位数作可加总归因。

## 唯一测量流程与边界

- 命令：由白名单冻结 `plan.python` 执行本目录 `measure-sql.py`；`NOTALONE_SQL_PG_RESTORE` 只接受 root 指定的现有工具。命令不接收真实 App 配置或原环境。
- 仅从允许的 `schema.env` 提取本机连接参数，连接管理库创建自有库；不连接或查询原合成源库／用户库。通过已批准 pg_restore 导入固定 `synthetic.dump`，禁止下载或安装。
- 10 次预热＋30 次计分，保留全部样本。contacts 旧新交替、同一 psycopg Adapter、`prepare=False`；sources 每次在原普通 BEGIN 事务内执行原六步及相同三个 SET LOCAL，最后 COMMIT。
- SQL 主体、协议请求、临时库与 dump 分别绑定摘要。Python 端时间包括该 Adapter 的往返与解码，不能宣称测到了 Node pg 的专属解码。
- 在诊断外另取 sources 目录、scopeRevision 的实际计划；EXPLAIN 时间不混入样本。计划只保留合成身份占位符。
- 整体计时上限 110 秒，PG 单语句 3 秒、锁 1 秒，restore 45 秒。长流程后台执行，单次工具等待小于 60 秒；完成或失败都删除自有库、关闭自有连接与子进程。
- root 与主作者均已确认暂停其他诊断负载；另外记录本库额外活动连接计数和系统 loadavg，跨库／系统噪声仍标未知，不作正式资格声明。
- 公共证据只含相对路径、哈希、计划与数值；原始错误如有写本目录 `private/`（0700／0600）。结束立即通知双方释放窗口。
