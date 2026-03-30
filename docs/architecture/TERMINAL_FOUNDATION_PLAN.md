# Terminal Foundation Plan

## Background

本文档只讨论 Remux 的基座能力，不讨论分屏、浮窗、标签栏样式、AI 工具栏等产品功能。

关注范围严格限定为：

- PTY 输出如何进入 authoritative terminal state
- terminal state 如何被 transport 给多个 viewer
- 前端如何刷新、重连、恢复、避免闪烁和抖动
- 多 viewer / 多设备 / 刷新重进时如何保持 session truth 一致
- resize / reflow / scrollback / cursor / wide char 如何稳定处理

参考实现主要来自：

- `tmux`
- `zellij`

目标不是照搬它们的产品形态，而是学习它们在 redraw、reflow、backpressure、session sync、viewport 恢复这些底层实现上的成熟做法。

## Non-goals

本文档明确不包含以下内容：

- 新增 pane split、floating pane、布局编排等产品功能
- 视觉重构
- 插件系统、AI 能力、快捷操作条
- 与基座稳定性无关的杂项 UI 优化

## Current Baseline

Remux 当前已经具备一批正确的基础能力：

- Rust runtime 已维护 pane 级 terminal state，并可生成 snapshot / replay bytes
- gateway 已有 `sequence + snapshot + buffered delta replay`
- 前端 xterm 已有 `requestAnimationFrame` 级写缓冲
- 前端已有 resize debounce、keepalive、terminal reconnect、local echo prediction
- control plane 已和 terminal plane 分离
- workspace state 已通过 `useDeferredValue` 降低 React 树刷新压力

当前主链路大致为：

1. PTY 输出进入 Rust `TerminalState`
2. runtime 发送 `stream` 或 `snapshot`
3. Node gateway 在 `SharedRuntimeV2PaneBridge` 中做 attach / resize / replay / buffer
4. browser 收到 bytes 后直接写入 xterm
5. reconnect 或 resize 时通过 snapshot + replay 复位当前 viewer

这条链路已经能工作，但和 `tmux` / `zellij` 相比，仍有几个结构性短板：

- authoritative truth 还没有彻底和 viewer presentation 解耦
- fast path 仍偏向 `reset + replay`，而不是 `state diff + transactional present`
- 多 viewer 同看同一 pane 时，viewer 的 resize 仍会反向扰动 upstream PTY truth
- 没有 viewer 级 outbound queue、公平调度和明确的 backlog 降级策略
- 前端虽然有 RAF write buffer，但仍是“单帧内尽量吐完”，缺少 frame budget
- resize 后的 reflow 仍不够结构化，尤其在宽度变化、wide char、cursor 定位、多设备切换时
- control socket 和 terminal socket 之间还缺少显式的 shared revision / epoch 绑定

## External Lessons

### tmux

`tmux` 最值得学习的是它的输出纪律和 redraw discipline：

- 它把 pane screen 作为 authoritative virtual screen
- 它会在 redraw 前后使用 synchronized update，尽量避免用户看到半帧
- 它对慢 client 有成熟的 backpressure / discard / pause / continue 机制
- 它在 control mode 下维护 per-pane offsets 和公平输出队列
- 它非常强调“先维护 server-side screen truth，再决定如何对 client redraw”

### zellij

`zellij` 最值得学习的是它的结构化 viewport model：

- `Grid` 维护 canonical lines，而不是只维护“当前宽度下的可见文本”
- `change_size()` 会在 resize 时重排 canonical lines，尽量保留 cursor、scrollback、wide char 语义
- `OutputBuffer` 记录 dirty lines，只输出 changed chunks
- `TerminalPane` 的 render path 更接近“基于 authoritative grid 生成 display diff”
- 有定期 serialization / resurrection 的长期恢复路径

## Architecture Direction

Remux 的长期正确方向应当是：

`PTY raw bytes -> authoritative terminal model -> viewer-specific render plan -> paced transport -> transactional present`

而不是：

