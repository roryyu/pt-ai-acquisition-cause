# 深度研究优化设计（research 页面 + v1/research 接口）

> 目标：把当前「外部搜索摘要汇编」升级为「面向获客业务决策的可信研究闭环」。
> 本文基于只读审查（源码 + 已运行测试），所有结论标注证据来源；未经真实联网/模型评测的业务效果归因，统一标为「待评测假设」。
> 关联文件：
> - 接口：`app/api/v1/research/route.ts`、`app/api/v1/research/[id]/route.ts`、`app/api/v1/research/graph/*`
> - 编排：`lib/server/agents/deep-research.ts`、`lib/server/agents/prompts.ts`
> - 页面：`app/(dashboard)/research/client.tsx`、`hooks/use-agent-stream.ts`
> - 图谱：`lib/server/research-graph/{store,query,review,extractor}.ts`
> - 数据能力（研究目前未接入）：`lib/server/operators/data-operators.ts`、`lib/server/semantic/semantic-query.ts`、`lib/server/agents/workers.ts`

---

## 一、现状与核心结论

当前 `/api/v1/research` 走独立引擎 `runDeepResearch`，链路为：

```
Planner 拆子问题 → Executor（SearchOp 检索 + ExtractOp 深读 + LLM 抽发现）
  → Analyzing（CompareOp 比对共识/分歧）→ Synthesizer 流式成稿
  → 引用软校验 → 图谱抽取合并 → 落库 completed
```

**核心结论：结论业务价值低，根因不在提示词，而在三处结构性缺失：**

1. **没有接入内部获客数据**——研究只吃外部网页摘要，`adjust_daily_metrics`（真实 Adjust 数据，273 网络 × 242 国家）这类可复算基线完全没进研究契约。因此报告只能写「行业趋势」，写不出「本渠道本市场该怎么调预算」。
2. **证据是摘要的摘要，不可审计**——网页先被抽成要点，再截断 1200 字，再生成「发现」字符串；最终报告只拿到发现文本 + URL，无法机械核验「这句结论是否被这个来源支持」，也丢失发布日期/口径/适用市场。
3. **质量门槛形同虚设**——零证据仍标记 `completed`（`deep-research-operators.test.ts:136-158` 明确保护此行为），空报告/零正文引用仍判「引用校验通过」（`review.ts:27-49`），失败文案被当作「发现」沉淀进图谱。

> 已运行验证：`tests/deep-research-operators.test.ts`、`tests/research-source.test.ts`、`tests/context-summary.test.ts`、`tests/research-graph.test.ts -t verifyCitationIntegrity` 共 19 项通过——它们覆盖流程与字符串结构，但不验证结论是否有业务价值。

---

## 二、影响业务价值的问题清单（按优先级）

### P0 — 可信度地基（不修则后续优化无意义）

| 编号 | 问题 | 证据 | 用户影响 |
|---|---|---|---|
| P0-1 | 空报告/零正文引用被判「校验通过」：`passed` 只看 `citations.length>0 && dangling==0` | `review.ts:47-48` | 实时流显示「引用完整性校验通过」，实际报告可能为空 |
| P0-2 | 零证据仍 `completed`：搜索/抽取失败被转成 `findings` 里的普通字符串，子任务一律存 `completed` | `deep-research.ts:288-294`、`route.ts:123-143` | 「流程走完」＝「证据充分」被混为一谈 |
| P0-3 | 先 `completed` 后存报告，无事务：`onStateChange('completed')` 在返回前触发，API 随后才分两次写 `Question.answer` 和 task.output | `deep-research.ts:545-549`、`route.ts:147-186` | 下游读到「已完成但无正文」，画布把空结果缓存为终态 |
| P0-4 | 深读判定用摘要长度：摘要刚入 `materials`，紧接着用 `text.length>300` 判断是否已深读，导致长摘要跳过 ExtractOp | `deep-research.ts:227-236` | 「深入研究」可能仍只看搜索摘要，无法核对原文口径 |

### P1 — 执行与知识沉淀可靠性

