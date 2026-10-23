# 合成旧库与恢复基线

本票使用旧实现提交 `3c168296e9e8edaa43b8b323ff693e790e709069` 的正式迁移、HTTP 服务和既有合成模型夹具。生成器见 [build_synthetic_snapshot.py](build_synthetic_snapshot.py)，实测记录见 [snapshot-evidence.json](snapshot-evidence.json)。业务生产代码没有修改。

## 查证与边界

已阅读 DSH 候选提交 `687f282e8625c6b8d11ff58211a90524be2e4317` 的 `packages/bundle/sdk-minimal/README.md`、`cordis.patch.yml:20` 及 `packages/core/agent/src/index.ts:145`：最小 profile 仍装配额外上报和 JSONL；`AgentHandle.dispose` 清理框架会话，不承担关系资料删除。本生成器不涉及直接 DSH 接口，仅固定原有业务身份和存储值，后续以此检验迁移。完整证据见 [DSH 查证](dsh-official-evidence.md)。

## 实际覆盖

- 两位合成用户、三位联系人、三个稳定渠道绑定、三个来源和九条消息；同用户不同联系人以及跨用户作用域均有样本。
- 三条候选记忆与三条自动采纳记忆，保留来源链；三个任务、十五个步骤及提取记录；合成维度显式放行，不冒充生产默认采纳策略。
- 三份回复及来源引用、幂等请求，三个持久讨论会话及输入。生成后重放结果不变；他人讨论读取返回 404。
- 三份联系人 Skill 版本及九个文件。采用已有目录发布夹具，保留文件哈希、正文路径和数据库身份。
- 两份 `selected` 同步范围，以及分别为 `accepted`／`declined` 的合成历史授权记录。授权行直接构造用于存储兼容比对，没有开启真实微信读取；“无授权行”的行为由既有授权测试负责。

本次共 107 条正式迁移，103 张 public 表，43 张非空表、462 行。将旧库 `pg_dump` 恢复到另一独立随机库后，所有 public 表的完整行规范化哈希一致；不是仅对行数。结束后检查本轮两个数据库均不存在。产物约 763 KB，加上 Skill 文件，留在忽略目录 `generated/verified/`；只提交合成摘要及可重建脚本。

原有 `test_core_business_flow` 另已实测通过，覆盖导入、带依据回复、换服务实例幂等重放、跨联系人／用户拒绝和来源删除后失效。测试中的跨联系人拒绝会产生预期日志 `ReplyContextInvariantError`，结果为通过。

## 重建及用于下一切片

从仓库根目录、项目 Python 环境执行；本机需有 PostgreSQL `/tmp` socket、当前用户创建测试库权限，同一 Python 环境相邻目录需有 `pg_dump`／`pg_restore`。

```sh
python .scratch/dsh-ts-migration/baseline/build_synthetic_snapshot.py .scratch/dsh-ts-migration/baseline/generated/new-run
```

输出目录必须尚不存在，且 `backend/` 必须与上述旧实现提交一致，否则脚本拒绝生成，避免把新实现误记为旧基线；以后需要重建时使用独立旧版本检出。脚本禁止 dotenv，创建随机且校验过名称的独立测试库，应用正式迁移，生成合成数据，导出并恢复比对，最终删除本轮数据库；不会连接业务库。模型为固定脚本响应，没有真实模型请求。异常由 unittest 的清理回调收尾；若进程被强制终止则不能假定清理完成，应按本轮进程及库名查明归属后处理。

产物包括 `old-backend.dump`、`skills/`、`manifest.json` 和 `cleanup.json`。后续切片从**同一份**快照恢复两份独立测试库比较旧实现与新实现，不能分别生成随机身份后仅比数量。数据库 `reply_skill_version.content_path` 保留生成时临时目录；重放前必须根据 `manifest.json.original_skill_root` 将该明确前缀映射到产物 `skills/`，两边采用相同映射，并逐文件核对 `skill_files` 哈希。不得把旧路径直接用于迁移演练或读取其他目录。

## 已知限制

这是数据兼容种子，不代表全产品端到端验收：导入采用既有 legacy 合成入口，不证明新用户绑定流程；未使用真实 App、微信、私人资料或供应商模型，没有测出真实质量、费用及延迟。空表表示此种子没有该领域数据，L2/L3、学习、撤销／删除、在途任务、预算及跨域删除等状态必须随对应切片补充现有具名测试，不能只凭此快照通过迁移。

生成器首次运行因同 owner 的 Skill 重名约束失败，已修正为每位联系人独立合成名称；没有修改产品约束。修正后完整恢复比对通过，加入明确清理核验后再次通过（2.182 秒，仅夹具用时，不是生产性能基线）。
