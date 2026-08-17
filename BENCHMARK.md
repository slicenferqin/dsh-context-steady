# dsh-context-steady 基准报告（v3：默认 500K 门槛、批量 digest 与发布门禁）

**结论先行**：

1. 插件默认 `activationThresholdTokens=500000`，**500K 之前零副作用**：本基准 10/20 轮全程没有产生任何 digest 调用和 packet 事件（实测 `digest_calls=0, packet_events=0`），插件等价于不安装。
2. v2 逐轮 digest 压力臂中，20 轮**总 token 数虽然省 39%，但按 DeepSeek V4 Flash 新峰价实际花费反而高 45%**。这是历史对照，不是当前批量默认的成本结论。
3. v2 用逐轮请求的实测差做线性外推，费用盈亏点约在单轮 prompt 170K；批量默认改变了成本曲线，500K 门槛仍保守，但必须重测后才能更新盈亏点。
4. v2 传统压缩强制臂在 10 轮里做了 21 次摘要，费用是当时逐轮插件压力臂的 2.7 倍，是默认臂的 6 倍。
5. v3 把 LLM digest 从逐轮请求改为默认每 4 个 settled turn 批量请求。修复 fenced JSON array 恢复后，发布门禁重复 3 次：baseline 与插件均 3/3 次正确回忆 4/4 个跨期决策，插件 3/3 保留全部 raw 标记并精确展开第 1 轮；provider token 均值减少 51.6%，surface 节点均值减少 63.9%，核心流程耗时减少 6.8%。按当前峰价估算仍贵 114.9%，因此发布定位是“有界上下文与可追溯连续性”，不是省钱工具。

## 1. 实验设置

- Harness `@deepseek-ai/dsh` 0.1.0-rc.6；`dsh-base + dsh-headless + dsh-context-steady`。
- 模型：主对话与 digest 侧请求均用 `opencode-go / deepseek-v4-flash`。
- 每轮独立进程，首轮 `create`，后续 `ctx.agents.resume` 同一持久化 session；每轮结束 `sessions.flush`。
- v1/v2 压力臂使用逐轮 digest；v3 默认 `digest.everyTurns=4`、整批 `maxTokens=768`、`timeoutMs=20000`。
- 任务：第 N 轮把 `FactN` 追加到 `facts.md` 并读回验证，回复 `ok N`；随后一道无工具回忆题。
- 关闭首句标题 side request，排除第三方噪声。
- 计费口径：DeepSeek V4 Flash 每百万 token（元）：
  - 旧价：命中 0.02 / 未命中 1.0 / 输出 2.0
  - 新峰价（8/17 起 9:00-12:00、14:00-18:00）：0.10 / 3.0 / 9.0
  - 新谷价：0.05 / 1.5 / 4.5
- 对照臂：
  - `baseline-default`：插件关闭，DSH 默认压缩阈值 0.8（本实验未触发）。
  - `plugin-default`：插件开启，`activationThresholdTokens=500000`。
  - `plugin`：插件开启，`activationThresholdTokens=0`（**压力臂，不代表默认行为**）。
  - `traditional-compact-low`：插件关闭，压缩阈值 0.002 强制传统压缩触发。

原始数据：`/tmp/dsh-cs-bench/results.jsonl`；脚本在 `bench/`。

## 2. 默认 500K：10 轮与 20 轮都是“不开”

真实日志逐轮检查（`plugin-default-10/20`）：

| 臂 | 轮数 | digest 调用 | packet 事件 | 最终 surface 节点 |
| --- | ---: | ---: | ---: | ---: |
| baseline-default | 10 | 0 | 0 | 64 |
| **plugin-default** | 10 | **0** | **0** | 64 |
| baseline-default | 20 | 0 | 0 | 172 |
| **plugin-default** | 20 | **0** | **0** | 124* |

\* 20 轮 arm 的 surface 节点差是模型行为方差（plugin-default 臂某些轮工具调用更少），不是插件效果；判定插件零副作用的标准是 **digest/packet 事件全为 0**。

**结论：在这类每轮 prompt 只有 ~40–120K token 的工作负载里，默认 500K 阈值下开与不开插件的插件侧行为完全一致。**

## 3. v2 历史对照：逐轮 digest 的 10/20 轮总账