| 编号 | 问题 | 证据 | 用户影响 |
|---|---|---|---|
| P1-1 | 「停止」只 abort 前端请求，不取消服务端任务 | `use-agent-stream.ts` + `sse.ts`（无取消信号传入编排） | 模型/搜索继续跑，任务仍落库并更新图谱 |
| P1-2 | 流式主备降级会拼接两份报告：备用请求从原提示重生成，已输出文本未清空，调用方持续 `report += chunk` | `model-gateway.ts:183-198`、`deep-research.ts:516-528` | 保存「半篇主网关 + 完整备用」，结论重复/矛盾 |
| P1-3 | 删除研究后结论仍留在图谱并参与后续研究：删除只处理 DB 与画布绑定，不清理图谱 provenance | `research/[id]/route.ts:75-94`、`research-graph/query.ts` | 删除无法撤回对后续结论的影响 |
| P1-4 | 图谱读改写无并发保护：多写者读同一旧图各自合并后覆盖，固定 `.tmp` 文件名冲突 | `deep-research.ts:407-415`、`research-graph/store.ts` | 已完成研究的知识增量丢失 |
| P1-5 | 图谱重建失败仍覆盖旧图：从空图开始，抽取失败只 `skipped++`，最后无条件保存 | `research/graph/rebuild/route.ts` | 一次恢复操作反而清空已有知识 |
| P1-6 | SSE 请求异常/异常结束未被页面承接：hook 抛异常不写 `state.error`，普通 EOF 无条件触发完成回调 | `use-agent-stream.ts:31-83`、`client.tsx:171-195` | 页面已切实时视图却无错误说明；不完整报告与正常结束无法区分 |

### P2 — 展示与承接

| 编号 | 问题 | 证据 | 用户影响 |
|---|---|---|---|
| P2-1 | 历史答案类型未承接已存的 `review/graphStats` | `client.tsx:38-53` | 质量信息落库了却不在页面展示 |
| P2-2 | 研究结果无结构化业务图表，画布研究适配器只取正文 + 引用 | `insights/extract.ts`、`canvas/live-shape.tsx` | 知识图谱不能替代指标趋势图 |
| P2-3 | 页面只加载前 50 条任务，图谱回看依赖这份列表；画布「打开来源」固定跳 `/research` 不带 task id | `client.tsx:130-132`、`live-shape.tsx:61-66` | 超过 50 条历史丢失；来源无法精确定位 |

---

## 三、优化设计

分五阶段推进，**先保证可信，再建立业务价值，最后优化展示**。不建议先扩 Agent 数量或加报告篇幅。

### 阶段 0：可信度地基（P0，1 个迭代内完成）

**目标：让「completed」名副其实。**

1. **修引用判定**（`review.ts`）：
   ```ts
   const passed =
     report.trim().length > 0 &&
     citations.length > 0 &&
     citedNos.length > 0 &&   // 正文必须真实引用
     dangling.length === 0;
   ```
   「未被正文引用」仍为可精简项，不影响通过。

2. **分离执行状态与质量状态**：
   - 子问题返回结构化结果：`{ status: 'ok'|'no_evidence'|'failed', findings, gaps }`，失败/缺口**不再计入 findings**。
   - `DeepResearchResult` 增加 `quality: { hasEvidence, evidenceCount, coverage, passed }`。
   - 报告发布门槛：有效证据 < N 或关键子问题覆盖不足时，输出**明确的缺口报告**（"以下问题未找到可信证据：…"），状态标 `completed_with_gaps`（新增枚举值），而非伪装成正常结论。

3. **事务化终态提交**（`route.ts`）：用 `prisma.$transaction` 在同一事务写 `Question.answer` + `task.output` + `task.status=completed` + `citations`，提交成功后才 `send({type:'done'})`；`onStateChange('completed')` 从编排内部移除，改由 API 在事务成功后触发。图谱更新改为**提交后的派生任务**。

4. **修深读判定**（`deep-research.ts:227-236`）：分别记录「搜索命中 / 正文抓取成功 / 抽取成功」三个状态；按规范化 URL 去重，只有 `extractStatus==='ok'` 才占用深读额度，失败后从候选队列补足下一个。

> 完成标准：P0 四项各有回归测试；空报告不再判通过；搜索全失败时状态为 `failed` 或 `completed_with_gaps`（不再是干净的 `completed`）。

### 阶段 1：建立业务研究契约（ResearchBrief）

**目标：把「写行业报告」改成「回答获客决策问题」。**

