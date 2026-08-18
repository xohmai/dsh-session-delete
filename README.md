# dsh-session-delete

DSH（DeepSeek Harness）的会话删除插件：官方「归档」只是把会话移出侧栏，磁盘日志（`~/.dsh/sessions/`）永久堆积——本插件在设置页补上真正的删除，先进回收站可还原，也支持批量清理。

- **归档会话**（默认页签）：已归档会话一键真删。单条两步确认（点「删除」变红「确认删除」，4 秒未确认自动解除），或勾选批量删除
- **全部会话**：按工作区分组的全量清单，支持搜索、过滤（未归档 / 30 天未动 / 已归档 / 全部）、组选 / 全选 / 批量删除；整行点击即选中
- **回收站**：还原（原位放回）、单条彻底删除、一键清空（双重确认）；删除动作全部留审计日志
- **安全**：正在运行（模型或子代理未结束）的会话一律拒绝删除；删除是同盘原子移动而非复制；删除当前打开的会话时自动切到空白会话，界面不悬空

## 安装

三种方式任选；`dsh plugin add` 会自动完成依赖链接与 profile 注册，装完重启 `dsh web` 生效。卸载：`dsh plugin --profile web remove dsh-session-delete`。

**方式一：npm（推荐，最省事）**

```sh
dsh plugin --profile web add dsh-session-delete
```

**方式二：GitHub 直装（无需发 npm）**

```sh
dsh plugin --profile web add github:xohmai/dsh-session-delete
# 锁定版本更安全：github:xohmai/dsh-session-delete#<commit-sha>
```

本插件零构建（纯 JS，无 TypeScript / 无打包步骤），git 安装不会踩「源码拉下来没跑 build」的坑，也无需 pnpm allowBuilds 授权。

**方式三：tarball 离线分发（内网 / 不发 npm 场景）**

```sh
npm pack                                             # 产出 dsh-session-delete-0.1.0.tgz（约 22 kB / 8 个文件）
dsh plugin --profile web add ./dsh-session-delete-0.1.0.tgz
```

## 使用

1. 重启 DSH 后打开**设置 → 归档会话**
2. 想清理某个会话：先在侧栏该会话上**右键 → 归档会话**，再到本页删除（也可以直接在「全部会话」页签删，无需先归档）
3. 删除即入回收站：文件移至 `~/.dsh/trash/sessions/`，后悔了在「回收站」页签**还原**；确定不要了再**彻底删除**或**清空**
4. 删除统计与释放空间会以通知形式反馈（成功 6 秒自动消失，失败常驻）

**彻底找回一个已还原的会话**：官方没有「解除归档」API，还原后的会话仍对侧栏隐藏。需要在 **DSH 停止时**运行随包附带的工具，把会话移出归档集后再启动：

```sh
node tools/unhide.mjs <sessionId>     # 自动备份 workspace.json
```

## 已知边界

- 回收站位置：`<DSH_HOME>/trash/sessions/`（默认 `~/.dsh/trash/sessions/`），审计日志 `trash/sessions/audit.log`
- 子代理会话不级联删除：列表中带「子代理」标记，可单独或勾选删除
- 投影缓存可能残留无害死条目，DSH 重启自愈

## 排障

- 设置页「归档会话」点开空白：先 **Ctrl+Shift+R 硬刷新**（开发期热重载可能留下失活槽位）。仍空白时按 F12 查看 Console——本插件自带错误边界，会显示具体错误信息而非空白
- 列表里标题显示为「未命名」：属正常现象（该会话从未产生过可折叠的标题），悬浮行可看完整 id

## 开发

```sh
node test/smoke.mjs    # 宿主半：桩 ctx 驱动全部路由（删除流水线/回收站/运行保护/CSRF）
node test/render.mjs   # 客户端半：SSR 渲染冒烟（设置页组件/注册壳/props 缺失兜底）
```

零构建：宿主半是普通 Node 模块，客户端半手写 `__ModuleLoader__` 包壳，改完即生效（客户端热重载；宿主半需重启 DSH）。
