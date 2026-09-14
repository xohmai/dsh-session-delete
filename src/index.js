/**
 * dsh-session-delete — Host half.
 *
 * 本机 HTTP 路由（loopback，Cache-Control: no-store；非 GET 要求自定义头
 * `x-dsh-plugin: session-delete` 作最低限度 CSRF 防线——自定义头跨域必触发
 * 预检，而本服务不答 CORS 预检）：
 *   GET  /api/session-delete/list           全量会话清单（清理面板数据源）
 *   GET  /api/session-delete/preview?id=    单会话删除预览
 *   POST /api/session-delete/delete         { id } 归档 + 移入回收站（保留归档隐藏）
 *   GET  /api/session-delete/trash          回收站清单
 *   POST /api/session-delete/restore        { entry } 原位还原 + 自动解除归档
 *   POST /api/session-delete/unarchive      { id } 在线解除归档（旧版回退 501）
 *   POST /api/session-delete/purge          { entry? , all? } 彻底删除（保留归档隐藏）
 *
 * 删除流水线（顺序不可换）：
 *   1. 运行保护：agents.get(id) 存在且 status !== 'idle' → 拒绝
 *   2. workspaceRegistry.archiveSession(id) —— 必须在文件移动之前调用：
 *      官方实现要求会话「live 或仍在持久化清单中」，归档后宿主会向客户端
 *      广播 host/archived-sessions-changed，侧栏即时隐藏；
 *   3. sessionPersistence.locate(header) 定位真实磁盘目录（不硬编码路径）；
 *   4. rename 移入 <DSH_HOME>/trash/sessions/<时间戳>-<id>/data/（回收站）；
 *   5. 归档 id 保留（keptHidden），运行期间永不摘除：
 *      客户端侧栏的行来自内存 list store——只有 host/session-removed 帧
 *      （仅 live 会话 dispose 时宿主才发）或全新的 session.list 基线才能把
 *      行移除；冷会话被删后宿主不发任何帧，行一直留在已连接客户端的 store
 *      里。此时若把 id 摘出归档集，archived-sessions-changed 广播会把这条
 *      残留行重新显示回侧栏（"删除后又回到工作区"）；live 会话同理（宿主
 *      session.list 无条件从内存吐活会话，DSH 也没有公开的他人 agent 卸载
 *      API——dispose 闭包私有于 agent-loop 工厂）。归档集只是隐藏标记：
 *      没有行的 ghost id 在官方 UI 里不渲染任何东西，保留代价为零。
 *      ghost 的最终清理由「宿主重启时的 reconcile」完成（见 apply 尾部）：
 *      重启后所有客户端都用全新基线重建 store，已删会话的行不复存在，此时
 *      摘除归档 id 不可能复活任何东西。操作方客户端删除后还会主动调
 *      sessions.refresh() 剪掉自己 store 里的残留行（见 client 半）。
 *      live 会话后续的 flush 会因父目录已移走而 ENOENT 失败（append 用
 *      open("a") 但目录不存在），不会在磁盘上重建会话。
 *
 * 审计：<DSH_HOME>/trash/sessions/audit.log（JSONL 追加）。
 *
 * 已知边界（有意为之，见 README）：
 *   - 取消归档没有公开 API，走 registry 内部状态机（enqueueOperation /
 *     requireState / setState，与 archiveSession 同源）。setState 落盘触发
 *     domain/changed(workspace)，宿主 apiproxy 检测到归档集变化后自动广播
 *     host/archived-sessions-changed，侧栏即时恢复——与归档传播完全对称。
 *     能力探测失败（未来版本内部变更）时：/unarchive 回退 501 UNSUPPORTED；
 *     重启 reconcile 同样静默跳过（旧版无法改 archivedSessionIds，ghost
 *     只能由 tools/unhide.mjs 离线清理）。
 *   - 投影缓存 session_projcache.json 中可能残留死条目（无害，重启自愈）。
 *   - 搜索索引（sqlite）按磁盘清单 reconcile，文件消失后自动清行。
 */
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

export const name = 'session-delete'
export const inject = ['webServer', 'sessionPersistence', 'workspaceRegistry', 'agents']

