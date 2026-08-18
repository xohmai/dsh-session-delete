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

if (failed.length) {
  console.error(`\nFAILED: ${failed.join(', ')}`)
  process.exit(1)
}
console.log('\n渲染冒烟全部通过')
