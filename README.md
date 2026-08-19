# dsh-session-delete

DSH（DeepSeek Harness）会话删除插件：官方「归档」只把会话移出侧栏，磁盘日志永久堆积——本插件补上真正的删除，先进回收站可还原。

- **归档会话**：已归档会话行内「还原」解除归档（侧栏原分组立即可见），或一键真删，支持勾选批量
- **全部会话**：按工作区分组，支持搜索、过滤、全选、批量删除，点击整行即可选中
- **回收站**：还原时文件归位并自动解除归档（一步回到侧栏），可彻底删除、一键清空
- 正在运行的会话拒绝删除；删除当前打开的会话时自动切到空白会话

## 安装

`dsh plugin add` 会自动完成依赖链接与 profile 注册，装完重启 `dsh web` 生效。卸载：`dsh plugin --profile web remove dsh-session-delete`。

**方式一：GitHub 直装（推荐）**

```sh
dsh plugin --profile web add github:xohmai/dsh-session-delete
# 锁定版本更安全：github:xohmai/dsh-session-delete#<commit-sha>
```

本插件零构建（纯 JS，无 TypeScript / 无打包步骤），git 安装不会踩「源码拉下来没跑 build」的坑，也无需 pnpm allowBuilds 授权。

**方式二：tarball 离线分发（内网场景）**

```sh
npm pack                                               # 产出 dsh-session-delete-0.1.0.tgz
dsh plugin --profile web add ./dsh-session-delete-0.1.0.tgz
```

## 使用

1. 打开 **设置 → 归档会话**
2. 在侧栏右键归档的会话出现在「归档会话」页签：行内「还原」解除归档（侧栏原分组立即可见），或删除；「全部会话」页签可处理任意会话
3. 删除先入回收站（`~/.dsh/trash/sessions/`），「还原」时文件归位并自动解除归档；确定不要再「彻底删除」

**旧版 DSH 回退**：在线解除归档走 workspaceRegistry 内部状态机，插件启动时自动探测能力；不可用时隐藏还原入口，可在 DSH 停止时运行 `node tools/unhide.mjs <sessionId>` 离线找回。

## 开发

```sh
npm test   # node test/smoke.mjs && node test/render.mjs
```

## License

Apache-2.0