下面不是“最后一次请求”，而是把每轮内**所有** LLM 交互（多次 tool-use 循环）的 provider usage 全部汇总；`miss=未命中输入`、`hit=缓存读`、`out=输出`，单位 token。

| 臂 | 轮数 | main miss/hit/out | digest miss/out | compact miss/hit/out | 总 token | 命中率 | 旧价 CNY | 新峰价 CNY |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 10 | 16,271 / 413,056 / 1,759 | 0 | 0 | 431,086 | 96.2% | 0.028 | 0.106 |
| plugin 压力臂 | 10 | 22,637 / 484,224 / 3,505 | 16,533 / 4,079 | 0 | 530,978 | 92.5% | 0.064 | 0.234 |
| baseline | 20 | 28,895 / 1,667,712 / 6,445 | 0 | 0 | 1,703,052 | 98.3% | 0.075 | 0.312 |
| plugin 压力臂 | 20 | 39,503 / 958,976 / 6,946 | 32,730 / 8,559 | 0 | 1,046,714 | 93.0% | 0.122 | 0.452 |
| traditional-low | 10 | 98,532 / 281,216 / 3,013 | 0 | 62,465 / 144,000 / 10,049 | 599,262 | 72.5% | 0.196 | 0.643 |

解读：

- **总 token 数**：压力臂 20 轮比 baseline 少 656,338 token（-39%），主要少在缓存读（-709K），但未命中输入 +43K、输出 +9K、digest 侧 +41K。
- **真实花费**：因为未命中输入和输出单价远高于缓存读，压力臂 20 轮反而 **+45% CNY（新峰价）**；10 轮 +121%。
- **命中率**：baseline 靠 append-only 前缀吃到 98.3% 命中；插件用 surface `replace` 牺牲了部分前缀复用（93.0%），换来的是更小的每次请求。

### 3.1 为什么“token 少了但更贵”

把第 20 轮拆开看（main 请求，token）：

| 臂 | miss | hit | out | 新峰价 CNY |
| --- | ---: | ---: | ---: | ---: |
| baseline 第 20 轮 | 1,323 | 117,376 | 263 | 0.0181 |
| plugin 压力臂第 20 轮 | 2,041 | 53,632 | 324 | 0.0144 |
| plugin digest（均摊） | ~1,637 | 0 | ~428 | 0.0088 |
| **plugin 合计** | 3,678 | 53,632 | 752 | **0.0232** |

插件把 64K 便宜缓存读换成了 ~2.4K 昂贵未命中+输出。当前价格下这笔交易不划算，直到 baseline 的缓存读规模足够大：

```
baseline 每轮费用 ≈ 0.00000636 + 0.00000010 × prompt_tokens
plugin 每轮费用   ≈ 0.0232（本负载实测）
盈亏点 prompt ≈ (0.0232 - 0.00636) / 0.00000010 ≈ 168,000 tokens
```

**v2 历史外推：逐轮 digest 工作负载的费用盈亏点约在单轮 prompt 170K。批量默认改变了 side-request 成本，不能把这个数字当作 v3 实测结论。**

## 4. v2 历史对照：传统上下文压缩（强制触发）

默认阈值 0.8 在 10/20 轮一次都没触发。把阈值压到 0.002 后，10 轮触发 21 次摘要压缩：

| 指标 | traditional-low | plugin 压力臂 | baseline |
| --- | ---: | ---: | ---: |
| 10 轮总 token | 599,262 | 530,978 | 431,086 |
| 新峰价 CNY | **0.643** | 0.234 | 0.106 |
| 最慢轮 | 36.7s | 14.3s | 6.5s |
| 命中率 | 72.5% | 92.5% | 96.2% |
| 摘要/消化次数 | 21 次大摘要 | 10 次逐轮 digest | 0 |

这组 v2 机制对照表明小规模强制传统压缩比当时的逐轮 digest 更贵、更慢、缓存抖动更大；默认 500K 下本插件此时不会介入。

## 5. 代价与收益（按默认 500K 讲）

### 代价

| 项目 | 数据 |
| --- | --- |
| 500K 前 | **零 digest、零 packet**；只做 token 测量 |
| 激活后每轮 | 始终生成 deterministic fallback；默认每 4 轮发一次 authoritative digest 批请求 |
| cadence 边界延迟 | 一次同步 side request，最长由 `digest.llm.timeoutMs` 限制；非边界轮无 digest 请求 |
| 持久化体积（v2 20 轮逐轮压力臂） | 压缩 412KB→478KB（+16%） |
| 缓存命中率（v2 逐轮压力臂） | 98.3% → 93.0% |
| 短会话费用（v2 逐轮压力臂） | 0 阈值 10/20 轮费用 +121%/+45%；不代表批量默认 |

