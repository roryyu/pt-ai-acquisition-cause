import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { getChatModel } from "@/lib/server/model-gateway";
import { MCP_AGENT_PROMPT } from "@/lib/server/agents/prompts";

/**
 * MCP 数据源连接器（design.md 5.1 数据接入层 · mcp 类型）
 *
 * 经内部 MCP 代理（streamable HTTP，自动回退 SSE）连接第三方 MCP 服务：
 * 1. listMcpTools     — 工具发现（名称/描述/参数 schema）
 * 2. callMcpTool      — 单工具直接调用（管理台调试）
 * 3. runMcpReactAgent — ReAct Agent：LLM 自主规划并调用 MCP 工具完成自然语言任务
 *
 * 约束：每次操作独立建连、用完即关（无长连接池）；结果截断至 50KB。
 */

/** MCP 数据源配置（存于 data_sources.config） */
export interface McpSourceConfig {
  /** 内部 MCP 代理 streamable HTTP 地址 */
  proxyUrl: string;
  /** 访问代理所需 header（如内部鉴权） */
  headers?: Record<string, string>;
}

const MAX_RESULT_BYTES = 50 * 1024;
const SERVER_NAME = "proxy";

/** 建连 → 执行 → 关闭的统一包装 */
async function withMcpClient<T>(
  config: McpSourceConfig,
  fn: (tools: StructuredToolInterface[]) => Promise<T>,
): Promise<T> {
  const client = new MultiServerMCPClient({
    mcpServers: {
      [SERVER_NAME]: {
        transport: "http",
        url: config.proxyUrl,
        headers: config.headers,
        automaticSSEFallback: true,
      },
    },
  });
  try {
    const tools = await client.getTools();
    return await fn(tools as StructuredToolInterface[]);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_RESULT_BYTES) return { text, truncated: false };
  return { text: text.slice(0, MAX_RESULT_BYTES), truncated: true };
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

// ─── 工具发现 ─────────────────────────────────────────────────────────────────

export interface McpToolMeta {
  name: string;
  description: string;
  /** JSON Schema（供前端展示参数结构） */
  inputSchema: unknown;
}

/** 列出代理侧全部 MCP 工具 */
export async function listMcpTools(config: McpSourceConfig): Promise<McpToolMeta[]> {
  return withMcpClient(config, async (tools) =>
    tools.map((t) => ({
      name: t.name,
      description: (t.description ?? "").slice(0, 500),
      inputSchema: toJsonSchema(t.schema),
    })),
  );
}

/** LangChain 工具 schema → 可序列化 JSON Schema（zod schema 时提取 shape 概要） */
function toJsonSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return {};
  // MCP adapter 的 DynamicStructuredTool schema 通常已是 JSON Schema 对象
  try {
    return JSON.parse(JSON.stringify(schema));
  } catch {
    return {};
  }
}

// ─── 单工具调用 ────────────────────────────────────────────────────────────────

export interface McpCallResult {
  result: string;
  elapsedMs: number;
  truncated: boolean;
}

/** 直接调用单个 MCP 工具（管理台调试） */
export async function callMcpTool(
  config: McpSourceConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  return withMcpClient(config, async (tools) => {
    const target = tools.find((t) => t.name === toolName || t.name.endsWith(`__${toolName}`));
    if (!target) {
      throw new Error(`工具 ${toolName} 不存在，可用工具：${tools.map((t) => t.name).join(", ").slice(0, 500)}`);
    }
    const start = Date.now();
    const output = await target.invoke(args);
    const { text, truncated } = truncate(stringifyToolOutput(output));
    return { result: text, elapsedMs: Date.now() - start, truncated };
  });
}

// ─── ReAct Agent ─────────────────────────────────────────────────────────────

export interface McpAgentStep {
  tool: string;
  input: unknown;
  output: string;
  elapsedMs: number;
}

export interface McpAgentResult {
  answer: string;
  steps: McpAgentStep[];
}

/**
 * ReAct Agent 执行：LLM 基于 MCP 工具集自主规划、调用、汇总
 * （提示词 MCP_AGENT_PROMPT 见 agents/prompts.ts）
 * @param task 自然语言任务
 * @param onStep 每步工具调用完成时的回调（用于事件外送）
 */
export async function runMcpReactAgent(
  config: McpSourceConfig,
  task: string,
  onStep?: (step: McpAgentStep) => void,
): Promise<McpAgentResult> {
  return withMcpClient(config, async (tools) => {
    if (tools.length === 0) {
      throw new Error("MCP 代理未暴露任何工具");
    }
    const agent = createReactAgent({
      llm: getChatModel({ temperature: 0 }),
      tools,
      prompt: MCP_AGENT_PROMPT,
    });

    const steps: McpAgentStep[] = [];
    const startedAt = new Map<string, { tool: string; input: unknown; start: number }>();
    let finalAnswer = "";

    const stream = await agent.streamEvents(
      { messages: [{ role: "user", content: task }] },
      { version: "v2", recursionLimit: 25 },
    );
    for await (const event of stream) {
      if (event.event === "on_chat_model_stream") {
        const chunk = event.data?.chunk as { content?: unknown } | undefined;
        if (typeof chunk?.content === "string") finalAnswer += chunk.content;
      }
      if (event.event === "on_tool_start") {
        finalAnswer = "";
        startedAt.set(event.run_id, {
          tool: event.name,
          input: event.data?.input,
          start: Date.now(),
        });
      }
      if (event.event === "on_tool_end") {
        const meta = startedAt.get(event.run_id);
        const { text } = truncate(stringifyToolOutput(extractToolOutput(event.data?.output)));
        const step: McpAgentStep = {
          tool: meta?.tool ?? event.name,
          input: meta?.input ?? null,
          output: text.slice(0, 2000),
          elapsedMs: meta ? Date.now() - meta.start : 0,
        };
        steps.push(step);
        onStep?.(step);
      }
    }
    return { answer: finalAnswer.trim(), steps };
  });
}

/** on_tool_end 的 output 可能是 ToolMessage，提取其 content */
function extractToolOutput(output: unknown): unknown {
  if (output && typeof output === "object" && "content" in output) {
    return (output as { content: unknown }).content;
  }
  return output;
}