`PTY raw bytes -> snapshot/replay bytes -> browser reset/write -> 依赖 xterm 当前状态碰运气`

snapshot 和 replay 不应消失，但应退化为：

- 新 viewer 首次 attach 的冷启动兜底
- 丢包、backlog 过大、parser recover、epoch 切换时的重同步兜底

它们不应继续承担 steady-state live rendering 的主路径职责。

## Program Overview

整个计划分为 7 个 workstreams：

1. Authoritative Terminal Truth
2. Diff Transport
3. Resize Ownership And Reflow
4. Backpressure And Anti-jitter
5. Control/Terminal Revision Sync
6. Persistence And Resurrection
7. Testing, Metrics, Rollout

以下所有事项默认都列为待办。

## Current Status Snapshot

截至 `v0.2.52-dev` 这一轮，基座主线已经从“纯 raw stream + snapshot/replay”往前推进了一段，但还没有到 `tmux` / `zellij` 那种 Rust authoritative diff/render 完整态。

已经落地的关键项：

- `terminal_patch` transport 已接通，browser 会协商 patch fast path
- control plane 与 terminal plane 已通过 `viewRevision` 绑定
- terminal reconnect 已支持 `baseRevision` continuation
- authoritative resize owner 已落地，passive viewer 不再直接扰动 upstream PTY size
- viewer 级 queue / high-low watermark / fresh snapshot 降级已落地
- frontend terminal write path 已改成 budgeted flush + xterm write callback 串行推进
- `terminal_patch` 已补 `epoch`，前端现在按 `viewRevision + epoch + revision/baseRevision` 一起判定 patch lineage
- inspect / `tab_history` / client diagnostic 已显式绑定 `viewRevision`，旧视图响应与旧诊断会被丢弃
- 新 viewer / stale continuation fallback 已改成“当前组合快照”路径，不再先发旧 snapshot 再补 replay backlog
- bandwidth stats 已显式暴露 rebuilt snapshot、continuation resume、continuation fallback 计数
- bandwidth telemetry 现在会忽略非有限数值输入，避免异常样本把总量与 RTT 污染成 `NaN`
- bandwidth stats modal 现在直接展示 continuation attempts / success rate / fallback rate，便于快速看出重连命中率
- `BandwidthTracker` 已有单测覆盖 rolling window、continuation 计数、异常输入清洗
- runtime-v2 的 patch / resize owner / reconnect / slow viewer 已有后端、集成和 browser 回归测试

部分完成但仍未收口的项：

- terminal diff transport 已有协议外壳，但 Rust 侧还没有真正产出 dirty lines / dirty chunks
- gateway 仍承担了一部分 replay / continuation 语义，authoritative truth 还没有完全收敛回 Rust
- telemetry 已开始覆盖 snapshot/diff/queue pressure 等 runtime-v2 指标，但距离完整 foundation telemetry 还差一段
- transaction-style present 已推进到“reset snapshot 在原子写前一刻再 reset”，但距离真正的 synchronized redraw boundary 仍有差距

仍然待办的大项：

- canonical line model 与结构化 resize reflow
- transaction-style present / synchronized redraw boundary
- persistence / resurrection / daemon restart recovery
- 更完整的真实网页回归矩阵和 foundation telemetry

## Workstream 1: Authoritative Terminal Truth

### Goal

把 terminal truth 彻底收敛到 Rust runtime，gateway 只保留 transport / fan-out / policy 职责，不再承担“主要 terminal state 推断器”的角色。

### Why

当前 authoritative terminal state 实际上已经在 Rust runtime 中，但 browser 最终仍主要依赖 raw bytes + snapshot replay 达到显示效果。Node gateway 的 `SharedRuntimeV2PaneBridge` 仍承担了大量 replay、cursor tracker、buffer retain 责任。

这会带来两个问题：

- state truth 分层不够清晰
- 后续 diff render、viewer-specific render、epoch 管理很难做干净

### TODO

