# 深度研究 × Understand-Anything 知识图谱融合设计

> 版本：v1.0（2026-09-01）
> 范围：`lib/server/agents/deep-research.ts` 深度研究工作流及其配套算子 / API / 前端
> 参考工程：[Egonex-AI/Understand-Anything](https://github.com/Egonex-AI/Understand-Anything)（Claude Code 插件：多 Agent 管线把代码库/知识库分析为可交互知识图谱）

---

## 1. 背景与动机

### 1.1 Understand-Anything（下称 UA）核心机制

UA 把一个陌生代码库/知识库变成"可探索、可检索、可问答"的知识图谱，核心机制有五点：

| # | UA 机制 | 说明 |
|---|---------|------|
| M1 | **多 Agent 流水线** | project-scanner → file-analyzer（并行，≤5 worker）→ architecture-analyzer → tour-builder → graph-reviewer，各司其职 |
| M2 | **确定性结构 + LLM 语义混合** | Tree-sitter 抽取确定性结构事实（节点/边），LLM 产出语义摘要/分层/领域映射；结构侧可复现，语义侧有理解 |
| M3 | **知识图谱即 JSON** | 图谱落盘为 `.ua/knowledge-graph.json`，可提交共享；任何人无需 LLM 即可查看 |
| M4 | **增量更新** | 指纹变更检测，只重分析变化部分；支持 post-commit 钩子自动更新 |
| M5 | **图谱消费** | `/understand-chat` 基于图谱问答、模糊+语义检索、diff 影响分析、交互式 Dashboard 可视化 |

### 1.2 本项目深度研究现状与痛点

现状（`deep-research.ts` 状态机）：

```
Planner（拆 3-5 个子问题）→ Executor（逐子问题 串行：SearchOp 检索 → ExtractOp 深读 → 证据抽取）
→ Analyzing（CompareOp 多源比对）→ Synthesizer（流式研究报告）
```

痛点：

1. **研究无记忆**：每次研究互相孤立。上次研究过 "TikTok 竞价成本"，本次再研究同主题时 Planner 无从知晓历史结论，子问题重复拆解、报告重复产出。
2. **知识不沉淀**：报告完成后即归档为一条 Question 记录，其中的实体（渠道/市场/竞品/指标）与结论之间的关联关系不可检索、不可复用。
3. **子问题串行执行**：3-5 个子问题逐个检索深读，端到端时延 = 各子问题之和。
4. **产出无校验**：报告中的引用编号 `[n]` 是否与引用表一致、证据缺口是否声明，缺少机器校验环节。

### 1.3 融合目标

把 UA 的"分析 → 图谱 → 增量更新 → 图谱消费"闭环移植到深度研究语料（研究报告）上，形成 **研究知识图谱（Research Knowledge Graph）**，让深度研究从"一次性检索"升级为"持续积累、图谱引导"的研究系统：

| UA 机制 | 本项目落点 | 增强的能力 |
|---------|-----------|-----------|
| M1 多 Agent 流水线 / 并行 worker | Executor 子问题**并行收集**（并发 2） | 端到端时延下降约 40-50% |
| M2 结构+语义混合 / article-analyzer | 报告完成后 LLM 抽取**实体/关系/结论**构建图谱补丁 | 研究知识结构化沉淀 |
| M3 图谱即 JSON | 图谱持久化为 `data/research-graph/knowledge-graph.json` | 可共享、可回放、可视化 |
| M4 增量更新 | 每次研究完成后**增量合并**图谱（实体按归一化名称去重） | 图谱随研究持续生长 |
| M5 图谱问答/检索 | Planner 前**图谱检索注入背景**；`GET /api/v1/research/graph` 供前端可视化 | 规划不重复、报告有传承 |
| graph-reviewer 完整性校验 | 报告**引用完整性校验** + 图谱引用完整性校验 | 产出可信度 |

---

## 2. 总体架构

### 2.1 改造后工作流

```
                         ┌──────────────────────────────┐
                         │   研究知识图谱（JSON 落盘）    │
                         │ nodes: entity/topic/report    │
                         │ edges: relation               │
                         └───▲──────────────────────┬───┘
              ④ 增量合并      │                      │ ① 图谱检索
        （报告→图谱补丁）     │                      ▼
┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐
│ Planner │ → │Executor │ → │CompareOp│ → │Synthes- │ → │ Review  │
│+图谱背景 │   │并行子问题│   │ 多源比对 │   │izer 报告│   │引用完整性│
└─────────┘   └─────────┘   └─────────┘   └─────────┘   └─────────┘
```

1. **① 图谱检索（规划前）**：以研究问题查询图谱，召回相关实体节点 + 关联历史研究，组装「研究知识图谱背景」注入 Planner 与 Synthesizer。
2. **② 并行执行**：子问题经并发受限的并行池收集证据（事件按子问题打标签，前端时间线天然兼容）。
3. **③ 报告生成**：Synthesizer 吸收图谱背景（历史结论呼应/增量说明）。
4. **④ 增量更新（完成后，fire-and-forget）**：LLM 从报告+子问题发现中抽取实体/关系/摘要 → 归一化去重合并入图谱 → 引用完整性校验（软校验，不阻断）。

### 2.2 模块清单

新增模块 `lib/server/research-graph/`（全部纯服务端、Node runtime）：

| 文件 | 职责 |
|------|------|
| `types.ts` | 图谱类型：`GraphNode` / `GraphEdge` / `GraphReportRef` / `KnowledgeGraph` |
| `store.ts` | 图谱读写：`loadGraph` / `saveGraph`（原子写）/ `mergeGraph`（去重合并）/ 路径解析（支持 `RESEARCH_GRAPH_PATH` 环境变量覆盖，便于测试） |
| `extractor.ts` | `extractGraphPatch`：LLM 抽取图谱补丁（经 `GRAPH_EXTRACT_PROMPT`）+ `buildReportRef` 纯函数 |
| `query.ts` | `queryGraph`：问题 → 词元重叠打分 → topK 相关节点与历史研究；纯函数可测 |
| `review.ts` | `verifyCitationIntegrity`：报告 `[n]` 与引用表一致性校验；纯函数可测 |

修改文件：

| 文件 | 修改点 |
|------|--------|
| `lib/server/agents/prompts.ts` | 新增 `GRAPH_EXTRACT_PROMPT`、`graphContextBlock()`；`PLANNER_PROMPT` / `REPORT_PROMPT` 追加图谱背景条件条款 |
| `lib/server/agents/deep-research.ts` | `DeepResearchOptions.graphContext`；Executor 并行化；完成后触发图谱增量更新 + 引用完整性校验（经现有 `step`/`tool_call`/`tool_result` 事件透出，不新增事件类型） |
| `app/api/v1/research/route.ts` | 发起前查图谱注入 `graphContext`；`answer.graphStats` 记录本次图谱增量 |
| `app/api/v1/research/graph/route.ts`（新增） | `GET` 返回全量图谱（前端可视化）；`POST` 从存量已完成研究重建图谱 |
| `components/research/GraphPanel.tsx`（新增） | 研究知识图谱面板：SVG 径向图 + 相关历史研究列表 + 一键重建 |
| `app/(dashboard)/research/client.tsx` | 创建区挂载 `GraphPanel` |

**约定遵循**：全部 Prompt 集中在 `prompts.ts`；术语采用流量投放归因领域（渠道/市场/竞品/指标）；中文注释；失败路径一律静默降级不阻断研究主流程。

---

## 3. 数据模型：研究知识图谱

### 3.1 为什么是 JSON 文件而不是新表

- 忠实移植 UA "图谱即 JSON" 理念：可整体查看、提交共享、无需迁移脚本；
- 图谱是**派生物**（可由历史报告随时重建，见 5.3 重建接口），不进入 Prisma 事务边界；
- 单文件 + 原子写（写临时文件后 `rename`）足以支撑当前规模（预计节点数百级）。

### 3.2 类型定义（`types.ts`）

```ts
export type GraphNodeType = "entity" | "topic" | "report";

export interface GraphNode {
  id: string;            // node_xxx（实体/主题）或 report 的 questionId
  label: string;         // 展示名（实体名/主题名/研究目标摘要）
  type: GraphNodeType;
  summary: string;       // 一句话语义摘要（LLM 产出）
  reportIds: string[];   // 出现于哪些研究（questionId）
  updatedAt: string;     // ISO 时间
}

export interface GraphEdge {
  source: string;        // 节点 id
  target: string;
  relation: string;      // 如「竞争于」「投放于」「受...政策影响」「研究涉及」
  reportIds: string[];   // 支撑该边的研究
}

export interface GraphReportRef {
  questionId: string;    // 承载报告的 Question id
  question: string;      // 研究问题
  objective: string;     // Planner 研究目标
  summary: string;       // 报告摘要（抽取时产出，≤200 字）
  createdAt: string;
}

export interface KnowledgeGraph {
  version: 1;
  updatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  reports: GraphReportRef[];   // 以 questionId 索引
}
```

设计要点：

- **三类节点**对应 UA 的 layered graph：`entity`（实体：渠道/市场/竞品/厂商/政策）≈ UA 的 file/function 节点；`topic`（研究主题）≈ UA 的架构层；`report`（研究本身）≈ UA 的 tour 入口。
- **边携带 `reportIds`**：任何关系可溯源到具体研究（UA 的 referential integrity 思想）。
- **实体去重键**：`label` 归一化（去空格/全半角统一/小写化），合并时 `reportIds` 取并集、`summary` 以最新为准。

---

## 4. 详细设计

### 4.1 图谱抽取（M2/M4：报告 → 图谱补丁）

时机：`runDeepResearch` 报告流式完成后、`done` 事件之前同步执行（实现注：等待完成以便 `answer.graphStats` 随报告一起持久化；任一步失败仅透出降级文案事件，**不阻断研究完成**）。

`GRAPH_EXTRACT_PROMPT`（集中管理于 `prompts.ts`）输入 = 研究问题 + 研究目标 + 各子问题发现（≤6000 字）+ 报告前 3000 字，输出 JSON：

```json
{
  "summary": "报告一句话摘要（≤120字，含关键数据）",
  "entities": [
    { "label": "TikTok", "type": "entity", "summary": "短视频渠道，2026 竞价成本上涨 [1]" }
  ],
  "topics": [ { "label": "广告竞价成本", "summary": "..." } ],
  "relations": [
    { "source": "TikTok", "target": "广告竞价成本", "relation": "受...驱动" }
  ]
}
```

抽取约束（写进 Prompt）：实体 3-8 个、主题 1-3 个、关系 ≤8 条；实体名必须是研究材料中出现过的具体名词（渠道/市场/竞品/厂商/政策/指标），禁止泛化词（"市场趋势"这类进 topic）；每条摘要可带引用编号。

`extractor.ts::extractGraphPatch`：

- 调 `chatCompletion`（temperature 0.1, maxTokens 2048），复用 `deep-research.ts` 的 `extractJson` 容错解析（提升为共享函数）；
- 解析失败 → 返回 `null`，上层静默跳过（图谱不可用不影响研究产出）。

### 4.2 图谱合并（store.ts::mergeGraph）

纯函数 `mergeGraph(base, patch, reportRef) → KnowledgeGraph`：

1. 写入 `reports`（按 questionId upsert）；
2. 实体/主题节点按归一化 label 匹配：命中则并集 `reportIds` + 更新 `summary`/`updatedAt`，未命中则新建（`newId` 规则 `node_xxx`）；
3. 关系边按 `(source, target, relation)` 三元组匹配去重，`reportIds` 并集；`report` 节点与其 `topic` 之间自动补「研究涉及」边；
4. 返回新对象（不改传入引用），由 `saveGraph` 原子落盘（`writeFile(tmp)` + `rename`）。

### 4.3 图谱检索与背景注入（M5：图谱问答 → Planner）

`query.ts::queryGraph(graph, question, topK=6)` 纯函数：

- 词元化：中英文问题拆词（英文按非字母数字切分；中文按 2-3 字滑窗 bigram）；
- 打分：节点 `label`/`summary` 与问题词元的重叠数 + 该节点关联研究的新鲜度加权（近 90 天研究 +0.5）；
- 返回 `{ nodes: TopK 节点, reports: 关联历史研究（按分排序去重，≤3 条） }`。

`prompts.ts::graphContextBlock(hits)` 纯函数组装注入文本（空命中返回空串不注入）：

```
## 研究知识图谱背景（平台历史研究沉淀，规划时须避免重复、向外延展）
相关历史研究：
- [2026-08-20] 「TikTok 竞价成本上涨原因」结论摘要：……
相关实体：TikTok（摘要）；东南亚市场（摘要）
```

注入位置（与现有 `sourceContext` 机制一致、可叠加）：

- **Planner**：user 消息前缀；`PLANNER_PROMPT` 追加条款——"若输入含「研究知识图谱背景」：子问题须在历史结论之上向外延展（更新数据/新增维度/外部验证），不得原样重复历史研究已覆盖的方面；关键词优先复用背景中的实体名"。
- **Synthesizer**：user content 前置；`REPORT_PROMPT` 追加条款——"若输入含「研究知识图谱背景」：综合分析需说明本研究相对历史结论的增量（印证/修正/拓展）"。

### 4.4 Executor 并行化（M1：并行 worker）

现状串行循环改为**并发 2** 的受限并行池（内联 `runWithConcurrency` 工具，不引第三方依赖）：

- `CitationRegistry.register` 为同步操作，单线程事件循环下并发安全；
- 事件 `stepId` 已按子问题区分（`dr_sub_N_*`），并发下时间线仍清晰；
- 结果按原 `subQuestions` 顺序回填，`onSubTask` 持久化顺序不变；
- 并发数 2 的理由：SearchOp/ExtractOp 依赖外网抓取，过高并发易触发限流；2 已能缩短约一半收集时延。

### 4.5 引用完整性校验（graph-reviewer 思想）

`review.ts::verifyCitationIntegrity(report, citations)` 纯函数：

- 抽取报告中全部 `[n]`，校验每个编号在引用表中存在；
- 校验引用表非空且至少一条被正文引用；
- 返回 `{ passed, issues: string[] }`。

执行时机：报告生成后、`done` 之前，经 `step` 事件透出（`dr_review`）；**软校验**——不通过仅记录 `issues` 并追加进 `answer.review`，不阻断完成（与 UA graph-reviewer 默认 inline 校验、`--review` 才全量 LLM 审查的思路一致）。

### 4.6 API（`app/api/v1/research/graph/route.ts`）

| 方法 | 行为 |
|------|------|
| `GET /api/v1/research/graph` | `requireActor` 后返回 `{ nodes, edges, reports, updatedAt }`（图谱不存在返回空图 `200`） |
| `POST /api/v1/research/graph/rebuild` | 清空图谱 → 遍历全部 `completed` 深度研究 Question（`context.kind=deep_research`，按时间正序）→ 逐个 `extractGraphPatch` + `mergeGraph`（串行，防 LLM 限流）→ 返回 `{ reports, nodeCount, edgeCount }` |

发起研究主路由 `POST /api/v1/research` 增加：

- 发起前 `loadGraph` + `queryGraph` → `graphContextBlock` → 传入 `runDeepResearch`（图谱不存在/为空时静默跳过）；
- `answer` 负载增加 `graphStats: { addedNodes, addedEdges, addedRelations }`（图谱更新成功时）。

### 4.7 前端：研究知识图谱面板

`components/research/GraphPanel.tsx`（client component，创建区右侧挂载）：

- `swr` 拉取 `GET /api/v1/research/graph`；
- **可视化**：无新增依赖的 SVG 径向布局——`report` 节点居中圈、`topic` 中圈、`entity` 外圈，边为直线，节点颜色按类型区分（复用现有 CSS 变量）；节点悬停显示 `summary`，点击 `report` 节点跳转历史研究详情（`/research` viewing 模式）；
- **相关历史研究**：按 `updatedAt` 倒序列出最近 3 条 `reports`（标题 + 摘要一行）；
- **重建按钮**：调 `POST .../rebuild`（loading 态，完成后刷新图谱）；
- 图谱为空时显示引导文案「完成第一次深度研究后，平台将自动沉淀研究知识图谱」。

### 4.8 事件协议（零新增事件类型）

全部新步骤复用现有 `AgentEvent`：

| stepId | 事件 | 说明 |
|--------|------|------|
| `dr_graph_query` | step | 图谱检索（命中 N 个节点 / 跳过：图谱为空） |
| `dr_sub_N_*` | tool_call/tool_result | 并行收集（与现有一致） |
| `dr_review` | step | 引用完整性校验结果 |
| `dr_graph_update` | tool_call/tool_result | 图谱增量更新（+N 节点 /+M 边，失败静默降级文案） |

前端 `AgentTimeline` 无需改动。

---

## 5. 测试计划

新增 `tests/research-graph.test.ts`（纯函数优先，延续项目既有测试风格）：

1. **store/mergeGraph**：新实体写入；同名实体（大小写/空格差异）去重合并 + reportIds 并集；边三元组去重；不改传入对象。
2. **query/queryGraph**：关键词命中排序；无命中返回空；中文 bigram 匹配「竞价成本」。
3. **prompts/graphContextBlock**：命中组装；空命中返回空串。
4. **review/verifyCitationIntegrity**：全部引用存在→通过；正文引用缺失编号→issues；引用表为空→不通过。
5. **extractor**：`extractJson` 容错（代码块包裹/裸 JSON/非法输入）——复用既有 `deep-research-operators.test.ts` 风格。

回归：`npm run test`（既有 76+ 用例）+ `npm run typecheck` + `npm run build`。

## 6. 降级与风险

| 风险 | 对策 |
|------|------|
| 图谱抽取 LLM 失败/超时 | 沉淀环节失败静默降级，研究主流程与报告产出零影响 |
| 图谱文件损坏 | `loadGraph` 解析失败返回空图并告警；可用 rebuild 重建 |
| 并行收集触发外部检索限流 | 并发固定 2；子问题内仍保留既有省额逻辑 |
| 图谱膨胀 | 节点上限 500（超限丢弃最旧且未被近期研究引用的实体）；rebuild 可压缩 |
| 注入背景撑爆上下文 | 背景块硬截断 2000 字（历史摘要各 ≤200 字） |

## 7. 不做的事（范围外）

- 不引入向量嵌入/向量库（词元重叠打分已满足当前规模，保持零新增依赖）；
- 不接入 UA 插件本体（其为 Claude Code 插件生态，本项目取其机制而非其代码）；
- 不改动任务问答（supervisor）链路，仅深度研究模块受益；
- 不引入图谱前端拖拽/缩放交互库（SVG 静态径向图足够）。
