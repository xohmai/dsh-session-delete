/**
 * dsh-session-delete 宿主半冒烟测试。
 *
 * 用桩 ctx 直接驱动 apply() 注册的 HTTP 路由，在临时目录里模拟真实存储布局：
 *   <home>/sessions/<slug>/session-<id>/session.jsonl.zstd
 * 验证：list / preview / delete（含运行保护、归档时序、live 会话保持隐藏）/
 * trash / restore / purge / CSRF。
 *
 * 运行：node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.js'

const home = await mkdtemp(join(tmpdir(), 'dsh-sd-'))
const sessionsRoot = join(home, 'sessions')
const cwdA = '/tmp/project-a'
const cwdB = '/tmp/project-b'

// ---- 真实 locate 布局的桩：sessions/<slug>/session-<id>/session.jsonl.zstd ----
const headers = []
const archived = new Set()
const archiveCalls = []
const running = new Map() // id -> true 表示运行中
const liveIdle = new Set() // id -> attach 在内存里但空闲（「打开中」）

function slug(cwd) {
  return `--${cwd.replace(/\//g, '-').slice(1)}--`
}
function locate(header) {
  return { kind: 'jsonl', path: join(sessionsRoot, slug(header.cwd), header.id, 'session.jsonl.zstd') }
}

async function createSession(id, cwd, bytes = 128) {
  const header = { type: 'session', version: 1, id, createdAt: Date.now() - 86400000, delegationDepth: 0, cwd }
  headers.push(header)
  const dir = join(sessionsRoot, slug(cwd), id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.jsonl.zstd'), 'x'.repeat(bytes))
  return header
}

const routes = new Map()
const ctx = {
  sessionPersistence: {
    list: async () => headers.slice(),
    locate,
  },
  workspaceRegistry: {
    archiveSession: async (id) => {
      archiveCalls.push(id)
      archived.add(id)
    },
    get archivedSessionIds() {
      return [...archived]
    },
    list: () => [{ id: 'w1', title: 'project-a', path: cwdA }],
    // 与真实 WorkspaceRegistry 同构的内部状态机（在线取消归档所依赖）：
    // enqueueOperation 串行、requireState 读快照、setState 整体替换并落盘
    enqueueOperation: (op) => op(),
    requireState: () => ({ initialized: true, workspaceIds: ['w1'], archivedSessionIds: [...archived] }),
    setState: async (state) => {
      archived.clear()
      for (const id of state.archivedSessionIds ?? []) archived.add(id)
    },
  },
  agents: {
    get: (id) => (running.get(id) ? { status: 'running' } : liveIdle.has(id) ? { status: 'idle' } : undefined),
  },
  // 模拟真实 sessionQuery：readTitleSnapshots 返回的 title 是 SessionTitleSnapshot
  // 对象（含 title/messageSeqs/source/eventSeq/updatedAt），不是字符串。
  sessionQuery: {
    readTitleSnapshots: async (ids) =>
      ids.map((id) => ({
        status: 'fulfilled',
        value: { session: { id }, title: { title: `会话 ${id.slice(8, 12)}`, messageSeqs: [], source: 'user', eventSeq: 1, updatedAt: 1 } },
      })),
  },
  webServer: {
    register: (route) => routes.set(route.path, route.handler),
  },
  effect(fn) {
    fn()
    return () => {}
  },
  get: (name) => (name === 'sessionQuery' ? ctx.sessionQuery : undefined),
}

apply(ctx)

// ---- 微型 req/res ----
function res() {
  const r = { status: 0, body: null, headersWritten: null }
  r.writeHead = (status, headers) => {
    r.status = status
    r.headersWritten = headers
  }
  r.end = (body) => {
    r.body = body ? JSON.parse(body) : null
  }
  return r
}
const bodyReq = (method, url, obj, withHeader = true) => ({
  method,
  url,
  headers: withHeader ? { 'x-dsh-plugin': 'session-delete' } : {},
  async *[Symbol.asyncIterator]() {
    if (obj) yield Buffer.from(JSON.stringify(obj))
  },
})
const get = (url) => bodyReq('GET', url, null)

const P = '/api/session-delete'

// ---------------------------------------------------------------------------
;(() => {
  const failed = []
  const test = (name, fn) =>
    Promise.resolve()
      .then(fn)
      .then(() => console.log(`  ✓ ${name}`))
      .catch((e) => {
        failed.push(name)
        console.error(`  ✗ ${name}\n    ${e?.stack ?? e}`)
      })
  const done = () => {
    if (failed.length) {
      console.error(`\nFAILED: ${failed.join(', ')}`)
      process.exitCode = 1
    } else console.log('\n全部通过')
  }

  ;(async () => {
    await createSession('session-aaaa1111-0000-4000-8000-000000000001', cwdA, 500)
    await createSession('session-aaaa2222-0000-4000-8000-000000000002', cwdA, 900)
    await createSession('session-bbbb3333-0000-4000-8000-000000000003', cwdB, 200)

    await test('GET /list 返回全部会话与工作区分组信息', async () => {
      const r = res()
      await routes.get(`${P}/list`)(get(`${P}/list`), r)
      assert.equal(r.status, 200)
      assert.equal(r.body.sessions.length, 3)
      assert.equal(r.body.workspaces[0].title, 'project-a')
      assert.equal(r.body.unarchiveSupported, true, '/list 应上报在线解档能力')
      const a1 = r.body.sessions.find((s) => s.id.endsWith('0001'))
      assert.equal(a1.sizeBytes, 500)
      assert.equal(a1.archived, false)
      assert.ok(a1.mtimeMs > 0)
      // title 必须是字符串（SessionTitleSnapshot 已解包），否则客户端渲染报 React #31
      assert.ok(typeof a1.title === 'string' && a1.title.startsWith('会话 '), `title 应为字符串，实际: ${JSON.stringify(a1.title)}`)
      // 缓存路径：第二次 /list 命中 mtime 缓存，结果必须与首次一致
      const r2 = res()
      await routes.get(`${P}/list`)(get(`${P}/list`), r2)
      assert.equal(r2.status, 200)
      const a1b = r2.body.sessions.find((s) => s.id.endsWith('0001'))
      assert.strictEqual(a1b.title, a1.title, '缓存命中的 title 应与首次一致')
      assert.strictEqual(a1b.sizeBytes, a1.sizeBytes)
    })

    await test('GET /list 会 reconcile 历史 archivedSessionIds ghost', async () => {
      const ghost = 'session-ghost9999-0000-4000-8000-000000000099'
      archived.add(ghost)
      assert.ok(!headers.some((h) => h.id === ghost), 'ghost 不在磁盘清单')
      const r = res()
      await routes.get(`${P}/list`)(get(`${P}/list`), r)
      assert.equal(r.status, 200)
      assert.ok(!archived.has(ghost), '/list 应清掉磁盘上不存在的归档 ghost')
      const audit = await readFile(join(home, 'trash', 'sessions', 'audit.log'), 'utf8')
      assert.ok(audit.includes('"action":"reconcile-archived-ghosts"'), '应写 reconcile 审计')
    })

    await test('GET /preview 命中单个会话', async () => {
      const r = res()
      await routes.get(`${P}/preview`)(get(`${P}/preview?id=session-aaaa1111-0000-4000-8000-000000000001`), r)
      assert.equal(r.status, 200)
      assert.equal(r.body.session.sizeBytes, 500)
    })

    await test('GET /preview 未知 id → 404', async () => {
      const r = res()
      await routes.get(`${P}/preview`)(get(`${P}/preview?id=session-zzzz9999-0000-4000-8000-000000000009`), r)
      assert.equal(r.status, 404)
    })

    await test('运行中的会话拒绝删除（409 RUNNING）', async () => {
      running.set('session-bbbb3333-0000-4000-8000-000000000003', true)
      const r = res()
      await routes.get(`${P}/delete`)(bodyReq('POST', `${P}/delete`, { id: 'session-bbbb3333-0000-4000-8000-000000000003' }), r)
      assert.equal(r.status, 409)
      assert.equal(r.body.error.code, 'RUNNING')
      running.delete('session-bbbb3333-0000-4000-8000-000000000003')
    })

    await test('POST /delete：归档先行 + 目录移入回收站 + meta + 审计', async () => {
      const id = 'session-aaaa1111-0000-4000-8000-000000000001'
      const dirBefore = join(sessionsRoot, slug(cwdA), id)
      assert.ok(await stat(dirBefore).then(() => true, () => false))
      const r = res()
      await routes.get(`${P}/delete`)(bodyReq('POST', `${P}/delete`, { id }), r)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.equal(archiveCalls.at(-1), id, '必须先调用 archiveSession')
      assert.ok(!archived.has(id), '删除成功后应清掉 archivedSessionIds ghost')
      assert.ok(r.body.entry.startsWith('20'), r.body.entry)
      const entryDir = join(home, 'trash', 'sessions', r.body.entry)
      const meta = JSON.parse(await readFile(join(entryDir, 'meta.json'), 'utf8'))
      assert.equal(meta.id, id)
      assert.equal(meta.cwd, cwdA)
      assert.equal(meta.sizeBytes, 500)
      assert.equal(meta.title, '会话 aaaa', '标题应随会话进回收站（缓存命中路径）')
      assert.ok(await stat(join(entryDir, 'data', 'session.jsonl.zstd')).then(() => true, () => false), '日志文件应进入回收站')
      assert.ok(!(await stat(dirBefore).then(() => true, () => false)), '原目录应消失')
      const audit = await readFile(join(home, 'trash', 'sessions', 'audit.log'), 'utf8')
      assert.ok(audit.includes(`"action":"delete"`) && audit.includes(id))
      assert.ok(audit.includes('"forgottenArchived":true'), '审计应记录清理了归档 ghost')
      // 磁盘清单不再包含该会话（桩的 list 模拟真实扫描）
      headers.splice(headers.findIndex((x) => x.id === id), 1)
    })

    await test('重复删除同一会话 → 404 NOT_FOUND', async () => {
      const r = res()
      await routes.get(`${P}/delete`)(bodyReq('POST', `${P}/delete`, { id: 'session-aaaa1111-0000-4000-8000-000000000001' }), r)
      assert.equal(r.status, 404)
    })

    await test('GET /trash 列出条目', async () => {
      const r = res()
      await routes.get(`${P}/trash`)(get(`${P}/trash`), r)
      assert.equal(r.status, 200)
      assert.equal(r.body.items.length, 1)
      assert.equal(r.body.items[0].id, 'session-aaaa1111-0000-4000-8000-000000000001')
      assert.equal(r.body.items[0].title, '会话 aaaa', '回收站应回传会话名称')
      assert.equal(r.body.items[0].sizeBytes, 500)
    })

    await test('POST /restore 原位还原 + 自动解除归档', async () => {
      const r0 = res()
      await routes.get(`${P}/trash`)(get(`${P}/trash`), r0)
      const entry = r0.body.items[0].entry
      const r = res()
      await routes.get(`${P}/restore`)(bodyReq('POST', `${P}/restore`, { entry }), r)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.equal(r.body.stillArchived, false, '还原后应自动解除归档')
      assert.ok(!archived.has('session-aaaa1111-0000-4000-8000-000000000001'), '归档集应移除该 id')
      const restored = join(sessionsRoot, slug(cwdA), 'session-aaaa1111-0000-4000-8000-000000000001')
      assert.ok(await stat(join(restored, 'session.jsonl.zstd')).then(() => true, () => false))
      // 回收站条目应被清掉；还原后重新加入磁盘清单（模拟真实扫描）
      const r1 = res()
      await routes.get(`${P}/trash`)(get(`${P}/trash`), r1)
      assert.equal(r1.body.items.length, 0)
      headers.push({ type: 'session', version: 1, id: 'session-aaaa1111-0000-4000-8000-000000000001', createdAt: Date.now(), delegationDepth: 0, cwd: cwdA })
    })

    await test('POST /unarchive 在线解除归档（幂等 + 审计）', async () => {
      const id = 'session-aaaa2222-0000-4000-8000-000000000002'
      await ctx.workspaceRegistry.archiveSession(id) // 模拟侧栏「归档会话」
      const r = res()
      await routes.get(`${P}/unarchive`)(bodyReq('POST', `${P}/unarchive`, { id }), r)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.equal(r.body.changed, true)
      assert.ok(!archived.has(id), '归档集应移除该 id')
      const auditText = await readFile(join(home, 'trash', 'sessions', 'audit.log'), 'utf8')
      assert.ok(auditText.includes('"action":"unarchive"') && auditText.includes(id), '应写审计行')
      // 幂等：未归档的 id 直接成功（changed:false），不再写审计
      const r2 = res()
      await routes.get(`${P}/unarchive`)(bodyReq('POST', `${P}/unarchive`, { id }), r2)
      assert.equal(r2.status, 200)
      assert.equal(r2.body.changed, false)
    })

    await test('POST /unarchive 非法 id → 400 / 缺自定义头 → 403', async () => {
      const r = res()
      await routes.get(`${P}/unarchive`)(bodyReq('POST', `${P}/unarchive`, { id: '../../etc' }), r)
      assert.equal(r.status, 400)
      const r2 = res()
      await routes.get(`${P}/unarchive`)(bodyReq('POST', `${P}/unarchive`, { id: 'session-aaaa2222-0000-4000-8000-000000000002' }, false), r2)
      assert.equal(r2.status, 403)
    })

    await test('POST /purge 单条彻底删除', async () => {
      const id = 'session-aaaa2222-0000-4000-8000-000000000002'
      const rDel = res()
      await routes.get(`${P}/delete`)(bodyReq('POST', `${P}/delete`, { id }), rDel)
      assert.equal(rDel.status, 200)
      assert.ok(!archived.has(id), 'delete 已清 ghost')
      // 模拟旧数据：回收站条目仍在，但 archivedSessionIds 又被写回 ghost
      archived.add(id)
      headers.splice(headers.findIndex((x) => x.id === id), 1)
      const r0 = res()
      await routes.get(`${P}/trash`)(get(`${P}/trash`), r0)
      const entry = r0.body.items[0].entry
      const r = res()
      await routes.get(`${P}/purge`)(bodyReq('POST', `${P}/purge`, { entry }), r)
      assert.equal(r.status, 200)
      assert.ok(!archived.has(id), 'purge 单条也应清掉 archivedSessionIds ghost')
      const r1 = res()
      await routes.get(`${P}/trash`)(get(`${P}/trash`), r1)
      assert.equal(r1.body.items.length, 0)
    })

    await test('POST /purge all 清空回收站', async () => {
      const id = 'session-bbbb3333-0000-4000-8000-000000000003'
      const rDel = res()
      await routes.get(`${P}/delete`)(bodyReq('POST', `${P}/delete`, { id }), rDel)
      assert.equal(rDel.status, 200)
      archived.add(id) // 模拟残留 ghost，验证 purge-all 批量清理
      headers.splice(headers.findIndex((x) => x.id === id), 1)
      const r = res()
      await routes.get(`${P}/purge`)(bodyReq('POST', `${P}/purge`, { all: true }), r)
      assert.equal(r.status, 200)
      assert.equal(r.body.count, 1)
      assert.ok(!archived.has(id), 'purge-all 也应清掉 archivedSessionIds ghost')
      const left = await readdir(join(home, 'trash', 'sessions')).then((xs) => xs.filter((x) => x !== 'audit.log'))
      assert.equal(left.length, 0)
    })

    // --- live（打开中）会话：删除后保持归档隐藏，防止侧栏复活（0.3.0 修复） ---
    // 宿主 session.list 无条件吐出 attach 在内存里的活会话；若删除时摘掉归档，
    // archived-sessions-changed 广播会让它立刻在侧栏复活（文件却已进回收站）。
    const LIVE_ID = 'session-live1111-0000-4000-8000-000000000010'

    await test('删除「打开中」会话：文件进回收站，但保持归档隐藏（keptHidden）', async () => {
      await createSession(LIVE_ID, cwdA, 64)
      liveIdle.add(LIVE_ID)
      const r = res()
      await routes.get(`${P}/delete`)(bodyReq('POST', `${P}/delete`, { id: LIVE_ID }), r)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.equal(r.body.keptHidden, true, 'live 会话删除后应报告 keptHidden')
      assert.ok(archived.has(LIVE_ID), 'live 会话应保持归档隐藏（摘掉会在侧栏复活）')
      assert.ok(r.body.entry, '应返回回收站条目')
      assert.ok(
        await stat(join(home, 'trash', 'sessions', r.body.entry, 'data', 'session.jsonl.zstd')).then(() => true, () => false),
        '文件应移入回收站',
      )
      const audit = await readFile(join(home, 'trash', 'sessions', 'audit.log'), 'utf8')
      assert.ok(audit.includes('"keptHidden":true'), '审计应记录 keptHidden')
      headers.splice(headers.findIndex((x) => x.id === LIVE_ID), 1) // 模拟真实磁盘扫描
    })

    await test('/list reconcile 跳过 live 会话的归档 id（有意保留的隐藏态）', async () => {
      assert.ok(archived.has(LIVE_ID) && liveIdle.has(LIVE_ID))
      const r = res()
      await routes.get(`${P}/list`)(get(`${P}/list`), r)
      assert.equal(r.status, 200)
      assert.ok(archived.has(LIVE_ID), 'live ghost 不应被 reconcile 清掉（清掉会在侧栏复活）')
      assert.ok(!r.body.sessions.some((s) => s.id === LIVE_ID), '已删除会话不应出现在面板清单')
    })

    await test('purge live 会话的回收站条目：保持归档；不再 live 后 reconcile 收敛', async () => {
      const rT = res()
      await routes.get(`${P}/trash`)(get(`${P}/trash`), rT)
      const entry = rT.body.items.find((i) => i.id === LIVE_ID)?.entry
      assert.ok(entry, '回收站应有该会话的条目')
      const r = res()
      await routes.get(`${P}/purge`)(bodyReq('POST', `${P}/purge`, { entry }), r)
      assert.equal(r.status, 200)
      assert.ok(archived.has(LIVE_ID), 'purge 后 live 会话仍应保持归档隐藏')
      // 模拟宿主重启：会话不再 live → 下一次 /list 的 reconcile 清掉 ghost
      liveIdle.delete(LIVE_ID)
      const r2 = res()
      await routes.get(`${P}/list`)(get(`${P}/list`), r2)
      assert.equal(r2.status, 200)
      assert.ok(!archived.has(LIVE_ID), '不再 live 后 reconcile 应清掉 ghost')
    })

    await test('无缓存删除也能取标题（titlesFor 直读路径）', async () => {
      // cccc 从未经过 /list、/preview——recordCache 无记录，删除时走 titlesFor
      await createSession('session-eeee7777-0000-4000-8000-000000000007', cwdA, 120)
      const rDel = res()
      await routes.get(`${P}/delete`)(bodyReq('POST', `${P}/delete`, { id: 'session-eeee7777-0000-4000-8000-000000000007' }), rDel)
      assert.equal(rDel.status, 200, JSON.stringify(rDel.body))
      headers.splice(headers.findIndex((x) => x.id === 'session-eeee7777-0000-4000-8000-000000000007'), 1)
      const r = res()
      await routes.get(`${P}/trash`)(get(`${P}/trash`), r)
      assert.equal(r.body.items[0].title, '会话 eeee', '无缓存路径也应取到标题')
      // 收尾：彻底删除该条目，不污染后续用例
      await routes.get(`${P}/purge`)(bodyReq('POST', `${P}/purge`, { entry: r.body.items[0].entry }), res())
    })

    await test('旧版回收站条目缺 title → 回退 id 显示（title 为 null）', async () => {
      const entryDir = join(home, 'trash', 'sessions', '20200101-000000-session-ffff8888-0000-4000-8000-000000000008')
      await mkdir(join(entryDir, 'data'), { recursive: true })
      await writeFile(join(entryDir, 'data', 'session.jsonl.zstd'), 'x'.repeat(32))
      await writeFile(join(entryDir, 'meta.json'), JSON.stringify({ id: 'session-ffff8888-0000-4000-8000-000000000008', cwd: cwdA, trashedAt: '2020-01-01T00:00:00Z', sizeBytes: 32 }))
      const r = res()
      await routes.get(`${P}/trash`)(get(`${P}/trash`), r)
      const it = r.body.items.find((x) => x.id.endsWith('0008'))
      assert.ok(it, '手动条目应出现在回收站清单')
      assert.equal(it.title, null, '缺 title 的旧条目应为 null（客户端回退显示 id）')
      await routes.get(`${P}/purge`)(bodyReq('POST', `${P}/purge`, { entry: it.entry }), res())
    })

    await test('缺自定义头的 POST → 403（CSRF 防线）', async () => {
      const r = res()
      await routes.get(`${P}/delete`)(bodyReq('POST', `${P}/delete`, { id: 'x' }, false), r)
      assert.equal(r.status, 403)
    })

    await test('非法 id → 400', async () => {
      const r = res()
      await routes.get(`${P}/preview`)(get(`${P}/preview?id=../../etc`), r)
      assert.equal(r.status, 400)
    })

    await test('非 session- 前缀的合法 id 形态可正常操作（裸 UUID 子代理 / <id>-session-<uuid> 配置子代理）', async () => {
      // 可延续子代理：dsh-subagent startContinuable 生成裸 UUID（无 session- 前缀）
      const bareUuid = '123e4567-e89b-42d3-a456-426614174000'
      // 配置子代理：dsh-agent-loop 生成 <id>-session-<uuid>
      const configured = 'researcher-session-11111111-2222-4333-8444-555555555555'
      await createSession(bareUuid, cwdA, 64)
      await createSession(configured, cwdA, 64)

      // preview 均应 200（修复前裸 UUID 形态被 ID_RE 拒绝 → 400）
      for (const id of [bareUuid, configured]) {
        const r = res()
        await routes.get(`${P}/preview`)(get(`${P}/preview?id=${id}`), r)
        assert.equal(r.status, 200, `preview ${id} 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`)
        assert.equal(r.body.session.id, id)
      }

      // delete 均应 200 且进回收站（修复前裸 UUID 形态在 delete 时被 400 拦截）
      for (const id of [bareUuid, configured]) {
        const r = res()
        await routes.get(`${P}/delete`)(bodyReq('POST', `${P}/delete`, { id }), r)
        assert.equal(r.status, 200, `delete ${id} 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`)
        assert.ok(r.body.entry, `delete ${id} 应返回回收站条目`)
        headers.splice(headers.findIndex((x) => x.id === id), 1)
      }

      // restore 均应 200 且自动解除归档（回收站条目名 = <时间戳>-<id>，长度仍在 ENTRY_RE 内）
      for (const id of [bareUuid, configured]) {
        const rTrash = res()
        await routes.get(`${P}/trash`)(get(`${P}/trash`), rTrash)
        const entry = rTrash.body.items.find((i) => i.id === id)?.entry
        assert.ok(entry, `trash 应包含 ${id} 的条目`)
        const r = res()
        await routes.get(`${P}/restore`)(bodyReq('POST', `${P}/restore`, { entry }), r)
        assert.equal(r.status, 200, `restore ${id} 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`)
        headers.push({ type: 'session', version: 1, id, createdAt: Date.now(), delegationDepth: 0, cwd: cwdA })
      }
    })

    await test('id 白名单边界：过短 / 含非法字符 / 超长（80）均拒绝', async () => {
      const evil = ['abc', '1234567', 'under_score-12345678', 'has space', 'a'.repeat(81), 'session-' + 'a'.repeat(80)]
      for (const id of evil) {
        const r = res()
        await routes.get(`${P}/preview`)(get(`${P}/preview?id=${encodeURIComponent(id)}`), r)
        assert.equal(r.status, 400, `id ${JSON.stringify(id.slice(0, 30))} 应 400，实际 ${r.status}`)
      }
      // 恰好 80 字符的合法 id 应通过（长度上限边界）
      const ok80 = 'a'.repeat(80)
      await createSession(ok80, cwdA, 32)
      const rOk = res()
      await routes.get(`${P}/preview`)(get(`${P}/preview?id=${ok80}`), rOk)
      assert.equal(rOk.status, 200, `80 字符 id 应 200，实际 ${rOk.status}`)
      headers.splice(headers.findIndex((x) => x.id === ok80), 1)
    })

    await test('回收站条目路径穿越防护：entry=".." / "." / "audit.log" 全部拒绝', async () => {
      // 先删一个会话制造回收站内容，确保攻击发生时目标确实存在
      await createSession('session-cccc4444-0000-4000-8000-000000000004', cwdA, 100)
      const rDel = res()
      await routes.get(`${P}/delete`)(bodyReq('POST', `${P}/delete`, { id: 'session-cccc4444-0000-4000-8000-000000000004' }), rDel)
      assert.equal(rDel.status, 200)
      headers.splice(headers.findIndex((x) => x.id === 'session-cccc4444-0000-4000-8000-000000000004'), 1)

      for (const evil of ['..', '.', 'audit.log']) {
        for (const path of ['/purge', '/restore']) {
          const r = res()
          await routes.get(`${P}${path}`)(bodyReq('POST', `${P}${path}`, { entry: evil }), r)
          assert.equal(r.status, 400, `${path} entry=${evil} 应 400，实际 ${r.status}`)
        }
      }
      // 审计日志必须仍然存在（未被当作条目删除）
      const audit = await readFile(join(home, 'trash', 'sessions', 'audit.log'), 'utf8')
      assert.ok(audit.includes('session-cccc4444'))
      // 清理该条目
      const rT = res()
      await routes.get(`${P}/trash`)(get(`${P}/trash`), rT)
      await routes.get(`${P}/purge`)(bodyReq('POST', `${P}/purge`, { entry: rT.body.items[0].entry }), res())
    })

    await test('畸形 JSON 请求体 → 400（而非 500）', async () => {
      const r = res()
      const badReq = {
        method: 'POST',
        url: `${P}/delete`,
        headers: { 'x-dsh-plugin': 'session-delete' },
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('not-json{')
        },
      }
      await routes.get(`${P}/delete`)(badReq, r)
      assert.equal(r.status, 400)
      assert.equal(r.body.error.code, 'INVALID_BODY')
    })

    await test('旧版回退：registry 无内部状态机 → 501 + 还原保留归档态', async () => {
      const reg = ctx.workspaceRegistry
      const internals = { enqueueOperation: reg.enqueueOperation, requireState: reg.requireState, setState: reg.setState }
      delete reg.enqueueOperation
      delete reg.requireState
      delete reg.setState

      const rList = res()
      await routes.get(`${P}/list`)(get(`${P}/list`), rList)
      assert.equal(rList.body.unarchiveSupported, false, '/list 应上报能力缺失')

      const rUn = res()
      await routes.get(`${P}/unarchive`)(bodyReq('POST', `${P}/unarchive`, { id: 'session-dddd5555-0000-4000-8000-000000000005' }), rUn)
      assert.equal(rUn.status, 501)
      assert.equal(rUn.body.error.code, 'UNSUPPORTED')

      // 该模式下回收站还原回到旧行为（文件还原、归档态保留），客户端据此提示离线步骤
      await createSession('session-dddd5555-0000-4000-8000-000000000005', cwdA, 64)
      const rDel = res()
      await routes.get(`${P}/delete`)(bodyReq('POST', `${P}/delete`, { id: 'session-dddd5555-0000-4000-8000-000000000005' }), rDel)
      assert.equal(rDel.status, 200)
      assert.ok(
        archived.has('session-dddd5555-0000-4000-8000-000000000005'),
        '旧版无状态机时 delete 仍会留下 archivedSessionIds（无法在线清 ghost）',
      )
      headers.splice(headers.findIndex((x) => x.id === 'session-dddd5555-0000-4000-8000-000000000005'), 1)
      const r0 = res()
      await routes.get(`${P}/trash`)(get(`${P}/trash`), r0)
      const rRestore = res()
      await routes.get(`${P}/restore`)(bodyReq('POST', `${P}/restore`, { entry: r0.body.items.at(-1).entry }), rRestore)
      assert.equal(rRestore.status, 200, JSON.stringify(rRestore.body))
      assert.equal(rRestore.body.stillArchived, true, '无内部状态机时还原应保留归档态')

      Object.assign(reg, internals) // 恢复内部方法，不影响已完成的断言
    })

    await rm(home, { recursive: true, force: true })
    done()
  })()
})()