- [ ] 明确 runtime 是唯一 authoritative terminal state owner
- [ ] 保持 Node gateway thin，不新增更多 terminal semantics 到 TS bridge
- [ ] 把未来的 dirty region / dirty line / render diff 逻辑优先做在 Rust `remux-terminal` / `remux-server`
- [ ] 重新审视现有 TS `TerminalStateTracker` 原型，保留其思想，不保留其落点
- [ ] 为 authoritative terminal state 增加明确 revision 概念
- [ ] 为 terminal snapshot 增加 explicit epoch / revision / source size 元数据

### Primary Code Targets

- `crates/remux-terminal/src/lib.rs`
- `crates/remux-server/src/lib.rs`
- `crates/remux-protocol/src/lib.rs`
- `src/backend/server-v2.ts`
- `src/backend/terminal-state/tracker.ts`

### Acceptance

- gateway 不再需要依赖额外 headless terminal 才能完成 steady-state rendering
- terminal diff 和 snapshot 均由 Rust authoritative model 直接产出
- TS bridge 不再成为 terminal correctness 的第二真相来源

## Workstream 2: Diff Transport

### Goal

引入真正的 diff-based terminal transport，把 `snapshot + replay` 从主路径降为 fallback。

### Why

这是当前和 `tmux` / `zellij` 的最大差距，也是收益最大的改动。

如果 steady-state 仍以 raw bytes 为主，那么：

- reconnect 时容易整屏 reset
- resize 时容易整屏重播
- 慢设备容易累积 backlog
- browser 会承担不必要的 decode / parse / repaint 压力

### TODO

- [ ] 设计新的 terminal transport 消息：`terminal_patch`
- [ ] patch 至少包含以下信息：
- [ ] `epoch`
- [ ] `revision`
- [ ] `paneId`
- [ ] `cols`
- [ ] `rows`
- [ ] dirty lines 或 dirty chunks
- [ ] cursor position
- [ ] clear / reset / full snapshot 标志
- [ ] 定义 full snapshot 与 incremental patch 的切换条件
- [ ] 让 runtime 能直接产出“changed lines since revision N”
- [ ] viewer attach 时支持“若 revision 可衔接则发 patch，否则发 fresh snapshot”
- [ ] backlog 过大时允许主动放弃中间 patch，直接切 fresh snapshot
- [ ] 保留现有 raw stream 协议一段过渡期，用 feature flag 双跑

### Primary Code Targets

- `crates/remux-terminal/src/lib.rs`
- `crates/remux-server/src/lib.rs`
- `crates/remux-protocol/src/lib.rs`
- `src/backend/v2/types.ts`
- `src/backend/v2/wire.ts`
- `src/backend/server-v2.ts`
- `src/frontend/App.tsx`
- `src/frontend/hooks/useTerminalRuntime.ts`

### Acceptance

- steady-state live output 默认走 patch，不走 full reset/replay
- reconnect 后大多数情况下不会出现整屏闪白/闪黑/清屏重播
- bandwidth stats 中 full snapshot 次数显著下降

## Workstream 3: Resize Ownership And Reflow

### Goal

把“谁有权改变 PTY size”和“viewer 自己看到的宽度”解耦，并引入结构化 reflow。

### Why

这是多 viewer 场景下最容易制造抖动的问题。

当前同一 pane 被桌面和手机同时看时，viewer 的 resize 会直接改变 upstream PTY size，导致：

- 长行突然重排
- prompt / output wrap 反复变化
- passive viewer 只是看，也会影响 active writer
- 首屏恢复内容与 live output 的宽度感知容易不一致

### TODO

- [ ] 明确定义 authoritative resize owner
- [ ] authoritative resize owner 默认为当前 write lease holder
- [ ] passive viewer 不得改变 upstream PTY size
- [ ] passive viewer 通过 local reflow / local viewport fitting 消化宽度差异
- [ ] runtime terminal state 增加 canonical line 概念
- [ ] resize 时保留 canonical lines，再按新宽度切分 visible rows
- [ ] 正确处理以下特殊情况：
- [ ] wide char
- [ ] wrapped rows
- [ ] cursor at EOL
- [ ] alternate screen
- [ ] scrollback 与 viewport 边界
- [ ] resize 后补充 fresh diff，不默认触发 hard reset
- [ ] 审视现有 `latest|largest|smallest` policy，改为以 lease/role 为中心的 policy