1. **扩展请求契约**（`route.ts` 的 `ResearchRequestSchema`）——新增可选 `brief`：
   ```ts
   brief?: {
     decisionType: 'budget_shift'|'channel_choice'|'market_entry'|'creative'|'other'
     scope: { networks?: string[]; countries?: string[]; platforms?: string[] }
     dateWindow?: { from: string; to: string }
     metrics?: string[]        // 语义层 metric key，如 ecpi_all / roas_iap_7d
     baseline?: unknown        // 来源问答的结构化事实快照（见下）
     target?: string           // 期望验收指标，如「CPI 下降 10%」
     constraints?: string[]
   }
   ```

2. **来源问答桥接传结构化事实**（`route.ts:48-62`）：当前只取 `contextSummary/content` 自然语言。改为：若来源问答是 `data_analysis` 路由，携带其**原始查询结果表 + 执行的 SQL/算子调用**（问答链路已产出），而非只截 800 字回答。这样研究能直接复算内部基线。

3. **Planner 提示词改造**（`prompts.ts` PLANNER_PROMPT）：当有 `brief` 时，拆解维度从「市场格局/规模/趋势」改为围绕**决策对象**：
   - 内部异常（哪个渠道/市场/时段指标偏离基线）
   - 外部候选原因（竞价环境、政策、竞品、季节性）
   - 验证/反证（外部证据能否解释内部偏离）
   - 可执行选项（预算迁移、素材调整、承接端切换）

> 待评测假设：接入 brief 后报告是否真的更「可决策」，需用固定业务问题 + 人工评分验证（见第五节评测集）。

### 阶段 2：建立证据模型（Source / Evidence / Claim 分离）

**目标：让每条结论可机械核验。**

当前 `EvidenceMaterial` 把「搜索命中、正文、发现」压成一层字符串。改为三层：

```ts
Source   { id, url, title, publishedAt?, domain, fetchStatus }
Evidence { sourceId, quote /*原文摘录*/, spanLoc /*定位*/, appliesTo: {market?, metric?, dateRange?} }
Claim    { text, supportedBy: evidenceId[], stance: 'support'|'refute'|'neutral', confidence }
```

- **ExtractOp 升级**：`extract` 算子返回时保留原文摘录（quote）与定位，而非只给 `point` 要点字符串。
- **CompareOp 升级**：比较对象从「子问题摘要」改为「独立来源对同一 Claim 的支持/反对证据」；同一 URL/转载源不计作独立信源（按规范化域名 + 内容指纹去重）。
- **引用校验升级**：`verifyCitationIntegrity` 从「编号是否存在」升级为「Claim 是否至少被 1 条 support 证据支撑」，无支撑的判断标「待验证」而非混入结论。

> 边界（必须写进提示词与页面）：外部新闻与内部指标同时变化 ≠ 已证明因果；没有可复算基线与假设时，不得生成看似精确的收益预测或预算调整比例。

### 阶段 3：缺口驱动的再研究（把 depth 改成研究预算）

**目标：`deep` 不再只是「多深读 1 页」。**

- 现状：`deepReadCount = depth==='deep'?3:2`（`deep-research.ts:440`），搜索停止只看结果数量（`:216`）。
- 改造：`depth` 映射为**研究预算**（最大搜索轮次、最大深读页、最大补充研究次数）+ **验证强度**（是否要求反证、是否要求 ≥2 独立信源）。
- 执行循环增加**覆盖评审**：一轮收集后评估「关键子问题是否已被可信证据覆盖」，未覆盖则在预算内触发补充研究（换关键词/换信源类型），预算耗尽仍有缺口则如实输出 `completed_with_gaps`。

### 阶段 4：交付可执行决策 + 展示承接

**目标：报告结构从「摘要/发现/展望」改为「决策卡」。**

1. **REPORT_PROMPT 改造**：输出结构增加
   - 决策选项（每条含：适用条件、证据强度、预期收益的**测算依据**而非精确数字、风险、验证指标、停止条件）
   - 证据矩阵（Claim × Source，标 support/refute）
   - 证据缺口（诚实声明，来自阶段 0 的 gaps）

2. **页面承接**（`client.tsx`）：
   - `ResearchAnswer` 类型补 `quality`/`review`/`graphStats`，历史与实时视图展示质量徽章（证据数、覆盖度、校验结果）。
   - 新增「决策卡」「证据矩阵」区块；研究结果若有内部数据，渲染真实指标趋势图（复用 `components/charts`），而非只给知识图谱。
   - `STATUS_META` 增加 `completed_with_gaps`（warning 色）与 `cancelled`（muted 色）。

3. **画布承接**（`insights/extract.ts`）：研究适配器除正文/引用外，透传 `quality` 与决策卡结构；「打开来源」跳转携带 task id。

