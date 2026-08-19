/**
 * dsh-session-delete — Host half.
 *
 * 本机 HTTP 路由（loopback，Cache-Control: no-store；非 GET 要求自定义头
 * `x-dsh-plugin: session-delete` 作最低限度 CSRF 防线——自定义头跨域必触发
 * 预检，而本服务不答 CORS 预检）：
 *   GET  /api/session-delete/list           全量会话清单（清理面板数据源）
 *   GET  /api/session-delete/preview?id=    单会话删除预览
 *   POST /api/session-delete/delete         { id } 归档 + 移入回收站
 *   GET  /api/session-delete/trash          回收站清单
 *   POST /api/session-delete/restore        { entry } 原位还原
 *   POST /api/session-delete/purge          { entry? , all? } 彻底删除
 *
 * 删除流水线（顺序不可换）：
 *   1. 运行保护：agents.get(id) 存在且 status !== 'idle' → 拒绝
 *   2. workspaceRegistry.archiveSession(id) —— 必须在文件移动之前调用：
 *      官方实现要求会话「live 或仍在持久化清单中」，归档后宿主会向客户端
 *      广播 host/archived-sessions-changed，侧栏即时隐藏；
 *   3. sessionPersistence.locate(header) 定位真实磁盘目录（不硬编码路径）；
 *   4. rename 移入 <DSH_HOME>/trash/sessions/<时间戳>-<id>/data/（回收站）。
 *
 * 审计：<DSH_HOME>/trash/sessions/audit.log（JSONL 追加）。
 *
 * 已知边界（有意为之，见 README）：
 *   - 归档集没有官方 unarchive API；restore 只还原磁盘文件，会话默认仍对
 *     侧栏隐藏。彻底找回需在 DSH 停止时运行 tools/unhide.mjs。
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
/** 会话 id 白名单：session-<uuid> 形态，宽进严出（仍要求存在于磁盘清单）。 */
const ID_RE = /^session-[A-Za-z0-9-]{8,80}$/
/** 回收站条目名白名单（时间戳-id，无路径分隔符）。 */
const ENTRY_RE = /^[A-Za-z0-9._-]{1,120}$/

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
   * DSH home 推导：优先从任一现存会话的 locate() 路径反推
   * （<home>/sessions/<projectKey>/<session-id>/session.jsonl.zstd），
   * 无会话时退回 DSH_HOME / ~/.dsh。
   */
  async function dshHome() {
    if (cachedHome) return cachedHome
    const headers = await ctx.sessionPersistence.list()
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
      await appendFile(join(root, 'audit.log'), line + '\n')
    } catch {
      /* 审计失败不阻断主流程 */
    }
  }

  /** 磁盘会话清单：id → header。 */
  async function inventory() {
    const headers = await ctx.sessionPersistence.list()
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
   * 记录缓存：id → { key, title, sizeBytes, mtimeMs }。
   * key = 日志文件 `mtime:size`——标题折叠需要 zstd 解压整个日志（44 个会话
   * 约 0.7s），但内容只有追加一种变化方式，文件 mtime+size 不变即可复用。
   * live 会话不缓存（内存态可能领先于磁盘）。
   */
  const recordCache = new Map()

  /** 会话记录（list/preview 共用）：磁盘 + 归档 + agent 状态 + 占用。 */
  async function sessionRecords(ids) {
    const { byId } = await inventory()
    const archived = archivedSet()
    const target = ids ?? [...byId.keys()]

    // 第一遍（并行）：定位 + stat 日志文件，判定缓存命中
    const prep = (
      await Promise.all(
        target.map(async (id) => {
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
          const hit = !agent.live && key !== null && cached !== undefined && cached.key === key
          return { id, header, dir, key, agent, cached, hit }
        }),
      )
    ).filter((p) => p !== null)

    // 只对未命中的会话做标题折叠（这是主要成本）；live 会话永远新鲜读取
    const titles = await titlesFor(prep.filter((p) => !p.hit).map((p) => p.id))

    const records = []
    for (const p of prep) {
      let title
      let sizeBytes
      let mtimeMs
      if (p.hit) {
        title = p.cached.title
        sizeBytes = p.cached.sizeBytes
        mtimeMs = p.cached.mtimeMs
      } else {
        title = typeof titles.get(p.id) === 'string' ? titles.get(p.id) : null
        sizeBytes = p.dir ? await dirSize(p.dir) : 0
        mtimeMs = p.dir ? await dirMtime(p.dir) : 0
        if (p.key !== null) recordCache.set(p.id, { key: p.key, title, sizeBytes, mtimeMs })
        else recordCache.delete(p.id)
      }
      records.push({
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
      })
    }
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
      await audit('delete', { id, note: 'dir-missing' })
      return { id, ok: true, note: 'dir-missing' }
    }
    const sizeBytes = await dirSize(dir)

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
    await audit('delete', { id, entry })
    recordCache.delete(id)
    return { id, ok: true, entry }
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
        cwd: typeof meta?.cwd === 'string' ? meta.cwd : null,
        trashedAt: typeof meta?.trashedAt === 'string' ? meta.trashedAt : null,
        sizeBytes: await dirSize(join(entryDir, 'data')),
      })
    }
    items.sort((a, b) => String(b.trashedAt ?? '').localeCompare(String(a.trashedAt ?? '')))
    return items
  }

  async function restoreSession(entry) {
    if (typeof entry !== 'string' || !ENTRY_RE.test(entry)) throw httpError(400, 'INVALID_ENTRY', '回收站条目名非法')
    const root = await trashRoot()
    const entryDir = join(root, entry)
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
    const location = ctx.sessionPersistence.locate({ id: meta.id, cwd: meta.cwd ?? undefined })
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
    const stillArchived = archivedSet().has(meta.id)
    await audit('restore', { id: meta.id, entry })
    recordCache.delete(meta.id)
    return { id: meta.id, ok: true, stillArchived }
  }

  async function purge(entry, all) {
    const root = await trashRoot()
    if (all) {
      const items = await listTrash()
      for (const item of items) await rm(join(root, item.entry), { recursive: true, force: true })
      await audit('purge-all', { count: items.length })
      return { ok: true, count: items.length }
    }
    if (typeof entry !== 'string' || !ENTRY_RE.test(entry)) throw httpError(400, 'INVALID_ENTRY', '回收站条目名非法')
    const entryDir = join(root, entry)
    if ((await stat(entryDir).catch(() => undefined)) === undefined) {
      throw httpError(404, 'NOT_FOUND', '回收站条目不存在')
    }
    await rm(entryDir, { recursive: true, force: true })
    await audit('purge', { entry })
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
    const data = JSON.parse(text)
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

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/list`,
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: { code: 'METHOD', message: 'GET only' } })
        const [sessions, workspaces] = await Promise.all([
          sessionRecords(),
          Promise.resolve()
            .then(() => ctx.workspaceRegistry.list())
            .then((list) =>
              (list ?? []).map((w) => ({
                workspaceId: String(w.id ?? w.workspaceId ?? ''),
                title: String(w.title ?? ''),
                path: String(w.path ?? ''),
              })),
            )
            .catch(() => []),
        ])
        sendJson(res, 200, { ok: true, sessions, workspaces, archivedCount: sessions.filter((s) => s.archived).length })
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
      path: `${PREFIX}/purge`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: { code: 'METHOD', message: 'POST only' } })
        const body = await readBody(req)
        const result = await purge(body.entry, body.all === true)
        sendJson(res, 200, { ok: true, ...result })
      }),
    }),
  )
}