### Primary Code Targets

- `src/backend/server-v2.ts`
- `crates/remux-terminal/src/lib.rs`
- `crates/remux-server/src/lib.rs`
- `docs/adr/ADR_RUNTIME_V2_WRITE_LEASE_POLICY.md`

### Acceptance

- 桌面 viewer 和手机 viewer 同时连接时，只有 authoritative viewer 能驱动 PTY size
- passive viewer 不再导致 upstream width 抖动
- resize 后长行、prompt、cursor、wide char 保持稳定

## Workstream 4: Backpressure And Anti-jitter

### Goal

建立 viewer 级 pacing、watermark、降级和 transactional present，解决慢设备卡顿、半帧显示和 reconnect 突刺。

### Why

当前 browser 端虽然有 RAF write buffer，但本质上仍是“下一个动画帧把 pending 都写掉”。这对小流量够用，对 snapshot replay、长 scrollback、弱网、手机 CPU 来说不够。

### TODO

- [ ] 为每个 viewer 引入独立 outbound queue
- [ ] 记录 per-viewer queued bytes、last sent revision、last acked revision
- [ ] 定义 queue 高低水位
- [ ] backlog 超过高水位时停止追加旧 patch，改发 fresh snapshot
- [ ] viewer 恢复后允许从 fresh snapshot 重新对齐
- [ ] frontend terminal write path 改成 budgeted flush
- [ ] 每帧限制最大 bytes 或最大执行时长
- [ ] 使用 xterm write callback 串行推进大 replay
- [ ] 避免单帧内吞下整份大 snapshot + tail stream
- [ ] 引入 transaction boundary 概念
- [ ] 若 renderer 支持 synchronized output，则包裹 begin/end
- [ ] 若 renderer 不支持，则至少做到“逻辑帧内一次 present”
- [ ] 为 snapshot replay、resize replay、reconnect replay 单独打点

### Primary Code Targets

- `src/backend/server-v2.ts`
- `src/backend/stats/bandwidth-tracker.ts`
- `src/frontend/terminal-write-buffer.ts`
- `src/frontend/hooks/useTerminalRuntime.ts`
- `src/frontend/App.tsx`

### Acceptance

- 大 replay 时主线程卡顿显著下降
- reconnect 后不再出现明显的“半屏先出来，再补另一半”的观感
- 弱网或慢设备 viewer 不会无限积压旧输出

## Workstream 5: Control/Terminal Revision Sync

### Goal

给 control plane 和 terminal plane 建立显式的 revision / epoch 绑定，避免 session / tab / pane 切换时出现短暂错位。

### Why

当前 control socket 和 terminal socket 是分离的，这是正确的；但如果没有 shared revision，前端只能靠时序经验判断“当前 terminal 数据是否还属于当前 pane”。

### TODO

- [ ] control `workspace_state` 增加 `viewRevision`
- [ ] terminal attach / snapshot / patch 增加 `viewRevision`
- [ ] 每次 session/tab/pane retarget 时 bump revision
- [ ] browser 收到旧 revision terminal 数据时直接丢弃
- [ ] attach / close / retarget / snapshot / patch 全部打 revision 日志
- [ ] inspect / diagnostics 若依赖当前 pane，也绑定 revision

### Primary Code Targets

- `src/backend/server-v2.ts`
- `src/backend/v2/types.ts`
- `src/frontend/App.tsx`
- `src/frontend/hooks/useWorkspaceState.ts`

### Acceptance

- session/tab/pane 快速切换时，terminal 不会短暂显示旧 pane 内容
- refresh 恢复过程中，workspace state 与 terminal replay 的归属一致

## Workstream 6: Persistence And Resurrection

### Goal