### 收益

| 项目 | 数据 |
| --- | --- |
| 窗口聚焦（v2 全批成功压力臂） | surface 4 节点；baseline 20 轮 172 节点 |
| v2 第 20 轮 main prompt | 118.7K → 55.7K（逐轮压力臂） |
| 审计性 | 每个 packet `replace` 带 `sourceEventSeqs`；raw journal 完整 |
| 恢复性 | packet 与 coverage 跨进程持久；`context_steady_expand` 可逐字找回第一轮 |
| 成本保护 | 默认 500K 前不开工，避开短会话负收益区 |

## 6. 面向用户的价值场景：长任务决策连续性

旧基准主要证明机制和成本，但用户真正关心的是：长任务被大量工具输出淹没后，重启进程还能否记住关键决策，且需要时能否找回原文。

`bench/run_value_bench.py` 构造 8 轮编码会话：每轮注入一个唯一架构决策和 22K 字符无关工具 transcript；每轮运行在独立进程，最终无工具查询第 1/2/4/8 轮决策。插件臂使用 `activationThresholdTokens=0` 强制测试机制，默认把 4 轮合并成一次 digest side request。

最新 v3 原始结果：`/tmp/dsh-cs-community-batch-fixed/value-results.json`。

| 指标（3 次均值/通过数） | baseline | plugin | 差异 |
| --- | ---: | ---: | ---: |
| 跨期决策精确回忆 | 3/3 次均为 4/4 | 3/3 次均为 4/4 | 质量持平 |
| 最终 surface 节点 | 32.33 | 11.67 | **-63.90%** |
| provider token | 903,207 | 436,879 | **-51.63%** |
| 新峰价估算 | 0.373054 元 | 0.801545 元 | **+114.86%** |
| 核心流程总耗时 | 79.381s | 73.952s | **-6.84%** |
| raw 决策标记仍在 journal | 3/3 | 3/3 | 持平 |
| 第 1 轮原文按 ref 展开 | 未测 | 3/3 | 插件能力 |

plugin repetitions 2/3 的两个 batch 都升级为 authoritative，最终 surface 都是 7。repetition 1 的首批保持 fallback、第二批成功，最终 surface 为 21；即使单批结构化输出失败，fail-closed 行为仍保持回忆质量、原始证据和精确展开。发布门禁整体通过。

这组结果证明的是有条件价值：插件在 authoritative batch 成功时显著缩小 provider-bound 工作集，并持续保留原文追溯；它不是普遍省钱工具。费用受主模型缓存与 side digest 输出价格显著影响。

发布门禁命令（退出码非 0 即不发布）：

```sh
python3 bench/run_value_bench.py \
  --rounds 8 --payload-chars 22000 --repetitions 3 \
  --min-provider-token-reduction 10
```

可按发布承诺进一步加上 `--max-cost-change` 和 `--max-latency-change`；脚本始终强制检查两臂回忆质量、插件 raw journal 保留与精确 expand 全部重复通过。

## 7. 诚实边界与待办

- **还没有 >500K 的重载实测**。盈亏点 ~170K 是 v2 逐轮 digest 轻负载外推；批量 digest 后必须在真正跨默认门槛的负载上重新测量，不能把旧外推当作当前结论。
- **批量结构化输出仍可能单批失败**：最终 3 次门禁中有一个 repetition 的首批未升级为 authoritative。失败保持 fail-closed，整组质量/原文/expand 门禁仍通过；对成本或 surface 有严格 SLO 的使用方应监控 `context_steady_status.authoritativeDigests`。
- **LLM digest 正文持久化依赖可选 storage-domain**：标准 Web 组合挂载 `ctx.storageDomain` 时，authoritative digest 会跨进程恢复；精简/headless 组合未挂载 storage 时，coverage/packet 仍持久，但历史 digest 回放为 deterministic fallback。
- **价值场景仍是合成任务**：3 次重复能减少随机方差，但还需要真实仓库修复任务和跨默认 500K 阈值测试，才能证明生产用户净收益。