---

## 四、执行与可靠性修复（可与阶段 0-1 并行）

| 编号 | 修复 | 落点 |
|---|---|---|
| P1-1 取消 | 区分「断开订阅」与「取消任务」；提供任务级取消 API，将 `AbortSignal` 传入 `runWithConcurrency`、连接器 fetch 与模型调用，持久化 `cancelled` | `deep-research.ts` DeepResearchOptions 增 `signal`、`route.ts`、`sse.ts` |
| P1-2 降级拼接 | 已输出内容后不再透明降级：终止本轮或发「报告版本替换」事件，客户端与持久化用同一完整版本 | `model-gateway.ts:183-198`、`deep-research.ts:516-528` |
| P1-3 删除失效 | 删除研究时发「报告失效」事件，清理图谱对应 provenance，重算受影响聚合摘要；清理前检索层过滤失效报告 | `research/[id]/route.ts:75-94`、`research-graph/*` |
| P1-4 图谱并发 | 保护「读—合并—提交」全过程，用 DB 事务或带版本校验的串行写；临时文件名随机化 | `research-graph/store.ts`、`deep-research.ts:407-415` |
| P1-5 重建覆盖 | 在独立版本重建，区分「无内容」与「执行失败」；完整性检查通过才切换，失败保留旧版本 | `research/graph/rebuild/route.ts` |
| P1-6 SSE 承接 | 统一传输错误/任务失败/主动取消/协议完成四态；只有明确 `done` 事件才算成功，异常断流查持久化状态并提供恢复入口 | `use-agent-stream.ts:31-83`、`client.tsx:171-195` |

---

## 五、测试与评测计划

### 5.1 单元/集成回归（补当前缺口）

| 层级 | 关键用例 |
|---|---|
| 证据与质量 | 空报告→不通过；零正文引用→不通过；搜索全失败→`failed`/`completed_with_gaps`（改掉 `deep-research-operators.test.ts:136-158` 现保护的「仍 completed」断言）；仅摘要未深读；来源不支持结论→标「待验证」 |
| 编排 | 长摘要仍执行深读；去重后补足候选；缺口触发补充研究；同源转载不计独立证据 |
| API/持久化 | 完成状态与结果原子提交；中途写库失败不留「completed 无正文」；取消/删除与运行任务竞争 |
| 流式 | 非 2xx、异常断流、EOF 无 done、主网关部分输出后失败、恢复订阅 |
| 图谱 | 并发增量幂等；删除失效传播；重建失败保留旧版本 |
| 页面/画布 | 质量信息透传；运行任务恢复；>50 条历史；精确来源跳转；终态空 payload |

### 5.2 业务价值评测集（当前完全缺失）

用**固定证据集 + 真实获客业务问题**（如「TikTok 东南亚 CPI 6 月起上涨，是否迁移预算到 Meta？」）离线评测，人工/LLM-as-judge 打分：

- 事实支持率（Claim 有 support 证据占比）
- 口径一致性（指标口径与 `api-metrics-glossary.md` 一致，无混用 Attribution/Network 花费口径）
- 决策问题覆盖率
- 行动可执行性（是否给出适用条件 + 验证指标 + 停止条件）
- 诚实拒答率（证据不足时是否如实说缺口，而非编造精确数字）

> 现有 `scripts/agent-smoke.ts` 走的是另一套 `runAgentWorkflow`，**不覆盖本接口**，需新增 `scripts/research-smoke.ts` 直连 `runDeepResearch`。

---

## 六、落地顺序建议

1. **阶段 0（P0 四项）+ P1-6** — 可信地基与错误承接，风险最低、收益最直接。
2. **阶段 1（ResearchBrief）+ 阶段 2（证据模型）** — 业务价值核心，需改契约/提示词/算子返回结构。
3. **阶段 4（决策卡展示）** — 承接前两阶段的产出。
4. **阶段 3（缺口驱动再研究）+ P1-1~P1-5** — 执行健壮性与深度语义。
5. **5.2 业务评测集** — 贯穿全程，每阶段用同一评测集对比改进前后。

### 关键边界（贯穿所有阶段）

- 外部信息与内部指标同时变化 **不等于** 已证明因果。
- 没有可复算基线和假设，**不生成**看似精确的收益预测或预算调整比例。
- 知识图谱定位为**带来源、版本、失效机制的派生索引**，不是模型结论的永久事实库。
