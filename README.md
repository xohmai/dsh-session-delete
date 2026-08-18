# dsh-session-delete

DSH（DeepSeek Harness）会话删除插件：官方「归档」只把会话移出侧栏，磁盘日志永久堆积——本插件补上真正的删除，先进回收站可还原。

- **归档会话**：已归档会话一键真删，单条两步确认，或勾选批量删除
- **全部会话**：按工作区分组，支持搜索、过滤、全选、批量删除，点击整行即可选中
- **回收站**：删除的会话可还原、可彻底删除、可一键清空
- 正在运行的会话拒绝删除；删除当前打开的会话时自动切到空白会话

## 安装

```sh
dsh plugin --profile web add github:xohmai/dsh-session-delete
# 或发布 npm 后：dsh plugin --profile web add dsh-session-delete
```

装完重启 `dsh web` 生效。卸载：`dsh plugin --profile web remove dsh-session-delete`。

## 使用

1. 打开 **设置 → 归档会话**
2. 在侧栏右键归档的会话会出现在「归档会话」页签，直接删除；也可在「全部会话」页签删除任意会话
3. 删除先入回收站（`~/.dsh/trash/sessions/`），后悔可「还原」，确定不要再「彻底删除」

**找回已还原的会话**：官方没有「解除归档」API，还原后的会话仍对侧栏隐藏。在 DSH 停止时运行随包工具后再启动：

```sh
node tools/unhide.mjs <sessionId>
```
