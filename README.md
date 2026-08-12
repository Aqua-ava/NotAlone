# NotAlone

NotAlone 是面向具体联系人的中文关系感知回复助手。当前可执行产品代码从微信单联系人
JSONL 的只读导入预览开始；预览不会写数据库，也不会输出聊天正文。

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
默认输出还会隐藏文件名、联系人 ID 和展示名称。需要在当前终端人工核对时，显式运行：

```bash
notalone-ingest-preview --show-identifiers chat_exports/example.jsonl
```

该选项只改变当前终端的显示，不会写数据库或保存日志。

## 测试

```bash
python -m unittest discover -s tests -v
```

测试只使用合成数据，不读取 `chat_exports/` 中的私人资料。
