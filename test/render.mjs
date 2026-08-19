/**
 * Client 半 SSR 渲染冒烟测试。
 *
 * 用 DSH 自带的 react/react-dom（18.3.1）对组件做 renderToString 验证，
 * 复现「设置页右侧一片空白」一类的渲染期异常——render 期抛错在生产环境
 * 会被槽位错误边界渲染成空 div（data-slot-error），现象即空白。
 *
 * 运行：node test/render.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const NM = '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules'
const require2 = createRequire(import.meta.url)
const React = require2(`${NM}/react/index.js`)
const { renderToString } = require2(`${NM}/react-dom/server.js`)

// ---- 桩 __ModuleLoader__ 捕获 client.js 的 factory ----
let def = null
global.window = {
  __ModuleLoader__: { load: (d) => (def = d) },
}
const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
new Function(src)() // 执行 window.__ModuleLoader__.load(...)
assert.ok(def, 'client.js 未通过 __ModuleLoader__.load 注册')

const mod = def.factory((name) => {
  if (name === 'react') return React
  throw new Error(`未预期的 require: ${name}`)
})
const { SettingsPage, ArchiveSettingsSection } = mod
assert.ok(typeof SettingsPage === 'function')
assert.ok(typeof ArchiveSettingsSection === 'function')

const h = React.createElement

// ---- 桩 props：对齐 shell 真实传入（owner close + standard useSessions/useWorkspaces） ----
const useSessions = (sel) => sel({ current: 'session-test-current', ids: [] })
const useWorkspaces = (sel) => sel({ items: [] })

const failed = []
const test = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((e) => {
      failed.push(name)
      console.error(`  ✗ ${name}\n    ${e?.stack ?? e}`)
    })

await test('SettingsPage 默认 props 渲染（undefined props 不得抛错）', () => {
  const html = renderToString(h(SettingsPage))
  assert.ok(typeof html === 'string' && html.length > 100)
})

await test('SettingsPage 完整 props：SSR 显示空态（effect 不执行，list=null → 空态提示）', () => {
  const html = renderToString(h(SettingsPage, { close: () => {}, currentId: 'session-x' }))
  assert.ok(html.includes('归档会话'), 'nav 页签应存在')
})

await test('ArchiveSettingsSection（注册壳）完整 props 渲染', () => {
  const html = renderToString(h(ArchiveSettingsSection, { close: () => {}, useSessions, useWorkspaces }))
  assert.ok(html.includes('归档会话'), `应渲染页签，实际: ${html.slice(0, 200)}`)
})

await test('ArchiveSettingsSection 无 standard props（useSessions 缺失走 fallback）不抛错', () => {
  const html = renderToString(h(ArchiveSettingsSection, { close: () => {} }))
  assert.ok(html.length > 0)
})

// ---- 有数据分支（经 initial* 注入；SSR 不跑 effect，注入数据即首帧状态） ----
// 回归背景：状态重命名（loading → listLoading）漏改页脚一处引用，ReferenceError
// 只在「列表非空」路径执行，空态测试测不到，用户点开页签才爆。
const mkSession = (over = {}) => ({
  id: 'session-test-0001', cwd: '/tmp/proj', createdAt: Date.now() - 86400000,
  origin: null, delegationDepth: 0, title: '测试会话', archived: true,
  live: false, running: false, sizeBytes: 4096, mtimeMs: Date.now() - 3600e3, ...over,
})

await test('归档页签有数据：行 + 页脚（全选/删除所选）+ 工具条全部渲染', () => {
  const list = [mkSession(), mkSession({ id: 'session-test-0002', title: '第二个', sizeBytes: 8192 })]
  const html = renderToString(h(SettingsPage, { close: () => {}, currentId: 'x', initialList: list, initialWorkspaces: [] }))
  assert.ok(html.includes('测试会话'), '会话行标题')
  assert.ok(html.includes('第二个'), '第二行')
  assert.ok(html.includes('全选'), '页脚全选按钮（上次事故点）')
  assert.ok(html.includes('删除所选'), '页脚批量删除按钮')
  assert.ok(html.includes('还原</button>'), '行内还原按钮（在线解除归档）')
  assert.ok(html.includes('还原所选'), '页脚批量还原按钮')
  assert.ok(html.includes('立即回到侧栏'), '工具条在线还原提示')
  assert.ok(html.includes('2 个已归档会话'), '工具条统计')
  assert.ok(html.includes('确认删除') === false, '未武装时不应出现确认删除')
})

await test('归档页签（旧版 DSH 无在线解档）：无还原入口 + 保留离线提示', () => {
  const html = renderToString(h(SettingsPage, {
    close: () => {}, currentId: 'x', initialList: [mkSession()], initialWorkspaces: [],
    initialUnarchiveSupported: false,
  }))
  assert.ok(!html.includes('还原</button>'), '不应有行内还原按钮')
  assert.ok(!html.includes('还原所选'), '不应有批量还原按钮')
  assert.ok(html.includes('unhide'), '应保留离线 unhide 指引')
})

await test('全部会话页签有数据：分组头 + 行 + 搜索/过滤工具条', () => {
  const list = [
    mkSession({ id: 'session-test-0001', archived: false }),
    mkSession({ id: 'session-test-0002', archived: false, cwd: '/tmp/other', origin: 'subagent' }),
  ]
  const html = renderToString(h(SettingsPage, {
    close: () => {}, currentId: 'x', initialTab: 'all', initialList: list,
    initialWorkspaces: [{ workspaceId: 'w1', title: 'proj', path: '/tmp/proj' }],
  }))
  assert.ok(html.includes('proj'), '工作区分组头（workspace 标题）')
  assert.ok(html.includes('子代理'), '子代理标记')
  assert.ok(html.includes('未归档'), '过滤按钮')
  assert.ok(html.includes('2 / 2'), '命中计数')
  // 复选框统一尺寸回归：2 会话行 + 2 分组头，每个都必须挂 .sd-check
  // （旧 bug：尺寸选择器只覆盖 .sd-row，分组头按默认 13px 渲染显得更小）
  assert.equal((html.match(/sd-check/g) ?? []).length, 4, '会话行与分组头的复选框都应挂 sd-check 类')
})

await test('回收站页签有数据：名称 + 多选 + 批量按钮 + 底部清空栏', () => {
  const trash = [
    { entry: '20260801-000000-session-test-0001', id: 'session-test-0001', title: '被删的会话', cwd: '/tmp', trashedAt: new Date().toISOString(), sizeBytes: 4096 },
    { entry: '20260801-000100-session-test-0002', id: 'session-test-0002', title: null, cwd: '/tmp', trashedAt: new Date().toISOString(), sizeBytes: 1024 },
  ]
  const html = renderToString(h(SettingsPage, { close: () => {}, currentId: 'x', initialTab: 'trash', initialTrash: trash }))
  assert.ok(html.includes('被删的会话'), '有标题的条目应显示会话名')
  assert.ok(html.includes('session-test-0002'), '无标题条目回退显示 id')
  assert.ok(html.includes('还原'), '单条还原按钮')
  assert.ok(html.includes('彻底删除'), '单条彻底删除按钮')
  assert.ok(html.includes('还原所选'), '批量还原按钮')
  assert.ok(html.includes('彻底删除所选'), '批量彻底删除按钮')
  assert.ok(html.includes('全选'), '全选按钮')
  assert.ok(html.includes('清空回收站'), '底部清空栏')
  assert.ok(html.includes('type="checkbox"'), '回收站行应有复选框（多选）')
})

if (failed.length) {
  console.error(`\nFAILED: ${failed.join(', ')}`)
  process.exit(1)
}
console.log('\n渲染冒烟全部通过')
