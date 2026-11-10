window.__ModuleLoader__.load({
  id: 'zidongxupao',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const inject = ['slots']
    const API_PATH = '/api/zidongxupao'
    const STYLE_ID = 'zidongxupao-style'

    function ensureStyle() {
      let style = document.getElementById(STYLE_ID)
      if (!style) {
        style = document.createElement('style')
        style.id = STYLE_ID
        document.head.appendChild(style)
      }
      style.textContent = [
        '.zxp-notice{box-sizing:border-box;width:calc(100% - 2 * var(--dsh-composer-side-clearance,16px) - 4 * var(--dsh-composer-dock-inset,8px));max-width:calc(var(--dsh-composer-card-max-width,952px) - 4 * var(--dsh-composer-dock-inset,8px));margin:0 auto;display:flex;align-items:center;gap:10px;padding:7px 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l3,#d9dee5) 82%,transparent);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f7f8fa);color:var(--dsw-alias-label-primary,#20242a);font:12px/1.45 var(--dsw-font-family,system-ui,sans-serif)}',
        '.zxp-notice[data-tone="warning"]{border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#b7791f) 42%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#b7791f) 9%,var(--dsw-alias-bg-base,#fff))}',
        '.zxp-notice span{flex:1;min-width:0}',
        '.zxp-notice button{border:1px solid var(--dsw-alias-border-l3,#d9dee5);border-radius:8px;padding:4px 9px;background:var(--dsw-alias-bg-base,#fff);color:inherit;font:inherit;cursor:pointer}',
        '.zxp-notice button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f0f2f5)}',
        '.zxp-notice button:disabled{opacity:.48;cursor:default}',
      ].join('')
    }

    function reasonText(reason) {
      const labels = {
        'attempt-limit': '已达到自动续跑次数上限',
        'tool-call-attempt-limit': '该轮已执行工具，达到工具轮安全续跑上限',
        'provider-delay-too-long': '上游要求的等待时间过长，未自动重试',
        'goal-exhausted': 'Goal 轮次额度已用完',
        'goal-not-active': 'Goal 已暂停或结束',
        'goal-changed': 'Goal 已变更，旧续跑请求作废',
        'goal-start-timeout': 'Goal 恢复后未开始执行',
        'goal-unavailable': '无法读取 Goal 状态，本次未自动重试',
        'tool-state-unavailable': '无法读取工具调用记录，本次未自动重试',
        'user-cancelled': '已取消本次自动续跑',
        'queued-human-message': '检测到新的用户消息，已取消自动续跑',
        'new-turn-started': '新轮次已经开始，已取消自动续跑',
        'agent-not-idle': 'Agent 已不处于空闲状态',
        'session-disposed': '会话已关闭',
        'agent-disposed': 'Agent 已关闭',
        'timer-failed': '计时器启动失败',
        'followup-failed': '无法投递续跑消息',
        'message-build-failed': '无法生成续跑消息',
      }
      if (labels[reason]) return labels[reason]
      if (typeof reason === 'string' && reason.startsWith('goal-resume-failed:')) return 'Goal 恢复失败'
      return reason || '自动续跑已停止'
    }

    function AutoResumeNotice(props) {
      const sessionId = props?.sessionId || ''
      const result = React.useState({ status: null, error: '' })
      const data = result[0]
      const setData = result[1]
      const busyBox = React.useState(false)
      const busy = busyBox[0]
      const setBusy = busyBox[1]
      const dismissedBox = React.useState('')
      const dismissed = dismissedBox[0]
      const setDismissed = dismissedBox[1]

      React.useEffect(function () {
        if (!sessionId) return undefined
        setData({ status: null, error: '' })
        setDismissed('')
        let stopped = false
        let timer
        const controller = new AbortController()
        async function load() {
          if (!document.hidden) {
            try {
              const response = await fetch(API_PATH + '?' + new URLSearchParams({ sessionId }), {
                signal: controller.signal,
              })
              const value = await response.json()
              if (!stopped) setData({ status: response.ok && value.ok ? value.status : null, error: value.error || '' })
            } catch (error) {
              if (!stopped && error?.name !== 'AbortError') {
                setData(previous => ({ ...previous, error: '读取自动续跑状态失败' }))
              }
            }
          }
          if (!stopped) timer = setTimeout(load, 1000)
        }
        void load()
        return function () {
          stopped = true
          controller.abort()
          clearTimeout(timer)
        }
      }, [sessionId])

      const status = data.status
      if (!status || !sessionId) return null
      const signature = sessionId + ':' + status.phase + ':' + (status.blockedReason || '') + ':' + status.delivered
      if (dismissed === signature && (status.phase === 'idle' || status.gaveUp)) return null
      if (status.phase === 'idle' && !status.blockedReason) return null

      async function cancel() {
        if (busy) return
        setBusy(true)
        try {
          const response = await fetch(API_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, action: 'cancel' }),
          })
          const value = await response.json()
          if (!response.ok || !value.ok) throw new Error(value.error || '取消失败')
          setData({ status: value.status, error: '' })
        } catch (error) {
          setData(previous => ({ ...previous, error: String(error?.message || error) }))
        } finally {
          setBusy(false)
        }
      }

      let text
      if (status.phase === 'waiting') {
        const seconds = Math.max(1, Math.ceil((status.remainingMs || 0) / 1000))
        text = `自动续跑第 ${status.attempt}/${status.maxAttempts} 次将在约 ${seconds} 秒后执行 · ${status.failureCode}` +
          (status.hadToolCalls ? ' · 含工具调用' : '')
      } else if (status.phase === 'queued') {
        text = `自动续跑第 ${status.attempt}/${status.maxAttempts} 次已排队，等待其他续跑结束 · ${status.failureCode}`
      } else if (status.phase === 'running') {
        text = `自动续跑第 ${status.delivered}/${status.maxAttempts} 次正在执行 · ${status.failureCode}`
      } else {
        text = '自动续跑已停止：' + reasonText(status.blockedReason)
      }
      const warning = status.phase === 'idle' || status.gaveUp || status.hadToolCalls

      return h('div', { className: 'zxp-notice', 'data-tone': warning ? 'warning' : 'normal', role: 'status' },
        h('span', null, data.error ? text + ' · ' + data.error : text),
        (status.phase === 'waiting' || status.phase === 'queued')
          ? h('button', { type: 'button', disabled: busy, onClick: cancel }, busy ? '取消中…' : '取消本次')
          : null,
        (status.phase === 'idle' || status.gaveUp)
          ? h('button', { type: 'button', onClick: () => setDismissed(signature) }, '隐藏')
          : null,
      )
    }

    function ComposerDock(props) {
      return h(AutoResumeNotice, props)
    }

    function apply(ctx) {
      ensureStyle()
      ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'zidongxupao-status',
        order: 28,
        label: '自动续跑状态',
      }, ComposerDock)), 'zidongxupao.status-dock')
    }

    return { inject, apply }
  },
})