const PREFIX = '/api/session-delete'
/** 自定义头防跨站 POST（见文件头注释）。 */
const PLUGIN_HEADER = 'x-dsh-plugin'
/**
 * 会话 id 白名单（宽进严出：仍要求存在于磁盘清单，见 inventory()）。
 * 接受 DSH 核心实际生成的三种会话 id 形态：
 *   - session-<uuid>              主会话（dsh-headless / dsh-session 生成）
 *   - <uuid>                      可延续子代理（dsh-subagent startContinuable 生成裸 UUID）
 *   - <id>-session-<uuid>         配置子代理（dsh-agent-loop 生成）
 * 长度上限 80 与回收站条目名白名单 ENTRY_RE（{1,120}）保持兼容：
 * 条目名 = <UTC 紧凑时间戳 15 字符> + '-' + id，15 + 1 + 80 = 96 ≤ 120，
 * 因此任何被本插件删除的会话其回收站条目必然能 restore / purge（不会自造不可还原条目）。
 * 字符集 [A-Za-z0-9-] 拒绝 `/`、`\`、`.`、`..`、引号等路径穿越载荷。
 */
const ID_RE = /^[A-Za-z0-9-]{8,80}$/
/** 回收站条目名白名单（时间戳-id，无路径分隔符）。 */
const ENTRY_RE = /^[A-Za-z0-9._-]{1,120}$/
/** 回收站根内的保留文件名（审计日志），不可作为条目操作。 */
const AUDIT_LOG = 'audit.log'

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function httpError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code })
}

/** 递归求目录字节占用；不可读条目按 0 计，不抛错。 */
async function dirSize(path) {
  let total = 0
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += await dirSize(child)
    else if (entry.isFile()) {
      try {
        total += (await stat(child)).size
      } catch {
        /* 并发消失的文件忽略 */
      }
    }
  }
  return total
}

async function dirMtime(path) {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return 0
  }
}

/** 回收站条目名：<UTC 紧凑时间戳>-<会话 id>。 */
function entryStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
}

// ---------------------------------------------------------------------------
// 插件本体
// ---------------------------------------------------------------------------

