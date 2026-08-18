/**
 * dsh-session-delete — Client half.
 *
 * 手写 __ModuleLoader__ 包壳（与 tsdown 产物同构），零构建步骤。
 * 槽位：
 *   settings.section  设置页「归档会话」管理页（唯一入口）：
 *     · 归档会话（默认页签）—— 已归档会话清单，单条删除（两步确认）+ 多选批量
 *     · 全部会话 —— 按工作区分组的全量清单，搜索/过滤/批量删除
 *     · 回收站 —— 还原 / 彻底删除 / 清空
 *
 * 数据全部来自本机 Host API（/api/session-delete/*）；删除当前打开的会话后
 * 经 workspaces.startSession() 切到同工作区空白会话，UI 不悬空。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState } = React

    const PREFIX = '/api/session-delete'
    const HDR = 'x-dsh-plugin'

    // ---------- 交互样式（注入 <style>，随插件停止移除） ----------
    const CSS = `
      @keyframes sdFade { from { opacity: 0; transform: translateY(2px) } to { opacity: 1; transform: translateY(0) } }
      @keyframes sdSpin { to { transform: rotate(360deg) } }
      .sd-fade { animation: sdFade .18s ease-out both }
      .sd-btn { transition: background .15s ease, border-color .15s ease, color .15s ease, transform .1s ease, opacity .15s ease }
      .sd-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1)); border-color: var(--dsw-alias-border-l2) }
      .sd-btn:active:not(:disabled) { transform: scale(.96) }
      .sd-btn:disabled { opacity: .55; cursor: default }
      .sd-spin { display: inline-block; animation: sdSpin .8s linear infinite }
      /* 列表行：行间真实间距让相邻的选中背景彼此分开；选中/悬停样式统一在类里，
       * 避免 inline style 压掉 :hover（选中行悬停加深的反馈不能丢）。 */
      .sd-row { border-radius: 6px; margin-bottom: 3px }
      .sd-row:hover { background: color-mix(in srgb, var(--dsw-alias-label-secondary) 7%, transparent) }
      .sd-row.sd-sel {
        background: color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, transparent);
        box-shadow: inset 3px 0 0 var(--dsw-alias-brand-primary);
      }
      .sd-row.sd-sel:hover {
        background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);
      }
      /* 工作区分组头：标签化（小一号/加粗/次要色），吸顶 + 底部分隔线——
       * 长列表滚动时分组归属始终可见；与 13px/常规/主色的会话行形成清晰层级。 */
      .sd-grouphd {
        position: sticky;
        top: 0;
        z-index: 1;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 6px 5px 10px;
        margin-top: 8px;
        border-bottom: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-2);
        cursor: pointer;
      }
      .sd-grouphd:first-child { margin-top: 0 }
      .sd-grouphd:hover { background: color-mix(in srgb, var(--dsw-alias-label-secondary) 5%, transparent) }
      /*
       * 滚动让渡：官方设置面板把 section 内容放进 .options 容器（overflow-y:auto、
       * 普通 block）——按设计各 section 整体长高、容器滚动，tab 栏会跟着滚走。
       * 本页激活时（slot 锚点的直接子元素是 .sd-page）把该容器变成有界 flex 列并
       * 关掉自身滚动，让页面内部的列表区接管滚动、头部区固定。
       * 选择器只用结构（data-slot 锚点 + 类名），不依赖官方 CSS-module 哈希类名。
       */
      div:has(> [data-slot="settings.section"] > .sd-page) {
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      /* 设置面板 nav 行：把回退的齿轮图标换成 16px 线性垃圾桶（currentColor mask） */
      button[data-sd-nav] > svg:first-of-type { display: none !important }
      button[data-sd-nav] > span:first-of-type::before {
        content: '';
        display: inline-block;
        width: 16px;
        height: 16px;
        margin-right: 7px;
        flex: none;
        vertical-align: -3px;
        background-color: currentColor;
        -webkit-mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.3' stroke-linecap='round' stroke-linejoin='round'><path d='M2.5 4.2h11M6.3 2.2h3.4M3.8 4.2l.55 8.5a1 1 0 0 0 1 .93h5.3a1 1 0 0 0 1-.93l.55-8.5M6.5 7v4.3M9.5 7v4.3'/></svg>") center / contain no-repeat;
        mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.3' stroke-linecap='round' stroke-linejoin='round'><path d='M2.5 4.2h11M6.3 2.2h3.4M3.8 4.2l.55 8.5a1 1 0 0 0 1 .93h5.3a1 1 0 0 0 1-.93l.55-8.5M6.5 7v4.3M9.5 7v4.3'/></svg>") center / contain no-repeat;
      }
      @media (prefers-reduced-motion: reduce) {
        .sd-fade, .sd-spin { animation: none !important }
        .sd-btn { transition: none !important }
      }
    `

    const T = {
      bg: 'var(--dsw-alias-bg-layer-2)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      label: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
    }

    // ---------- workspaces 客户端服务（apply 时注入） ----------
    let workspacesService = null

    // ---------- 本机 API ----------
    async function api(path, options) {
      const res = await fetch(path, options)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? `HTTP ${res.status}`), { data })
      return data
    }
    function post(path, body) {
      return api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [HDR]: 'session-delete' },
        body: JSON.stringify(body ?? {}),
      })
    }

    // ---------- 批量删除（返回统计与成功 id；命中当前会话时自动切走） ----------
    async function deleteMany(ids, currentId, onProgress) {
      let ok = 0
      let failed = 0
      let message = null
      const okIds = []
      let deletedCurrent = false
      for (let i = 0; i < ids.length; i += 1) {
        const id = ids[i]
        try {
          await post(`${PREFIX}/delete`, { id })
          ok += 1
          okIds.push(id)
          if (id === currentId) deletedCurrent = true
        } catch (e) {
          failed += 1
          if (message === null) message = `${shortId(id)}：${e?.message ?? e}`
        }
        if (onProgress) onProgress(i + 1, ids.length)
      }
      if (deletedCurrent && workspacesService) {
        try {
          workspacesService.startSession()
        } catch {}
      }
      return { ok, failed, message, okIds }
    }

    // ---------- 格式化 ----------
    function fmtSize(b) {
      if (b == null) return '—'
      if (b < 1024) return `${b} B`
      if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`
      if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`
      return `${(b / 1024 ** 3).toFixed(2)} GB`
    }
    function fmtAgo(ms) {
      if (!ms) return '—'
      const s = Math.floor((Date.now() - ms) / 1000)
      if (s < 60) return '刚刚'
      const m = Math.floor(s / 60)
      if (m < 60) return `${m} 分钟前`
      const hh = Math.floor(m / 60)
      if (hh < 48) return `${hh} 小时前`
      return `${Math.floor(hh / 24)} 天前`
    }
    function fmtDate(ms) {
      if (!ms) return '—'
      const d = new Date(ms)
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }
    function shortId(id) {
      return String(id ?? '').replace(/^session-/, '').slice(0, 8)
    }

    // ---------- 样式片段 ----------
    const btnBase = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '4px 10px',
      border: `1px solid ${T.border}`,
      borderRadius: 6,
      background: 'transparent',
      color: T.label,
      fontSize: 13,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }
    const smallBtn = {
      ...btnBase,
      padding: '3px 9px',
      fontSize: 12,
    }
    const inputStyle = {
      padding: '4px 8px',
      border: `1px solid ${T.border}`,
      borderRadius: 6,
      background: T.layer1,
      color: T.label,
      fontSize: 13,
      outline: 'none',
      minWidth: 0,
    }
    const tagStyle = (color) => ({
      fontSize: 11,
      color,
      border: `1px solid ${color}`,
      borderRadius: 4,
      padding: '0 4px',
      lineHeight: '15px',
      flexShrink: 0,
      opacity: 0.9,
    })
    /**
     * 统一操作反馈通知：状态点 + 标题 + 详情 + 关闭。
     * ok 6 秒自动消失；warn/err 常驻直到手动关闭或下一次操作。
     */
    function NoticeBanner({ notice, onClose }) {
      if (!notice) return null
      const color = notice.kind === 'err' ? T.err : notice.kind === 'warn' ? T.warn : T.ok
      return h(
        'div',
        {
          className: 'sd-fade',
          style: {
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            margin: '10px 0 0',
            padding: '7px 10px',
            borderRadius: 8,
            flex: 'none',
            background: `color-mix(in srgb, ${color} 8%, transparent)`,
            border: `1px solid color-mix(in srgb, ${color} 30%, ${T.border})`,
          },
        },
        [
          h('span', { key: 'dot', style: { width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0, marginTop: 5 } }),
          h(
            'div',
            { key: 'body', style: { flex: 1, minWidth: 0 } },
            [
              h('div', { key: 't', style: { fontSize: 13, fontWeight: 600, color: T.label, lineHeight: '20px', wordBreak: 'break-word' } }, notice.title),
              notice.detail
                ? h('div', { key: 'd', style: { fontSize: 12, color: T.secondary, lineHeight: '18px', marginTop: 2, wordBreak: 'break-word' } }, notice.detail)
                : null,
            ].filter(Boolean),
          ),
          h(
            'button',
            {
              key: 'x',
              className: 'sd-btn',
              onClick: onClose,
              title: '关闭',
              style: { border: 'none', background: 'transparent', color: T.secondary, cursor: 'pointer', padding: '0 2px', fontSize: 12, lineHeight: '18px', flexShrink: 0 },
            },
            '✕',
          ),
        ],
      )
    }

    /** 单条两步确认删除按钮：第一次点击武装（变红），4 秒内再点执行。 */
    function ArmDeleteButton({ armed, onArm, onFire, busy, label = '删除' }) {
      return h(
        'button',
        {
          className: 'sd-btn',
          style: {
            ...smallBtn,
            background: armed ? T.err : 'transparent',
            borderColor: armed ? T.err : T.border,
            color: armed ? '#fff' : T.label,
            fontWeight: armed ? 600 : 400,
          },
          disabled: busy,
          onClick: armed ? onFire : onArm,
        },
        armed ? '确认删除' : label,
      )
    }

    // =========================================================================
    // 设置页
    // =========================================================================
    function SettingsPage(props) {
      const currentId = props?.currentId

      const [tab, setTab] = useState('archived') // archived | all | trash
      const [list, setList] = useState(null)
      const [workspaces, setWorkspaces] = useState([])
      const [trash, setTrash] = useState(null)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState(null)
      const [query, setQuery] = useState('')
      const [filter, setFilter] = useState('active') // active | archived | stale30 | all（仅 all 页签）
      const [selected, setSelected] = useState(new Set())
      const [busy, setBusy] = useState(false)
      const [progress, setProgress] = useState(null)
      const [notice, setNotice] = useState(null) // { kind: 'ok'|'warn'|'err', title, detail, at }
      const [arm, setArm] = useState(null) // 单条两步确认的目标（会话 id 或回收站条目名）
      const [purgeAllArmed, setPurgeAllArmed] = useState(false)

      // ok 类通知 6 秒自动消失（warn/err 常驻，直到手动关闭或下一次操作）
      useEffect(() => {
        if (!notice || notice.kind !== 'ok') return
        const timer = setTimeout(() => setNotice(null), 6000)
        return () => clearTimeout(timer)
      }, [notice?.at])

      async function loadList() {
        setLoading(true)
        setError(null)
        try {
          const data = await api(`${PREFIX}/list`)
          setList(data.sessions ?? [])
          setWorkspaces(data.workspaces ?? [])
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setLoading(false)
        }
      }
      async function loadTrash() {
        setLoading(true)
        setError(null)
        try {
          const data = await api(`${PREFIX}/trash`)
          setTrash(data.items ?? [])
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setLoading(false)
        }
      }

      useEffect(() => {
        setNotice(null)
        setArm(null)
        setSelected(new Set())
        if (tab === 'trash') {
          if (trash === null) loadTrash()
        } else if (list === null) loadList()
      }, [tab])

      // 4 秒未确认自动解除武装
      useEffect(() => {
        if (arm === null && !purgeAllArmed) return
        const t = setTimeout(() => {
          setArm(null)
          setPurgeAllArmed(false)
        }, 4000)
        return () => clearTimeout(t)
      }, [arm, purgeAllArmed])

      // ---------- 动作 ----------
      /** 成功删除的会话体积合计（按删除前清单精确计算）。 */
      const sizeById = new Map((list ?? []).map((s) => [s.id, s.sizeBytes ?? 0]))
      const freedOf = (okIds) => okIds.reduce((acc, id) => acc + (sizeById.get(id) ?? 0), 0)
      const at = () => Date.now()

      async function fireSingleDelete(id) {
        setArm(null)
        setBusy(true)
        const title = (list ?? []).find((s) => s.id === id)?.title
        try {
          const r = await deleteMany([id], currentId)
          if (r.ok > 0) {
            setNotice({
              kind: 'ok',
              title: `已删除「${title || shortId(id)}」`,
              detail: `已移入回收站（${fmtSize(freedOf(r.okIds))}）· 可在「回收站」页签还原`,
              at: at(),
            })
          } else {
            setNotice({ kind: 'err', title: '删除失败', detail: r.message, at: at() })
          }
          await loadList()
        } finally {
          setBusy(false)
          setSelected(new Set())
        }
      }
      async function fireBatchDelete(ids) {
        setBusy(true)
        setProgress({ done: 0, total: ids.length })
        try {
          const r = await deleteMany(ids, currentId, (done, total) => setProgress({ done, total }))
          if (r.failed === 0) {
            setNotice({
              kind: 'ok',
              title: `已删除 ${r.ok} 个会话 · 释放 ${fmtSize(freedOf(r.okIds))}`,
              detail: '已移入回收站 · 可在「回收站」页签还原',
              at: at(),
            })
          } else if (r.ok > 0) {
            setNotice({
              kind: 'warn',
              title: `已删除 ${r.ok} 个 · ${r.failed} 个失败`,
              detail: `成功部分已入回收站；首条失败：${r.message}`,
              at: at(),
            })
          } else {
            setNotice({ kind: 'err', title: `全部删除失败（${r.failed} 个）`, detail: r.message, at: at() })
          }
          await loadList()
        } finally {
          setBusy(false)
          setProgress(null)
          setSelected(new Set())
        }
      }
      async function fireRestore(entry) {
        setArm(null)
        setBusy(true)
        try {
          const r = await post(`${PREFIX}/restore`, { entry })
          if (r.stillArchived) {
            setNotice({
              kind: 'warn',
              title: `文件已还原（${shortId(r.id ?? '')}）`,
              detail: '该会话仍在归档集中，侧栏默认不显示；彻底找回见 README 的 unhide 步骤',
              at: at(),
            })
          } else {
            setNotice({ kind: 'ok', title: '已还原', detail: null, at: at() })
          }
        } catch (e) {
          setNotice({ kind: 'err', title: '还原失败', detail: String(e?.message ?? e), at: at() })
        } finally {
          setBusy(false)
          await loadTrash()
        }
      }
      async function firePurge(entry) {
        setArm(null)
        setBusy(true)
        try {
          await post(`${PREFIX}/purge`, { entry })
          setNotice({ kind: 'ok', title: '已彻底删除 1 项', detail: '回收站中已不可恢复', at: at() })
        } catch (e) {
          setNotice({ kind: 'err', title: '彻底删除失败', detail: String(e?.message ?? e), at: at() })
        } finally {
          setBusy(false)
          await loadTrash()
        }
      }
      async function firePurgeAll() {
        setPurgeAllArmed(false)
        setBusy(true)
        try {
          const r = await post(`${PREFIX}/purge`, { all: true })
          setNotice({ kind: 'ok', title: `已清空回收站（${r.count ?? 0} 项）`, detail: null, at: at() })
        } catch (e) {
          setNotice({ kind: 'err', title: '清空失败', detail: String(e?.message ?? e), at: at() })
        } finally {
          setBusy(false)
          await loadTrash()
        }
      }

      // ---------- 数据视图 ----------
      const sessions = list ?? []
      const archivedSessions = sessions.filter((s) => s.archived)
      const q = query.trim().toLowerCase()
      const now = Date.now()
      const filteredAll = sessions.filter((s) => {
        if (filter === 'active' && s.archived) return false
        if (filter === 'archived' && !s.archived) return false
        if (filter === 'stale30' && now - (s.mtimeMs ?? 0) < 30 * 86400000) return false
        if (q && !`${s.title ?? ''}\n${s.id}`.toLowerCase().includes(q)) return false
        return true
      })

      const toggle = (id) => {
        setSelected((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }
      const toggleGroup = (groupSessions) => {
        setSelected((prev) => {
          const next = new Set(prev)
          const allIn = groupSessions.every((s) => next.has(s.id))
          for (const s of groupSessions) {
            if (allIn) next.delete(s.id)
            else next.add(s.id)
          }
          return next
        })
      }

      const groups = new Map()
      for (const s of filteredAll) {
        const key = s.cwd ?? '(无目录)'
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(s)
      }
      const groupMeta = (key) => {
        const ws = workspaces.find((w) => w.path === key)
        const name = ws?.title || (key === '(无目录)' ? key : key.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || key)
        return { name, path: key }
      }

      const tabBtn = (id, label, count) => {
        const active = tab === id
        return h(
          'button',
          {
            key: id,
            className: 'sd-btn',
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '3px 10px',
              border: 'none',
              borderRadius: 6,
              background: active ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 15%, transparent)' : 'transparent',
              color: active ? T.brand : T.secondary,
              fontWeight: active ? 600 : 400,
              fontSize: 13,
              lineHeight: '20px',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            },
            onClick: () => setTab(id),
          },
          [
            h('span', { key: 'l' }, label),
            count !== undefined && count !== null
              ? h('span', { key: 'c', style: { fontSize: 11, opacity: 0.8, fontVariantNumeric: 'tabular-nums' } }, String(count))
              : null,
          ].filter(Boolean),
        )
      }

      const selectedBytes = (rows) => rows.filter((s) => selected.has(s.id)).reduce((acc, s) => acc + (s.sizeBytes ?? 0), 0)

      // ---------- 行渲染 ----------
      /** 会话行：整行可点击切换选中（复选框/操作按钮自身阻止冒泡）。选中态样式见 .sd-sel。 */
      const sessionRow = (s, opts) => {
        const isSel = selected.has(s.id)
        return h(
          'div',
          {
            key: s.id,
            className: isSel ? 'sd-row sd-sel' : 'sd-row',
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: opts?.indent ? '4px 6px 4px 22px' : '4px 6px 4px 10px',
              cursor: 'pointer',
              minHeight: 32,
            },
            onClick: () => toggle(s.id),
          },
          [
            h('input', {
              key: 'c',
              type: 'checkbox',
              checked: selected.has(s.id),
              onChange: () => toggle(s.id),
              onClick: (e) => e.stopPropagation(),
              style: { accentColor: T.brand, flexShrink: 0, cursor: 'pointer' },
            }),
            h(
              'span',
              { key: 't', style: { fontSize: 13, color: T.label, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }, title: `${s.title ?? '未命名'}\n${s.id}\n${s.cwd ?? ''}` },
              s.title || `未命名 · ${shortId(s.id)}`,
            ),
            s.running ? h('span', { key: 'r', style: tagStyle(T.err) }, '运行中') : null,
            s.live && !s.running ? h('span', { key: 'lv', style: tagStyle(T.brand) }, '打开中') : null,
            s.origin === 'subagent' ? h('span', { key: 'sa', style: tagStyle(T.warn) }, '子代理') : null,
            h('span', { key: 'm', title: fmtDate(s.mtimeMs), style: { fontSize: 11, color: T.secondary, flexShrink: 0, width: 64, textAlign: 'right' } }, fmtAgo(s.mtimeMs)),
            h('span', { key: 's', style: { fontSize: 11, color: T.secondary, flexShrink: 0, width: 64, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, fmtSize(s.sizeBytes)),
            opts?.singleDelete
              ? h(
                  'span',
                  { key: 'dw', onClick: (e) => e.stopPropagation(), style: { display: 'inline-flex', flexShrink: 0 } },
                  h(ArmDeleteButton, {
                    armed: arm === s.id,
                    onArm: () => setArm(s.id),
                    onFire: () => fireSingleDelete(s.id),
                    busy,
                  }),
                )
              : null,
          ].filter(Boolean),
        )
      }

      const trashRow = (it) =>
        h(
          'div',
          { key: it.entry, className: 'sd-row', style: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px 5px 10px', minHeight: 32 } },
          [
            h(
              'span',
              { key: 't', style: { fontSize: 13, color: T.label, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }, title: `${it.id}\n${it.cwd ?? ''}` },
              it.id,
            ),
            h('span', { key: 'm', title: it.trashedAt ?? '', style: { fontSize: 11, color: T.secondary, flexShrink: 0, width: 64, textAlign: 'right' } }, fmtAgo(it.trashedAt ? Date.parse(it.trashedAt) : 0)),
            h('span', { key: 's', style: { fontSize: 11, color: T.secondary, flexShrink: 0, width: 64, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, fmtSize(it.sizeBytes)),
            h('button', { key: 'r', className: 'sd-btn', style: smallBtn, disabled: busy, onClick: () => fireRestore(it.entry) }, '还原'),
            h(ArmDeleteButton, {
              key: 'p',
              armed: arm === `t:${it.entry}`,
              onArm: () => setArm(`t:${it.entry}`),
              onFire: () => firePurge(it.entry),
              busy,
              label: '彻底删除',
            }),
          ],
        )

      // ---------- 页签内容（仅滚动列表区） ----------
      function ArchivedTab() {
        if (loading && list === null) return h('div', { style: { fontSize: 13, color: T.secondary, padding: '8px 0' } }, '加载中…')
        if (archivedSessions.length === 0) {
          return h('div', { style: { fontSize: 13, color: T.secondary, padding: '8px 0', lineHeight: '20px' } }, [
            h('div', { key: 'a' }, '没有已归档的会话。'),
            h('div', { key: 'b', style: { marginTop: 4 } }, '在侧栏会话上右键「归档会话」后，可在此处真正删除其磁盘记录。'),
          ])
        }
        return h('div', null, archivedSessions.map((s) => sessionRow(s, { singleDelete: true })))
      }

      function AllTab() {
        if (loading && list === null) return h('div', { style: { fontSize: 13, color: T.secondary, padding: '8px 0' } }, '加载中…')
        if (sessions.length === 0) return h('div', { style: { fontSize: 13, color: T.secondary, padding: '8px 0' } }, '没有可列出的会话')
        return h(
          'div',
          null,
          groups.size === 0
            ? h('div', { key: 'e', style: { fontSize: 13, color: T.secondary, padding: '8px 0' } }, '当前过滤条件下没有会话')
            : [...groups].map(([key, groupSessions]) => {
                const meta = groupMeta(key)
                return h(
                  'div',
                  { key: `g:${key}` },
                  [
                    h('div', {
                      key: 'h',
                      className: 'sd-grouphd',
                      onClick: () => toggleGroup(groupSessions),
                    }, [
                      h('input', {
                        key: 'c',
                        type: 'checkbox',
                        checked: groupSessions.every((s) => selected.has(s.id)),
                        onChange: () => toggleGroup(groupSessions),
                        onClick: (e) => e.stopPropagation(),
                        style: { accentColor: T.brand, cursor: 'pointer', flexShrink: 0 },
                      }),
                      h('span', { key: 'n', style: { fontSize: 12, fontWeight: 600, color: T.secondary, letterSpacing: 0.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: meta.path }, meta.name),
                      h('span', { key: 'i', style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))', flexShrink: 0 } }, `${groupSessions.length} 会话 · ${fmtSize(groupSessions.reduce((a, s) => a + (s.sizeBytes ?? 0), 0))}`),
                    ]),
                    ...groupSessions.map((s) => sessionRow(s, { indent: true, singleDelete: true })),
                  ],
                )
              }),
        )
      }

      function TrashTab() {
        if (loading && trash === null) return h('div', { style: { fontSize: 13, color: T.secondary, padding: '8px 0' } }, '加载中…')
        const items = trash ?? []
        return h(
          'div',
          null,
          items.length === 0
            ? h('div', { key: 'e', style: { fontSize: 13, color: T.secondary, padding: '8px 0' } }, '回收站为空')
            : items.map((it) => trashRow(it)),
        )
      }

      // ---------- 底部操作条 ----------
      function Footer() {
        if (tab === 'trash') {
          const items = trash ?? []
          if (items.length === 0) return null
          return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, borderTop: `1px solid ${T.border}`, paddingTop: 8, marginTop: 8, flex: 'none' } }, [
            h('span', { key: 'n', style: { fontSize: 12, color: T.secondary } }, `${items.length} 项 · ${fmtSize(items.reduce((a, i) => a + (i.sizeBytes ?? 0), 0))}`),
            h(
              'button',
              {
                key: 'p',
                className: 'sd-btn',
                style: { ...smallBtn, marginLeft: 'auto', background: purgeAllArmed ? T.err : 'transparent', borderColor: purgeAllArmed ? T.err : T.border, color: purgeAllArmed ? '#fff' : T.err, fontWeight: 600 },
                disabled: busy,
                onClick: () => (purgeAllArmed ? firePurgeAll() : setPurgeAllArmed(true)),
              },
              purgeAllArmed ? '确认清空（不可恢复）' : '清空回收站',
            ),
          ])
        }
        const rows = tab === 'archived' ? archivedSessions : filteredAll
        if (rows.length === 0) return null
        // 全选切换：作用于当前页签的可见行（归档页=全部归档；全部会话页=过滤+搜索后）
        const allSelected = rows.every((s) => selected.has(s.id))
        const toggleSelectAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((s) => s.id)))
        return h('div', { style: { borderTop: `1px solid ${T.border}`, paddingTop: 8, marginTop: 8, flex: 'none' } }, [
          h('div', { key: 'b', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
            h('span', { key: 'n', style: { fontSize: 12, color: T.secondary } }, busy ? `删除中 ${progress?.done ?? 0}/${progress?.total ?? 0}` : `已选 ${selected.size} 项 · ${fmtSize(selectedBytes(rows))}`),
            h(
              'button',
              { key: 'all', className: 'sd-btn', style: smallBtn, disabled: busy || loading, onClick: toggleSelectAll, title: allSelected ? '取消选择当前列表的全部会话' : '选中当前列表的全部会话（跟随过滤与搜索）' },
              allSelected ? '取消全选' : `全选 (${rows.length})`,
            ),
            selected.size > 0
              ? h('button', { key: 'c', className: 'sd-btn', style: smallBtn, disabled: busy, onClick: () => setSelected(new Set()) }, '清除')
              : null,
            h(
              'button',
              {
                key: 'd',
                className: 'sd-btn',
                style: { ...smallBtn, marginLeft: 'auto', background: selected.size > 0 ? T.err : 'transparent', borderColor: selected.size > 0 ? T.err : T.border, color: selected.size > 0 ? '#fff' : T.label, fontWeight: 600 },
                disabled: busy || selected.size === 0,
                onClick: () => fireBatchDelete([...selected]),
              },
              busy ? h('span', { className: 'sd-spin' }, '↻') : null,
              `删除所选 (${selected.size})`,
            ),
          ]),
        ])
      }

      // ---------- 固定工具区（不随列表滚动） ----------
      function Toolbar() {
        if (tab === 'all' && list !== null && sessions.length > 0) {
          const filterBtn = (id, label) =>
            h(
              'button',
              { key: id, className: 'sd-btn', style: { ...smallBtn, borderColor: filter === id ? T.brand : T.border, color: filter === id ? T.brand : T.secondary, fontWeight: filter === id ? 600 : 400 }, onClick: () => { setFilter(id); setSelected(new Set()) } },
              label,
            )
          return h(
            'div',
            { key: 'tb-all', style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', margin: '10px 0 0', flex: 'none' } },
            [
              h('input', { key: 'q', style: { ...inputStyle, width: 160 }, placeholder: '搜索标题 / id', value: query, onChange: (e) => setQuery(e.target.value) }),
              filterBtn('active', '未归档'),
              filterBtn('stale30', '30 天未动'),
              filterBtn('archived', '已归档'),
              filterBtn('all', '全部'),
              h('span', { key: 'n', style: { fontSize: 12, color: T.secondary, marginLeft: 'auto' } }, `${filteredAll.length} / ${sessions.length}`),
            ],
          )
        }
        if (tab === 'archived' && archivedSessions.length > 0) {
          return h(
            'div',
            { key: 'tb-arch', style: { fontSize: 12, color: T.secondary, margin: '10px 0 0', lineHeight: '18px', flex: 'none' } },
            [
              h('span', { key: 'a' }, `${archivedSessions.length} 个已归档会话 · 共 ${fmtSize(archivedSessions.reduce((a, s) => a + (s.sizeBytes ?? 0), 0))}；`),
              h('span', { key: 'b' }, '删除后进入回收站，可在「回收站」页签还原或彻底删除。'),
            ],
          )
        }
        return null
      }

      // ---------- 页面：头部区固定，仅列表滚动 ----------
      return h(
        'div',
        { className: 'sd-page', style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
        [
          h('div', { key: 'hd', style: { display: 'flex', alignItems: 'center', gap: 8, flex: 'none' } }, [
            h(
              'div',
              { key: 'tabs', style: { display: 'inline-flex', gap: 2, padding: 2, background: T.layer1, border: `1px solid ${T.border}`, borderRadius: 8 } },
              [
                tabBtn('archived', '归档会话', list ? archivedSessions.length : undefined),
                tabBtn('all', '全部会话', list ? sessions.length : undefined),
                tabBtn('trash', '回收站', trash ? trash.length : undefined),
              ],
            ),
            h(
              'button',
              { key: 'r', className: 'sd-btn', style: { ...smallBtn, marginLeft: 'auto' }, disabled: busy || loading, title: '重新加载', onClick: () => (tab === 'trash' ? loadTrash() : loadList()) },
              h('span', { className: loading || busy ? 'sd-spin' : undefined }, '↻'),
            ),
          ]),
          h(Toolbar, { key: 'tb' }),
          error ? h('div', { key: 'err', style: { fontSize: 13, color: T.err, padding: '8px 0', flex: 'none' } }, error) : null,
          h(NoticeBanner, { key: 'notice', notice, onClose: () => setNotice(null) }),
          h(
            'div',
            { key: 'body', style: { overflowY: 'auto', flex: 1, minHeight: 0, marginTop: 8 } },
            tab === 'archived' ? h(ArchivedTab) : tab === 'all' ? h(AllTab) : h(TrashTab),
          ),
          h(Footer, { key: 'ft' }),
        ],
      )
    }

    // =========================================================================
    // 注册壳：恒定 hooks + 自有错误边界 + nav 图标 retag
    // =========================================================================

    /** 设置面板 nav 行的显示文本（与注册 label 一致）。 */
    const NAV_LABEL = '归档会话'

    /**
     * 给设置面板 nav 行打 data-sd-nav 标记（幂等）。
     * 官方面板按 section id 硬编码 nav 图标（models/agent-presets/plugins），
     * 其余 id 一律回退为与设置入口相同的齿轮；注册协议没有 icon 字段。
     * 判定条件：按钮的直接子 span 文本 === NAV_LABEL 且按钮有 svg 直接子节点
     * （nav 行图标是 svg；本插件页签里的同名文本按钮没有 svg，不会误伤）。
     * 标记后由 CSS 隐藏齿轮、以 currentColor mask 画 16px 线性垃圾桶。
     */
    function tagNavButtons(root) {
      if (typeof document === 'undefined') return
      try {
        const scope = root ?? document
        const buttons = scope.querySelectorAll ? scope.querySelectorAll('button') : []
        for (const btn of buttons) {
          if (btn.hasAttribute('data-sd-nav')) continue
          const span = btn.querySelector(':scope > span')
          if (span && span.textContent === NAV_LABEL && btn.querySelector(':scope > svg')) {
            btn.setAttribute('data-sd-nav', '1')
          }
        }
      } catch {
        /* retag 失败只影响图标，不影响功能 */
      }
    }

    /** 渲染错误兜底：把「一片空白」变成可见的错误信息（SlotErrorBoundary 只渲染空 div）。 */
    class SectionErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      componentDidCatch(error) {
        console.error('[dsh-session-delete] 设置页渲染失败:', error)
      }
      render() {
        if (this.state.error !== null) {
          return h(
            'div',
            { style: { fontSize: 13, color: T.err, lineHeight: '20px', padding: '12px 0' } },
            [
              h('div', { key: 't', style: { fontWeight: 600 } }, '「归档会话」页渲染失败'),
              h('div', { key: 'm', style: { color: T.secondary } }, String(this.state.error?.message ?? this.state.error)),
              h(
                'button',
                {
                  key: 'r',
                  className: 'sd-btn',
                  style: { ...btnBase, marginTop: 8 },
                  onClick: () => this.setState({ error: null }),
                },
                '重试',
              ),
            ],
          )
        }
        return this.props.children
      }
    }

    /**
     * 注册进 settings.section 的组件：
     * - 恒定调用 useSessions（不用条件式 hook，遵守 hooks 规则）；
     * - 自有 ErrorBoundary 兜底渲染错误。
     */
    function ArchiveSettingsSection(props) {
      const useSessionsHook = props?.useSessions ?? ((selector) => selector(undefined))
      const currentId = useSessionsHook((s) => s?.current)
      return h(SectionErrorBoundary, null, h(SettingsPage, { close: props?.close, currentId }))
    }

    // ---------- 注册 ----------
    function apply(ctx) {
      workspacesService = ctx.workspaces
      ctx.effect(() => {
        const el = document.createElement('style')
        el.id = 'dsh-session-delete-styles'
        el.textContent = CSS
        document.head.appendChild(el)
        return () => el.remove()
      })
      // 常驻 nav 图标 retag：设置面板每次打开/切换 section 都会重建 nav 行 DOM，
      // 依赖组件渲染时机调度会漏（未选中本页时组件根本不渲染）。观察 DOM 变化，
      // 按钮一出现就打标——开销极小（只查新增节点里的 button）。
      ctx.effect(() => {
        if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType !== 1) continue
              if (node.tagName === 'BUTTON') tagNavButtons(node)
              else if (node.querySelectorAll) tagNavButtons(node)
            }
          }
        })
        observer.observe(document.body, { childList: true, subtree: true })
        tagNavButtons()
        return () => observer.disconnect()
      })
      ctx.effect(() =>
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'session-delete', order: 20, label: () => NAV_LABEL }, ArchiveSettingsSection),
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots', 'workspaces']
    exports.SettingsPage = SettingsPage
    exports.ArchiveSettingsSection = ArchiveSettingsSection
    return module.exports
  },
})
