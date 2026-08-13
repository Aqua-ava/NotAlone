# NotAlone

NotAlone 是面向具体联系人的中文关系感知回复助手。当前可执行产品代码支持微信单联系人
JSONL 的只读预览，以及经过联系人确认后的 PostgreSQL 正式导入。

## 开发环境

所有 Python 命令必须在 Conda 环境 `NotAlone` 中运行：

```bash
conda activate NotAlone
python -m pip install -e .
```

## 导入预览

```bash
notalone-ingest-preview chat_exports/example.jsonl
```

预览会校验完整文件、识别唯一联系人并统计消息类型。输入文件损坏、混有多个联系人或
消息字段不符合契约时，命令以非零状态退出；错误信息只包含行号和字段，不显示消息正文。
单个 JSONL 文件上限为 64 MiB、消息记录上限为 500,000 条；超限文件会被拒绝处理。
默认输出还会隐藏文件名、联系人 ID 和展示名称。需要在当前终端人工核对时，显式运行：

```bash
notalone-ingest-preview --show-identifiers chat_exports/example.jsonl
```

该选项只改变当前终端的显示，不会写数据库或保存日志。

## 正式导入

正式导入前，必须先运行预览并人工确认联系人 ID。数据库中还必须已经存在对应的
`owner`；导入命令不会从聊天记录推断或创建 owner。

数据库连接串只通过环境变量提供，不写入仓库：

```bash
export NOTALONE_DATABASE_URL='postgresql:///notalone_dev'
notalone-ingest chat_exports/example.jsonl \
  --owner-id '00000000-0000-0000-0000-000000000000' \
  --contact-id 'wxid_example'
```

命令会再次完整校验文件，并要求 `--contact-id` 与文件识别出的联系人完全一致。同一
`owner_id + contact_id + SHA-256` 的 active 来源重复执行时不会重复写入消息。联系人、
来源和全部消息在同一事务中写入，任何一步失败都会整体回滚。终端输出只包含导入状态和
消息数量，不输出聊天正文、联系人 ID、owner ID、文件 SHA 或数据库连接串。

不同 SHA 文件若与该联系人已有来源复用 `id.local_id`，命令会拒绝整批导入；它不会
自动合并或改写旧消息的权威来源。

## 测试

```bash
python -m unittest discover -s tests -v
```

测试只使用合成数据，不读取 `chat_exports/` 中的私人资料。

PostgreSQL 集成测试默认使用本地 `notalone_test` 数据库，也可以通过
`NOTALONE_TEST_DATABASE_URL` 指定其他名称以 `_test` 结尾的隔离测试库。每个用例使用
随机 owner 并只清理自己的合成数据；测试拒绝连接名称不以 `_test` 结尾的数据库。
