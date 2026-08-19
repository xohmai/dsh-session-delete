/**
 * dsh-session-delete 宿主半冒烟测试。
 *
 * 用桩 ctx 直接驱动 apply() 注册的 HTTP 路由，在临时目录里模拟真实存储布局：
 *   <home>/sessions/<slug>/session-<id>/session.jsonl.zstd
 * 验证：list / preview / delete（含运行保护、归档时序）/ trash / restore / purge / CSRF。
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
  },
  agents: {
    get: (id) => (running.get(id) ? { status: 'running' } : undefined),
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
      assert.ok(r.body.entry.startsWith('20'), r.body.entry)
      const entryDir = join(home, 'trash', 'sessions', r.body.entry)
      const meta = JSON.parse(await readFile(join(entryDir, 'meta.json'), 'utf8'))
      assert.equal(meta.id, id)
      assert.equal(meta.cwd, cwdA)
      assert.equal(meta.sizeBytes, 500)
      assert.ok(await stat(join(entryDir, 'data', 'session.jsonl.zstd')).then(() => true, () => false), '日志文件应进入回收站')
      assert.ok(!(await stat(dirBefore).then(() => true, () => false)), '原目录应消失')
      const audit = await readFile(join(home, 'trash', 'sessions', 'audit.log'), 'utf8')
      assert.ok(audit.includes(`"action":"delete"`) && audit.includes(id))
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
      assert.equal(r.body.items[0].sizeBytes, 500)
    })

    await test('POST /restore 原位还原 + stillArchived 提示', async () => {
      const r0 = res()
      await routes.get(`${P}/trash`)(get(`${P}/trash`), r0)
      const entry = r0.body.items[0].entry
      const r = res()
      await routes.get(`${P}/restore`)(bodyReq('POST', `${P}/restore`, { entry }), r)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.equal(r.body.stillArchived, true)
      const restored = join(sessionsRoot, slug(cwdA), 'session-aaaa1111-0000-4000-8000-000000000001')
      assert.ok(await stat(join(restored, 'session.jsonl.zstd')).then(() => true, () => false))
      // 回收站条目应被清掉；还原后重新加入磁盘清单（模拟真实扫描）
      const r1 = res()
      await routes.get(`${P}/trash`)(get(`${P}/trash`), r1)
      assert.equal(r1.body.items.length, 0)
      headers.push({ type: 'session', version: 1, id: 'session-aaaa1111-0000-4000-8000-000000000001', createdAt: Date.now(), delegationDepth: 0, cwd: cwdA })
    })

    await test('POST /purge 单条彻底删除', async () => {
      const rDel = res()
      await routes.get(`${P}/delete`)(bodyReq('POST', `${P}/delete`, { id: 'session-aaaa2222-0000-4000-8000-000000000002' }), rDel)
      assert.equal(rDel.status, 200)
      headers.splice(headers.findIndex((x) => x.id === 'session-aaaa2222-0000-4000-8000-000000000002'), 1)
      const r0 = res()
      await routes.get(`${P}/trash`)(get(`${P}/trash`), r0)
      const entry = r0.body.items[0].entry
      const r = res()
      await routes.get(`${P}/purge`)(bodyReq('POST', `${P}/purge`, { entry }), r)
      assert.equal(r.status, 200)
      const r1 = res()
      await routes.get(`${P}/trash`)(get(`${P}/trash`), r1)
      assert.equal(r1.body.items.length, 0)
    })

    await test('POST /purge all 清空回收站', async () => {
      const rDel = res()
      await routes.get(`${P}/delete`)(bodyReq('POST', `${P}/delete`, { id: 'session-bbbb3333-0000-4000-8000-000000000003' }), rDel)
      assert.equal(rDel.status, 200)
      headers.splice(headers.findIndex((x) => x.id === 'session-bbbb3333-0000-4000-8000-000000000003'), 1)
      const r = res()
      await routes.get(`${P}/purge`)(bodyReq('POST', `${P}/purge`, { all: true }), r)
      assert.equal(r.status, 200)
      assert.equal(r.body.count, 1)
      const left = await readdir(join(home, 'trash', 'sessions')).then((xs) => xs.filter((x) => x !== 'audit.log'))
      assert.equal(left.length, 0)
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

    await rm(home, { recursive: true, force: true })
    done()
  })()
})()
