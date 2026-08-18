#!/usr/bin/env node
/**
 * dsh-session-delete 还原会话的「解除归档」工具。
 *
 * 背景：DSH 官方的 workspaceRegistry 只有 archiveSession、没有 unarchive；
 * 回收站「还原」只把磁盘日志放回原位，会话 id 仍留在 workspace.json 的
 * archivedSessionIds 归档集中，侧栏不会重新显示。本工具直接编辑
 * <DSH_HOME>/storages/workspace.json 把指定 id 移出归档集。
 *
 * ⚠ 必须在 DSH 停止时运行：运行中的注册表持有内存态，之后的任何写操作
 *   都会把这里的修改覆盖回去。
 *
 * 用法：
 *   node tools/unhide.mjs <sessionId> [sessionId...]
 *   DSH_HOME=/path node tools/unhide.mjs <sessionId>
 */
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('用法: node tools/unhide.mjs <sessionId> [sessionId...]')
  process.exit(2)
}

const home = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
const file = join(home, 'storages', 'workspace.json')
const raw = await readFile(file, 'utf8')
const doc = JSON.parse(raw)

if (!doc?.global || !Array.isArray(doc.global.archivedSessionIds)) {
  console.error(`✗ ${file} 结构异常（缺少 global.archivedSessionIds），未做修改`)
  process.exit(1)
}

const before = doc.global.archivedSessionIds.length
const wanted = new Set(args)
const removed = doc.global.archivedSessionIds.filter((id) => wanted.has(id))
doc.global.archivedSessionIds = doc.global.archivedSessionIds.filter((id) => !wanted.has(id))

if (removed.length === 0) {
  console.log('归档集中没有匹配的 id，无需修改。')
  process.exit(0)
}

const backup = `${file}.bak-${Date.now()}`
await copyFile(file, backup)
const tmp = `${file}.tmp`
await writeFile(tmp, JSON.stringify(doc), 'utf8')
await rename(tmp, file)

console.log(`✓ 已把 ${removed.length} 个会话移出归档集（${before} → ${doc.global.archivedSessionIds.length}）`)
for (const id of removed) console.log(`  - ${id}`)
console.log(`  备份：${backup}`)
console.log('请确认 DSH 已停止后启动，侧栏将重新显示这些会话。')