补齐 daemon 重启、runtime 重建、前端硬刷新后的长期恢复路径。

### Why

`tmux` 和 `zellij` 的长期稳定性不只来自 live path，也来自 crash/restart/resurrection 能力。

### TODO

- [ ] 定期序列化 session layout、pane metadata、authoritative terminal snapshot metadata
- [ ] 明确哪些数据是 machine truth，哪些只是 viewer cache
- [ ] daemon 冷启动后优先恢复 machine truth，再允许 viewer attach
- [ ] 为 resurrection 数据定义版本号
- [ ] 老版本 resurrection 数据不兼容时要安全降级
- [ ] 明确持久化频率、触发条件和最大体积
- [ ] 将持久化与 live path 解耦，避免 serialization 阻塞实时输出

### Primary Code Targets

- `crates/remux-store/src/lib.rs`
- `crates/remux-session/src/lib.rs`
- `crates/remux-server/src/lib.rs`
- `docs/adr/ADR_RUNTIME_V2_PERSISTENCE_POLICY.md`

### Acceptance

- runtime 进程重启后，session layout 和 pane 基本信息可恢复
- 若 terminal live state 无法恢复，也能安全退化到 fresh snapshot 路径

## Workstream 7: Testing, Metrics, Rollout

### Goal

让上述改造可以安全落地，而不是靠一次性大改碰运气。

### TODO

- [ ] 为 terminal diff transport 增加 unit tests
- [ ] 为 resize reflow 增加 Rust 侧宽字符、wrap、cursor 测试
- [ ] 为 authoritative resize owner 增加多 viewer integration tests
- [ ] 为 backlog 降级策略增加 slow viewer tests
- [ ] 为 reconnect + revision sync 增加 integration tests
- [ ] 为 browser 端 write budget 增加 frontend tests
- [ ] 为真实网页宽度专项验收增加以下场景：
- [ ] 首屏恢复后宽度正确
- [ ] live output 跟随同一宽度
- [ ] 桌面与手机同时连接不相互扰动
- [ ] retarget session/tab/pane 后无旧内容串屏
- [ ] 扩展 telemetry：
- [ ] full snapshots sent
- [ ] incremental patches sent
- [ ] replay bytes
- [ ] dropped patches
- [ ] stale revision drops
- [ ] viewer queue high watermark hits
- [ ] average replay-to-live latency

### Primary Code Targets

- `tests/integration/runtime-v2-gateway.test.ts`
- `tests/e2e/terminal-width.spec.ts`
- `tests/frontend/terminal-write-buffer.test.ts`
- `tests/frontend/terminal-renderer.test.ts`
- `tests/backend/runtime-v2-pane-bridge.test.ts`
- `src/backend/stats/bandwidth-tracker.ts`

### Acceptance

- 新链路具备 feature flag
- 旧链路仍可回退
- 关键回归都可在 CI 与真实网页验收里复现

## Suggested Milestones

### Milestone 0: Observability First

- [ ] 先补 telemetry 和 debug fields
- [ ] 给 control / terminal / replay / resize 全链路增加 revision / queue / lag 日志
- [ ] 不改协议行为，先把基线量出来

### Milestone 1: Resize Ownership

- [ ] 引入 authoritative resize owner
- [ ] 阻止 passive viewer 改 upstream PTY size
- [ ] 保持旧 snapshot/replay 路径不变

### Milestone 2: Rust Diff Prototype

- [ ] 在 Rust runtime 内产出 dirty lines / dirty chunks
- [ ] 新协议 behind feature flag
- [ ] gateway 支持 snapshot fallback + patch fast path

### Milestone 3: Frontend Budgeted Present

- [ ] browser 支持 patch apply
- [ ] 大 replay 改为 budgeted flush
- [ ] 加 transaction boundary

### Milestone 4: Canonical Reflow

- [ ] canonical lines
- [ ] resize reflow
- [ ] wide char / cursor / scrollback correctness

### Milestone 5: Resurrection

- [ ] 定期 serialization
- [ ] daemon restart recovery