export function apply(ctx) {
  /** 缓存的 DSH home（trash 根的父目录）。 */
  let cachedHome = null

  /**
   * 兼容两代 persistence.list() 的返回形状：
   *   - 旧版（≤0.1.1-rc.x）：直接返回 header 数组；
   *   - 0.1.5+：返回 { header, revision, sizeBytes } 快照数组。
   * 统一解包成 header 数组。不解包的话 wrapper 会被当 header 用：
   * h.id / h.cwd 全为 undefined，locate(wrapper) 深入到
   * encodeSegment(undefined) 后抛 "reading 'length'"（v0.4.0 在
   * DSH 0.1.5-alpha 上 /list、/trash 全挂的根因）。
   * header 自身 schema 无 header 字段，`in` 判别不会误伤。
   */
  async function listHeaders() {
    const result = await ctx.sessionPersistence.list()
    if (!Array.isArray(result)) return []
    return result.map((item) => (item !== null && typeof item === 'object' && 'header' in item ? item.header : item))
  }

  /**
   * DSH home 推导：优先从任一现存会话的 locate() 路径反推
   * （<home>/sessions/<projectKey>/<session-id>/session.jsonl.zstd），
   * 无会话时退回 DSH_HOME / ~/.dsh。
   */
  async function dshHome() {
    if (cachedHome) return cachedHome
    const headers = await listHeaders()
    for (const header of headers) {
      const location = ctx.sessionPersistence.locate(header)
      if (location && typeof location.path === 'string') {
        const sessionsRoot = resolve(dirname(location.path), '../..')
        cachedHome = resolve(sessionsRoot, '..')
        return cachedHome
      }
    }
    cachedHome = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
    return cachedHome
  }

  async function trashRoot() {
    return join(await dshHome(), 'trash', 'sessions')
  }

  async function audit(action, fields) {
    const line = JSON.stringify({ at: new Date().toISOString(), action, ...fields })
    try {
      const root = await trashRoot()
      await mkdir(root, { recursive: true })
      await appendFile(join(root, AUDIT_LOG), line + '\n')
    } catch {
      /* 审计失败不阻断主流程 */
    }
  }

  /** 磁盘会话清单：id → header。 */
  async function inventory() {
    const headers = await listHeaders()
    const byId = new Map(headers.map((h) => [h.id, h]))
    return { headers, byId }
  }

  function agentState(id) {
    const agent = ctx.agents.get(id)
    if (agent === undefined) return { live: false, running: false }
    const status = agent.status
    return { live: true, running: status !== 'idle' }
  }

  function archivedSet() {
    try {
      return new Set(ctx.workspaceRegistry.archivedSessionIds ?? [])
    } catch {
      return new Set()
    }
  }

  /**
   * 在线取消归档（archiveSession 的对称反操作）。
   *
   * registry 没有公开的 unarchive API，但其内部状态机与归档同源：
   * enqueueOperation（串行队列）→ requireState → setState（写 global 存储）。
   * setState 落盘触发 domain/changed(workspace)，apiproxy 检测到
   * archivedSessionIds 变化后向所有客户端广播 host/archived-sessions-changed，
   * 侧栏原分组即时恢复显示——无需自建任何通知管道。
   *
   * 这些是内部方法而非公开契约：能力探测失败（未来版本改名/收窄）时抛
   * 501 UNSUPPORTED，由客户端回退到「停止 DSH 后运行 tools/unhide.mjs」。
   */
  function registryCanUnarchive() {
    const registry = ctx.workspaceRegistry
    return (
      typeof registry?.enqueueOperation === 'function' &&
      typeof registry?.requireState === 'function' &&
      typeof registry?.setState === 'function'
    )
  }

  async function unarchiveSession(id) {
    if (!registryCanUnarchive()) {
      throw httpError(501, 'UNSUPPORTED', '当前 DSH 的 workspaceRegistry 不支持在线取消归档；请停止 DSH 后运行 tools/unhide.mjs')
    }
    const registry = ctx.workspaceRegistry
    // 走 registry 自己的串行队列，与并发的归档/工作区写操作互斥
    return registry.enqueueOperation(async () => {
      const state = registry.requireState()
      if (!Array.isArray(state.archivedSessionIds) || !state.archivedSessionIds.includes(id)) return false
      await registry.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter((x) => x !== id),
      })
      return true
    })
  }

  /**
   * 删除/清空后的归档 ghost 清理（best-effort）。
   *
   * delete 会先 archiveSession 再移盘：id 因此留在 workspace.json 的
   * global.archivedSessionIds 里。磁盘会话已不存在时，官方归档计数仍会虚高。
   * 这里在文件操作成功后批量摘掉这些 id；旧版无内部状态机时静默跳过，
   * 清理失败也不回滚已完成的删除/清空。
   */
  async function forgetArchivedSessions(ids) {
    const wanted = [...new Set((ids ?? []).filter((id) => typeof id === 'string' && id))]
    if (wanted.length === 0 || !registryCanUnarchive()) return 0
    const registry = ctx.workspaceRegistry
    const drop = new Set(wanted)
    try {
      return await registry.enqueueOperation(async () => {
        const state = registry.requireState()
        if (!Array.isArray(state.archivedSessionIds) || state.archivedSessionIds.length === 0) return 0
        const next = state.archivedSessionIds.filter((id) => !drop.has(id))
        const removed = state.archivedSessionIds.length - next.length
        if (removed === 0) return 0
        await registry.setState({
          ...state,
          archivedSessionIds: next,
        })
        return removed
      })
    } catch {
      return 0
    }
  }

  /**
   * 清掉「归档集里有、磁盘清单里没有」的历史 ghost。
   * 只在宿主重启（插件重新挂载）时调用：此刻所有客户端都会用全新基线重建
   * list store，已删会话的行不复存在，摘除归档 id 不会复活任何东西。
   * 运行期间绝不调用——长连客户端的 store 可能还持有已删会话的残留行，
   * 摘除归档会把它们显示回侧栏。
   * live 会话除外（boot 时配置启动的 agent 已 resume，但它们都在盘上，
   * 不会命中 ghost 条件；保留检查作纵深防御）。
   */
  async function reconcileArchivedGhosts() {
    if (!registryCanUnarchive()) return 0
    const archived = [...archivedSet()]
    if (archived.length === 0) return 0
    const { byId } = await inventory()
    const ghosts = archived.filter((id) => !byId.has(id) && !agentState(id).live)
    if (ghosts.length === 0) return 0
    const forgotten = await forgetArchivedSessions(ghosts)
    if (forgotten > 0) await audit('reconcile-archived-ghosts', { count: forgotten, ids: ghosts.slice(0, 20) })
    return forgotten
  }

  /** 标题批量折叠（sessionQuery 可选；失败逐项回退）。 */
  async function titlesFor(ids) {
    const query = ctx.get('sessionQuery')
    if (query === undefined || ids.length === 0) return new Map()
    try {
      const results = await query.readTitleSnapshots(ids)
      const map = new Map()
      for (const r of results) {
        if (r?.status !== 'fulfilled' || r.value?.title === undefined) continue
        // readTitleSnapshots 的 title 是 SessionTitleSnapshot 对象（含 messageSeqs/
        // source/eventSeq/updatedAt），不是字符串——必须解包出 .title 文本，
        // 否则对象流到客户端会被当 React 子节点渲染（Minified error #31）。
        const snap = r.value.title
        const text = typeof snap === 'string' ? snap : typeof snap?.title === 'string' ? snap.title : null
        if (text !== null) map.set(r.value.session.id, text)
      }
      return map
    } catch {
      return new Map()
    }
  }

  /**
   * 零 I/O 标题：sessionProjectionCache 的 title 投影行——与侧栏 session.list
   * 同源（打开页面即预热），冷会话首次加载不再逐个 zstd 解压整个日志
   * （readTitleSnapshots 的 readColdSessionLog 路径；几百个会话时秒级）。
   * 缓存行可能略旧但绝不会串会话（identity 以 createdAt/cwd/inheritedEventCount
   * 见证，不匹配即拒）；seeded 会话按官方 apiproxy 同款规则走 predecessor 探测。
   * miss / 服务缺失 / 旧版 API 不符时返回 undefined，由调用方回退解压路径。
   * 仅用于冷会话：live 会话的标题在内存里本就新鲜且免费（readTitleSnapshots
   * 对 live 走 sourceLive，无解压），避免吃到落后的检查点。
   */
  function cachedTitleFor(header) {
    const cache = ctx.get('sessionProjectionCache')
    if (cache === undefined || typeof cache?.cachedSnapshot !== 'function') return undefined
    try {
      const block = header.isSeeded
        ? undefined
        : cache.cachedSnapshot(header, 0, ['title']) ??
          (typeof cache.cachedPredecessorTitle === 'function' ? cache.cachedPredecessorTitle(header, 0) : undefined)
      const title = block?.values?.title
      return typeof title === 'string' ? title : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 记录缓存：id → { key, title, sizeBytes, mtimeMs }。
   * key = 日志文件 `mtime:size`——标题折叠需要 zstd 解压整个日志（44 个会话
   * 约 0.7s），但内容只有追加一种变化方式，文件 mtime+size 不变即可复用。
   * live 会话不缓存（内存态可能领先于磁盘）。
   */
  const recordCache = new Map()

  /**
   * 阶段 1：逐会话预检（并行，纯 stat 无解压）。
   * locate → stat 日志文件 → mtime 缓存命中判定。返回 prep 数组供后续阶段
   * 与 buildRecord 复用（不重复 stat）。
   */
  async function prepRecords(ids, byId) {
    return (
      await Promise.all(
        ids.map(async (id) => {
          const header = byId.get(id)
          if (header === undefined) return null
          const location = ctx.sessionPersistence.locate(header)
          const dir = location && typeof location.path === 'string' ? dirname(location.path) : null
          let key = null
          if (location && typeof location.path === 'string') {
            try {
              const st = await stat(location.path)
              key = `${st.mtimeMs}:${st.size}`
            } catch {
              key = null
            }
          }
          const agent = agentState(id)
          const cached = recordCache.get(id)
          // live 会话不缓存（内存态可能领先于磁盘）；日志 mtime+size 不变即可复用
          const hit = !agent.live && key !== null && cached !== undefined && cached.key === key
          return { id, header, dir, key, agent, cached, hit }
        }),
      )
    ).filter((p) => p !== null)
  }

  /**
   * 阶段 2：标题批量解析（仅对阶段 1 的缓存未命中者）。
   *
   * 关键性能约束：readTitleSnapshots 每次调用内部都会重扫整个持久化清单
   * （listPersisted），逐会话单调用是准平方级——520 个会话实测 60s 都跑不完
   * （v0.5.0 的教训）。miss 必须合并成一次批量调用，其内部自带
   * persistedReadConcurrency 并发池解压。投影缓存命中（侧栏 session.list
   * 同源，打开页面即预热）则完全绕开解压路径；recordCache 命中者标题随
   * 缓存行返回，无需解析。live 会话不经投影缓存（内存标题更新鲜），归入
   * miss 批——批量调用对 live 走 sourceLive 内存快照，无解压成本。
   *
   * @returns {Map<string, string|null>} id → 标题文本（无标题为 null）
   */
  async function resolveTitles(preps) {
    const titles = new Map()
    const misses = []
    for (const p of preps) {
      if (p.hit) continue
      const cached = p.agent.live ? undefined : cachedTitleFor(p.header)
      if (typeof cached === 'string') titles.set(p.id, cached)
      else misses.push(p)
    }
    if (misses.length > 0) {
      const folded = await titlesFor(misses.map((p) => p.id))
      for (const p of misses) {
        const text = folded.get(p.id)
        titles.set(p.id, typeof text === 'string' ? text : null)
      }
    }
    return titles
  }

  /**
   * 阶段 3：单个会话记录产出（list/preview/list-stream 共用）。
   * prep（阶段 1）+ titles（阶段 2）已就绪，这里只补体积/mtime 并组装。
   */
  async function buildRecord(p, archived, titles) {
    let title
    let sizeBytes
    let mtimeMs
    if (p.hit) {
      title = p.cached.title
      sizeBytes = p.cached.sizeBytes
      mtimeMs = p.cached.mtimeMs
    } else {
      const text = titles.get(p.id)
      title = typeof text === 'string' ? text : null
      sizeBytes = p.dir ? await dirSize(p.dir) : 0
      mtimeMs = p.dir ? await dirMtime(p.dir) : 0
      if (p.key !== null) recordCache.set(p.id, { key: p.key, title, sizeBytes, mtimeMs })
      else recordCache.delete(p.id)
    }
    return {
      id: p.id,
      cwd: p.header.cwd ?? null,
      createdAt: p.header.createdAt ?? null,
      origin: p.header.origin ?? null,
      delegationDepth: p.header.delegationDepth ?? 0,
      title,
      archived: archived.has(p.id),
      live: p.agent.live,
      running: p.agent.running,
      sizeBytes,
      mtimeMs,
    }
  }

  /**
   * 并发池：limit 个 worker 抢占 prep 队列，每个记录算完立即回调 onRecord。
   * 流式路由据此逐个推送；sessionRecords 据此收集后统一排序。
   */
  async function eachRecord(preps, archived, titles, limit, onRecord) {
    let index = 0
    const worker = async () => {
      while (index < preps.length) {
        const prep = preps[index++]
        await onRecord(await buildRecord(prep, archived, titles))
      }
    }
    const width = Math.max(1, Math.min(limit, preps.length))
    await Promise.all(Array.from({ length: width }, () => worker()))
  }

  /** 会话记录（list/preview 共用）：磁盘 + 归档 + agent 状态 + 占用，mtime 降序。 */
  async function sessionRecords(ids) {
    const { byId } = await inventory()
    const archived = archivedSet()
    const target = (ids ?? [...byId.keys()]).filter((id) => byId.has(id))
    const preps = await prepRecords(target, byId)
    const titles = await resolveTitles(preps)
    const records = []
    await eachRecord(preps, archived, titles, 16, (record) => {
      records.push(record)
    })
    records.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return records
  }

  // -------------------------------------------------------------------------
  // 删除 / 还原 / 清空
  // -------------------------------------------------------------------------

  async function deleteSession(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw httpError(400, 'INVALID_ID', '会话 id 非法')
    const { byId } = await inventory()
    const header = byId.get(id)
    if (header === undefined) throw httpError(404, 'NOT_FOUND', `会话 ${id} 不存在于磁盘记录（可能已删除）`)

    const agent = agentState(id)
    if (agent.running) throw httpError(409, 'RUNNING', '会话正在运行（模型或子代理未结束），请稍后再试')

    // 归档必须在文件移动之前：官方 sessionKnown 检查 live 或仍在持久化清单。
    // 已归档是幂等 no-op；此时会话一定 known（上面刚在清单里找到）。
    try {
      await ctx.workspaceRegistry.archiveSession(id)
    } catch (error) {
      throw httpError(500, 'ARCHIVE_FAILED', `归档失败：${error?.message ?? error}`)
    }

    const location = ctx.sessionPersistence.locate(header)
    if (!location || typeof location.path !== 'string') {
      throw httpError(500, 'UNSUPPORTED', '当前持久化后端无法定位会话目录')
    }
    const dir = dirname(location.path)
    if ((await stat(dir).catch(() => undefined)) === undefined) {
      // 目录已不存在（例如此前删了一半）：归档已完成，直接视为成功。
      const keptHidden = archivedSet().has(id)
      await audit('delete', { id, note: 'dir-missing', keptHidden })
      return { id, ok: true, note: 'dir-missing', keptHidden }
    }
    const sizeBytes = await dirSize(dir)
    // 标题随会话进回收站：缓存优先（清理面板刚读过清单），缺失时单独折叠一次。
    // 回收站据此显示会话名而非一串 session-id；旧条目无 title 时客户端回退显示 id。
    let title = null
    const cachedRec = recordCache.get(id)
    if (typeof cachedRec?.title === 'string') title = cachedRec.title
    else {
      const titles = await titlesFor([id])
      if (typeof titles.get(id) === 'string') title = titles.get(id)
    }

    const root = await trashRoot()
    const entry = `${entryStamp()}-${id}`
    const entryDir = join(root, entry)
    const dataDir = join(entryDir, 'data')
    await mkdir(entryDir, { recursive: true })
    try {
      await rename(dir, dataDir)
    } catch (error) {
      await rm(entryDir, { recursive: true, force: true }).catch(() => {})
      throw httpError(500, 'MOVE_FAILED', `移入回收站失败：${error?.message ?? error}`)
    }
    await writeFile(
      join(entryDir, 'meta.json'),
      JSON.stringify(
        {
          id,
          title,
          cwd: header.cwd ?? null,
          trashedAt: new Date().toISOString(),
          sizeBytes,
          plugin: 'dsh-session-delete',
          version: 1,
        },
        null,
        2,
      ),
    )
    // 文件已离盘。归档 id 保留不摘（见文件头删除流水线第 5 步）：摘除会广播
    // archived-sessions-changed，把已连接客户端 list store 里的残留行（冷会话）
    // 或宿主内存里的活会话（live）重新显示回侧栏。ghost 待宿主重启时由
    // reconcileArchivedGhosts 统一清理。
    const keptHidden = archivedSet().has(id)
    await audit('delete', { id, entry, keptHidden })
    recordCache.delete(id)
    return { id, ok: true, entry, keptHidden }
  }

  async function listTrash() {
    const root = await trashRoot()
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      return []
    }
    const items = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !ENTRY_RE.test(entry.name)) continue
      const entryDir = join(root, entry.name)
      let meta
      try {
        meta = JSON.parse(await readFile(join(entryDir, 'meta.json'), 'utf8'))
      } catch {
        meta = null
      }
      items.push({
        entry: entry.name,
        id: typeof meta?.id === 'string' ? meta.id : entry.name.replace(/^\d+-/, ''),
        title: typeof meta?.title === 'string' && meta.title ? meta.title : null,
        cwd: typeof meta?.cwd === 'string' ? meta.cwd : null,
        trashedAt: typeof meta?.trashedAt === 'string' ? meta.trashedAt : null,
        sizeBytes: await dirSize(join(entryDir, 'data')),
      })
    }
    items.sort((a, b) => String(b.trashedAt ?? '').localeCompare(String(a.trashedAt ?? '')))
    return items
  }

  /**
   * 校验并解析回收站条目路径（restore/purge 共用的唯一入口）。
   * 除 ENTRY_RE 外还显式拒绝 `.`/`..`（该正则允许它们，join 后会逃出回收站）
   * 和保留名 audit.log，并要求目标真实存在且是目录——防止把审计日志当条目删除。
   */
  async function resolveTrashEntryDir(entry) {
    if (
      typeof entry !== 'string' ||
      !ENTRY_RE.test(entry) ||
      entry === '.' ||
      entry === '..' ||
      entry === AUDIT_LOG
    ) {
      throw httpError(400, 'INVALID_ENTRY', '回收站条目名非法')
    }
    const dir = join(await trashRoot(), entry)
    const st = await stat(dir).catch(() => undefined)
    if (st === undefined) throw httpError(404, 'NOT_FOUND', '回收站条目不存在')
    if (!st.isDirectory()) throw httpError(400, 'NOT_ENTRY', '回收站条目必须是目录')
    return dir
  }

  async function restoreSession(entry) {
    const entryDir = await resolveTrashEntryDir(entry)
    const dataDir = join(entryDir, 'data')
    if ((await stat(dataDir).catch(() => undefined)) === undefined) {
      throw httpError(404, 'NOT_FOUND', '回收站条目不存在')
    }
    let meta
    try {
      meta = JSON.parse(await readFile(join(entryDir, 'meta.json'), 'utf8'))
    } catch {
      throw httpError(500, 'NO_META', '回收站条目缺少 meta.json，无法还原')
    }
    // meta.json 是磁盘文件，可能被篡改；id 过白名单后再交给 locate（纵深防御）
    if (typeof meta?.id !== 'string' || !ID_RE.test(meta.id)) {
      throw httpError(500, 'BAD_META', '回收站条目 meta.json 中的会话 id 非法')
    }
    const location = ctx.sessionPersistence.locate({ id: meta.id, cwd: typeof meta.cwd === 'string' ? meta.cwd : undefined })
    if (!location || typeof location.path !== 'string') {
      throw httpError(500, 'UNSUPPORTED', '当前持久化后端无法定位还原目标')
    }
    const targetDir = dirname(location.path)
    if ((await stat(targetDir).catch(() => undefined)) !== undefined) {
      throw httpError(409, 'EXISTS', '目标位置已存在同名会话目录，未还原')
    }
    await mkdir(dirname(targetDir), { recursive: true })
    await rename(dataDir, targetDir)
    await rm(entryDir, { recursive: true, force: true }).catch(() => {})
    // 文件已归位，紧接着在线解除归档：会话直接回到侧栏原分组，一步到位。
    // 旧版 DSH（无内部状态机）保持旧行为：文件还原、归档态保留，由客户端
    // 提示离线 unhide 步骤——文件操作永远不因解档失败而回滚。
    let stillArchived = archivedSet().has(meta.id)
    if (stillArchived) {
      try {
        await unarchiveSession(meta.id)
      } catch {
        /* UNSUPPORTED（旧版）或内部失败：归档态保留，走提示路径 */
      }
      stillArchived = archivedSet().has(meta.id)
    }
    await audit('restore', { id: meta.id, entry, unarchived: !stillArchived })
    recordCache.delete(meta.id)
    return { id: meta.id, ok: true, stillArchived }
  }

  async function purge(entry, all) {
    const root = await trashRoot()
    if (all) {
      const items = await listTrash()
      for (const item of items) await rm(join(root, item.entry), { recursive: true, force: true })
      // 归档 id 保留不摘（同 delete，见文件头第 5 步）：运行期间摘除会复活
      // 客户端残留行 / 宿主活会话；ghost 由宿主重启时的 reconcile 统一清理。
      await audit('purge-all', { count: items.length })
      return { ok: true, count: items.length }
    }
    const entryDir = await resolveTrashEntryDir(entry)
    let metaId = null
    try {
      const meta = JSON.parse(await readFile(join(entryDir, 'meta.json'), 'utf8'))
      if (typeof meta?.id === 'string' && ID_RE.test(meta.id)) metaId = meta.id
    } catch {
      /* meta 缺失/损坏时仍允许清空目录 */
    }
    await rm(entryDir, { recursive: true, force: true })
    // 归档 id 保留不摘（同 delete / purge-all）
    await audit('purge', { entry, id: metaId })
    return { ok: true, count: 1 }
  }

  // -------------------------------------------------------------------------
  // HTTP 路由
  // -------------------------------------------------------------------------

  function sendJson(res, status, body) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }

  async function readBody(req) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8')
    if (!text.trim()) return {}
    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw httpError(400, 'INVALID_BODY', '请求体不是合法 JSON')
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw httpError(400, 'INVALID_BODY', '请求体必须是 JSON 对象')
    }
    return data
  }

  function guard(handler) {
    return async (req, res) => {
      try {
        if (req.method !== 'GET' && req.headers[PLUGIN_HEADER] !== 'session-delete') {
          throw httpError(403, 'FORBIDDEN', `缺少 ${PLUGIN_HEADER} 头`)
        }
        await handler(req, res)
      } catch (error) {
        sendJson(res, error?.statusCode ?? 500, {
          error: { code: error?.code ?? 'INTERNAL', message: String(error?.message ?? error) },
        })
      }
    }
  }

  /** workspaceRegistry.list() 的稳定投影（/list 与 /list-stream 共用；失败退空）。 */
  async function workspacesView() {
    return Promise.resolve()
      .then(() => ctx.workspaceRegistry.list())
      .then((list) =>
        (list ?? []).map((w) => ({
          workspaceId: String(w.id ?? w.workspaceId ?? ''),
          title: String(w.title ?? ''),
          path: String(w.path ?? ''),
        })),
      )
      .catch(() => [])
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/list`,
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: { code: 'METHOD', message: 'GET only' } })
        // 运行期间不做 ghost reconcile（见 reconcileArchivedGhosts 注释）。
        const [sessions, workspaces] = await Promise.all([sessionRecords(), workspacesView()])
        sendJson(res, 200, {
          ok: true,
          sessions,
          workspaces,
          archivedCount: sessions.filter((s) => s.archived).length,
          unarchiveSupported: registryCanUnarchive(),
        })
      }),
    }),
  )

  /**
   * 流式全量清单（NDJSON，逐行 JSON 对象 + '\n'）：
   *   { type: 'meta', total, workspaces, unarchiveSupported }   首行，总数即时可知
   *   { type: 'session', session }                              每算完一个会话推一行
   *   { type: 'error', message }                                中途失败（此后仍发 done 收尾）
   *   { type: 'done' }                                          结束标记
   * 与一次性 /list 内容同源（buildRecord）；排序交给客户端（mtimeMs 降序），
   * 服务端流式期间无序产出。会话多时（标题折叠要 zstd 解压整个日志）一次性
   * /list 首次可达数秒，本路由让客户端从第一行起就显示「已加载 N / M」。
   * GET 免自定义头（与其它 GET 一致）；行很小（~200B），无需背压处理。
   */
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/list-stream`,
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: { code: 'METHOD', message: 'GET only' } })
        const { byId } = await inventory()
        const archived = archivedSet()
        const ids = [...byId.keys()]
        res.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-store',
        })
        const write = (obj) => {
          if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`)
        }
        // meta 先行：total 来自 inventory（磁盘清单，快），进度分母即时可知
        write({ type: 'meta', total: ids.length, workspaces: await workspacesView(), unarchiveSupported: registryCanUnarchive() })
        // 阶段 1/2：stat 预检 + 标题批量解析（投影缓存命中为主，miss 合批一次
        // 解压——见 resolveTitles 注释）。此阶段行尚未流出；缓存全热时毫秒级，
        // 冷缓存全程解压时进度停在 0/N（一次性代价，侧栏预热后不再出现）。
        let preps = []
        let titles = new Map()
        try {
          preps = await prepRecords(ids, byId)
          titles = await resolveTitles(preps)
        } catch (error) {
          write({ type: 'error', message: String(error?.message ?? error) })
        }
        // 阶段 3：行快速流出（recordCache 命中者纯组装，miss 者补 dirSize）
        try {
          await eachRecord(preps, archived, titles, 16, (record) => write({ type: 'session', session: record }))
        } catch (error) {
          write({ type: 'error', message: String(error?.message ?? error) })
        }
        write({ type: 'done' })
        res.end()
      }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/preview`,
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: { code: 'METHOD', message: 'GET only' } })
        const id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('id') ?? ''
        if (!ID_RE.test(id)) return sendJson(res, 400, { error: { code: 'INVALID_ID', message: '会话 id 非法' } })
        const [record] = await sessionRecords([id])
        if (record === undefined) {
          return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `会话 ${id} 不存在于磁盘记录` } })
        }
        sendJson(res, 200, { ok: true, session: record })
      }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/delete`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: { code: 'METHOD', message: 'POST only' } })
        const body = await readBody(req)
        const result = await deleteSession(body.id)
        sendJson(res, 200, { ok: true, ...result })
      }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/trash`,
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: { code: 'METHOD', message: 'GET only' } })
        sendJson(res, 200, { ok: true, items: await listTrash() })
      }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/restore`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: { code: 'METHOD', message: 'POST only' } })
        const body = await readBody(req)
        const result = await restoreSession(body.entry)
        sendJson(res, 200, { ok: true, ...result })
      }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/unarchive`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: { code: 'METHOD', message: 'POST only' } })
        const body = await readBody(req)
        if (typeof body.id !== 'string' || !ID_RE.test(body.id)) {
          throw httpError(400, 'INVALID_ID', '会话 id 非法')
        }
        const changed = await unarchiveSession(body.id)
        if (changed) await audit('unarchive', { id: body.id })
        sendJson(res, 200, { ok: true, id: body.id, changed })
      }),
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/purge`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: { code: 'METHOD', message: 'POST only' } })
        const body = await readBody(req)
        const result = await purge(body.entry, body.all === true)
        sendJson(res, 200, { ok: true, ...result })
      }),
    }),
  )

  // 宿主重启时 reconcile 一次历史归档 ghost（fire-and-forget）。
  // 此刻所有客户端都将以全新基线重建 list store，已删会话的行不复存在，
  // 摘除归档 id 是安全的；运行期间则绝不摘除（详见 reconcileArchivedGhosts）。
  // inject 保证 workspaceRegistry/sessionPersistence 在 apply 前完成 init，
  // requireState 此处不会抛 "not started yet"。
  reconcileArchivedGhosts().catch(() => {})
}
