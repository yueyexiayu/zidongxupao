# zidongxupao（自动续跑）

DSH Desktop 本地插件。整轮请求因可重试的上游失败而结束时，在随机延迟后自动续跑；默认每 30–60 秒一次、每个 Agent 最多 3 次，并全局串行执行。

## 为什么需要它

DSH 核心对失败轮保持 fail-closed：`agent/error` 出现后，没有层会自行补发一轮。OpenCode 上游常返回 429、`overloaded` 或 `prefill_cap_refused`，轮内 `llm-retry` 用完后，本插件补上整轮恢复。它不改 DSH 核心、profile 中既有 `retryPolicy` 或 goal driver。

## 触发规则

- 只处理 `error instanceof LlmError`，失败码默认与运行时 `resolveRetryPolicy(undefined).retryableCodes` 对齐。
- 可用 `retryableCodes` 显式覆盖，例如加入当前手动继续策略支持的 `STREAM_CLOSED`。
- `QUOTA`、`AUTH`、凭据错误、上下文超限等结构性失败不会触发；普通 `Error` 也不会。
- 默认包含子代理；可用 `applyToSubagents: false` 关闭。
- 有用户输入、新的 turn、目标已经被其他 owner 接管、Agent/Session 关闭或插件卸载时，等待中的续跑会取消。

## 计数与并发

- 只有在续跑消息真正投递成功后才消耗一次额度；取消计时器、排队中被取消或投递失败都不消耗额度。
- 普通失败默认最多连续续跑 3 次。发生过 `tool/call` 的轮次默认不自动续跑，避免整轮重放 shell、写文件、MCP 或外部 API 副作用；确认安全后可把 `maxConsecutiveAfterToolCalls` 设为正值显式开启。
- 默认 `maxActive: 1`，全局同一时间只运行一个自动续跑轮次。等待倒计时本身不占槽；多个计时器到点后按 FIFO 取得执行槽，当前轮结束后才启动下一项。
- 任一次成功或用户中止的 turn 会清零连续次数。非可重试的结构性失败同样会结束当前连续恢复链。

## 等待与取消

- 普通等待在 `minDelayMs`–`maxDelayMs` 内均匀随机，默认 30000–60000ms。
- `LlmError.failure.providerRetryAfterMs` 有效时作为下界；即使超过本地 `maxDelayMs` 也会遵守。默认超过 15 分钟或 Node 定时器安全上限时停止本次自动续跑，避免数小时或数天的任务长期滞留在队列里。
- 输入框上方的 dock 会显示等待倒计时、排队状态或正在执行状态；等待和排队阶段可直接“取消本次”。
- 客户端通过 `/api/zidongxupao?sessionId=...` 读取状态，通过同一路径的 `POST { action: "cancel" }` 取消待执行项。该接口只暴露当前进程中的非敏感调度信息。

## 续跑消息与 Goal

- 普通续跑消息以带明确“自动续跑”标记的普通 `user` 消息投递。这样自动轮次再次失败后，DSH 原生“继续”入口仍然可用。
- 文本只包含次数、失败码和实际等待秒数，不包含错误 message、请求 id 或凭据。
- 失败来自 active goal 时，插件到点调用 `goals.resume(agent, { id, revision })` 恢复原 goal，不会额外注入普通用户消息。Goal 已变更、暂停、结束、额度耗尽或已由其他 owner arm 时，本次自动续跑会停止。
- Goal 服务在失败捕获阶段读取异常时按 fail-closed 停止，不会把未知状态降级成普通续跑。
- 等待期间新出现 Goal、Goal revision 变化或已绑定 Goal 消失时，也会停止，不降级为普通续跑。
- Goal 恢复后 15 秒仍没有进入 running 状态时，插件释放全局槽并停止该次恢复。

## 配置

```yaml
- id: zidongxupao
  config:
    enabled: true
    minDelayMs: 30000
    maxDelayMs: 60000
    maxConsecutive: 3
    maxConsecutiveAfterToolCalls: 0
    maxActive: 1
    maxProviderDelayMs: 900000
    applyToSubagents: true
    honorProviderRetryAfter: true
    resumeGoals: true
    includeSessionIds: []
    excludeSessionIds: []
    # retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]
```

未知键、负数、超过 Node 定时器安全上限的延迟、空失败码数组、无效整数或布尔值都会让插件加载失败（`INVALID_CONFIG`）。`includeSessionIds` 与 `excludeSessionIds` 同时命中时，排除优先。

## 加载方式

作为 desktop profile bundle 加载：

- `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 使用 `"zidongxupao": "link:/Users/ning/.dsh/plugins/zidongxupao"`；
- `dsh.profile.bundles` 加入 `"zidongxupao"`；
- 本包自带 `cordis.patch.yml` 负责 insert；不要在 desktop patch 再 insert 同一 id；
- 改完完全退出 DSH（⌘Q）再打开，Host 与 client 代码才会一起重新加载。

## 测试

```sh
cd ~/.dsh/plugins/zidongxupao
npm test
npm run typecheck
```

测试覆盖失败分类、运行时失败码来源、Provider Retry-After、取消不消耗额度、全局并发队列、工具轮安全上限、子代理排除、goal 恢复、非重试错误清零、状态 API、客户端 dock、卸载清理和真实计时器投递。

## 已知边界

- 等待、队列和连续次数只在内存中，进程重启后不会补发重启前未到期的任务。
- 自动续跑仍是整轮恢复。含工具调用的轮次默认不自动恢复；显式开启后，模型仍须依据已有历史避免重复副作用，本插件不提供工具事务或副作用回滚。
- 只处理 `agent/error` 的 `LlmError`；普通工具失败、压缩失败和其他 `Error` 不会触发。
- 无法读取当前轮的 tool/call 历史时会停止本次自动续跑；只有明确确认没有工具调用时才允许普通轮续跑。
- 客户端 dock 依赖 DSH 的 `conversation.input.dock` 槽位；Host 侧自动续跑本身不依赖这个 UI。