## Full TODO Checklist

### P0

- [ ] authoritative terminal truth 收敛到 Rust runtime
- [ ] 新增 revision / epoch 概念
- [ ] 设计 `terminal_patch` 协议
- [ ] 引入 dirty lines / dirty chunks transport
- [ ] authoritative resize owner
- [ ] passive viewer 不改 upstream PTY size
- [ ] viewer 级 outbound queue
- [ ] viewer queue watermark 与 fresh snapshot 降级
- [ ] browser write budget
- [ ] transaction-style present
- [ ] control/terminal shared revision

### P1

- [ ] canonical line model
- [ ] resize reflow
- [ ] wide char correctness
- [ ] cursor at EOL correctness
- [ ] scrollback/viewport stability
- [ ] reconnect by revision continuation
- [ ] feature flag 双跑
- [ ] telemetry 扩展

### P2

- [ ] 周期性 session serialization
- [ ] resurrection store versioning
- [ ] daemon restart recovery
- [ ] 更细粒度 render diff（从 line 级进一步降到 chunk/cell 级）

## Implementation Notes

### Notes On Existing Code

以下现有实现应保留并逐步吸收，而不是粗暴推翻：

- Rust `TerminalState` 的 snapshot / replay 架构
- gateway 的 sequence 与 retained chunk 概念
- browser 的 resize debounce
- browser 的 local echo prediction
- `useDeferredValue` 对 workspace tree 的降抖

### Notes On Existing Gaps

以下现有实现应视为过渡方案：

- `reset + replay` 作为 steady-state 主路径
- `latest|largest|smallest` 这样的 viewer-size-driven upstream size policy
- TS bridge 内承担过多 terminal correctness 责任
- RAF 内无预算地 flush 全部 pending terminal writes

## Recommended First Code Changes

建议第一批改动不要超过以下范围：

- `crates/remux-protocol`
- `crates/remux-terminal`
- `crates/remux-server`
- `src/backend/server-v2.ts`
- `src/frontend/App.tsx`
- `src/frontend/hooks/useTerminalRuntime.ts`
- `src/frontend/terminal-write-buffer.ts`
- 对应测试文件

不建议第一批同时触碰：

- 大量 UI 组件
- 无关的 session/sidebar 交互逻辑
- 视觉样式

## Reference Source Files

### Remux

- `crates/remux-terminal/src/lib.rs`
- `crates/remux-server/src/lib.rs`
- `src/backend/server-v2.ts`
- `src/backend/terminal-state/tracker.ts`
- `src/frontend/App.tsx`
- `src/frontend/hooks/useTerminalRuntime.ts`
- `src/frontend/terminal-write-buffer.ts`

### tmux

- `grid.c`
- `screen-redraw.c`
- `tty.c`
- `control.c`
- `input.c`

### zellij

- `zellij-server/src/panes/grid.rs`
- `zellij-server/src/output/mod.rs`
- `zellij-server/src/panes/terminal_pane.rs`
- `zellij-server/src/background_jobs.rs`
- `zellij-client/src/stdin_ansi_parser.rs`

## Success Criteria

计划完成后，Remux 在以下场景中应明显接近 `tmux` / `zellij` 的基座稳定性：

- 浏览器刷新后快速恢复到 live，而不是明显整屏 reset
- 桌面与手机同时连接同一 pane 时，不再互相扰动宽度真相
- 高速输出时 viewer 不会出现明显半帧刷新或突刺卡顿
- resize 后长行、prompt、cursor、wide char 表现稳定
- control view 和 terminal view 不会短暂错位
- runtime 重启或 viewer 硬刷新后具备更强恢复能力

## Final Rule

后续所有相关改动都应遵守以下原则：

- snapshot 是 fallback，不是 steady-state 主路径
- viewer presentation 不能反向污染 authoritative PTY truth
- terminal correctness 必须尽量靠 runtime authoritative model 保证
- 一切 anti-jitter 优化都要建立在 revision、queue、budget 明确可观测的前提上
