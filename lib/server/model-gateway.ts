import OpenAI from "openai";
import { ChatOpenAI } from "@langchain/openai";
import { env } from "@/lib/env";

/**
 * 统一模型网关（design.md 12.1：所有 AI 调用必须经过同一 Agent 访问）
 *
 * - 主网关 + 备用网关自动降级（主网关 401/超时/5xx 时切换，5 分钟冷却内直接走备用）
 * - 对外提供两类出口：
 *   1. OpenAI SDK 原生接口（chatCompletion / chatCompletionStream）
 *   2. LangChain ChatOpenAI 工厂（getChatModel，供 LangGraph Agent 使用）
 */

interface GatewayConfig {
  name: "primary" | "fallback";
  baseURL: string;
  apiKey: string;
  model: string;
}

function primaryConfig(): GatewayConfig {
  return {
    name: "primary",
    baseURL: env.MODEL_GATEWAY_BASE_URL,
    apiKey: env.MODEL_GATEWAY_API_KEY,
    model: env.MODEL_GATEWAY_DEFAULT_MODEL,
  };
}

function fallbackConfig(): GatewayConfig | null {
  if (!env.MODEL_GATEWAY_FALLBACK_URL || !env.MODEL_GATEWAY_FALLBACK_KEY || !env.MODEL_GATEWAY_FALLBACK_MODEL) {
    return null;
  }
  return {
    name: "fallback",
    baseURL: env.MODEL_GATEWAY_FALLBACK_URL,
    apiKey: env.MODEL_GATEWAY_FALLBACK_KEY,
    model: env.MODEL_GATEWAY_FALLBACK_MODEL,
  };
}

/** 主网关熔断状态：失败时间戳（0 = 健康） */
let primaryFailedAt = 0;
const PRIMARY_COOLDOWN_MS = 5 * 60 * 1000;

function markPrimaryFailed() {
  primaryFailedAt = Date.now();
  console.warn("[model-gateway] 主网关失败，后续请求将走备用网关（冷却 5 分钟）");
}

function markPrimaryHealthy() {
  if (primaryFailedAt !== 0) {
    primaryFailedAt = 0;
    console.info("[model-gateway] 主网关恢复");
  }
}

/** 获取当前活跃网关配置：主网关健康（或冷却期外）优先 */
export function activeGateway(): GatewayConfig {
  const primaryDown = primaryFailedAt !== 0 && Date.now() - primaryFailedAt < PRIMARY_COOLDOWN_MS;
  const fb = fallbackConfig();
  if (primaryDown && fb) return fb;
  return primaryConfig();
}

/** 获取当前模型名（降级后为备用模型） */
export function getDefaultModel(): string {
  return activeGateway().model;
}

const _clients = new Map<string, OpenAI>();

function getClient(config: GatewayConfig): OpenAI {
  let client = _clients.get(config.baseURL);
  if (!client) {
    client = new OpenAI({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      timeout: env.MODEL_GATEWAY_TIMEOUT_MS,
      maxRetries: 1,
    });
    _clients.set(config.baseURL, client);
  }
  return client;
}

/** 请求是否属于"网关不可用"类错误（触发降级） */
function isGatewayUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const openaiErr = error as Error & { status?: number };
  if (openaiErr.status === 401 || openaiErr.status === 403) return true;
  if (openaiErr.status !== undefined && openaiErr.status >= 500) return true;
  return /timeout|connect|network|ECONN/i.test(error.message);
}

/**
 * 带降级的执行包装：主网关失败 → 标记熔断 → 立即用备用网关重试一次
 */
async function withFallback<T>(fn: (config: GatewayConfig) => Promise<T>): Promise<T> {
  const primary = primaryConfig();
  const fb = fallbackConfig();
  const startWithFallback = primaryFailedAt !== 0 && Date.now() - primaryFailedAt < PRIMARY_COOLDOWN_MS && fb;

  // 已熔断：直接走备用
  if (startWithFallback && fb) {
    return fn(fb);
  }

  try {
    const result = await fn(primary);
    markPrimaryHealthy();
    return result;
  } catch (error) {
    if (fb && isGatewayUnavailable(error)) {
      markPrimaryFailed();
      console.warn("[model-gateway] 主网关调用失败，降级到备用网关:", error instanceof Error ? error.message : error);
      return fn(fb);
    }
    throw error;
  }
}

/** 非流式补全（自动降级 + reasoning 模型空 content 自动重试） */
export async function chatCompletion(
  messages: OpenAI.ChatCompletionMessageParam[],
  options?: { model?: string; temperature?: number; maxTokens?: number },
): Promise<string> {
  const requested = options?.maxTokens ?? 4096;
  // reasoning 模型（如 mimo）会先输出思考过程，max_tokens 过小时 content 为空——给足预算并自动加倍重试
  let budget = Math.max(requested, 2048);
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = await withFallback(async (config) => {
      const client = getClient(config);
      const response = await client.chat.completions.create({
        model: options?.model ?? config.model,
        messages,
        temperature: options?.temperature ?? 0.7,
        max_tokens: budget,
      });
      const message = response.choices[0]?.message;
      return {
        content: message?.content ?? "",
        finishReason: response.choices[0]?.finish_reason,
        reasoning: (message as { reasoning_content?: string } | undefined)?.reasoning_content ?? "",
      };
    });
    if (content.content && content.content.trim().length > 0) {
      return content.content;
    }
    if (attempt === 0) {
      console.warn(`[model-gateway] content 为空（finish=${content.finishReason}，可能是 reasoning 消耗预算），加倍 max_tokens 重试`);
      budget = Math.max(budget * 2, 8192);
    }
  }
  return "";
}

/** 流式补全：返回异步迭代器（自动降级） */
export async function* chatCompletionStream(
  messages: OpenAI.ChatCompletionMessageParam[],
  options?: { model?: string; temperature?: number; maxTokens?: number },
): AsyncGenerator<string> {
  // 先选择网关（已熔断则直接备用，否则主网关，失败时在 catch 中切换）
  const fb = fallbackConfig();
  const primaryDown = primaryFailedAt !== 0 && Date.now() - primaryFailedAt < PRIMARY_COOLDOWN_MS;
  const config = primaryDown && fb ? fb : primaryConfig();

  const attempt = async function* (cfg: GatewayConfig): AsyncGenerator<string> {
    const client = getClient(cfg);
    const stream = await client.chat.completions.create({
      model: options?.model ?? cfg.model,
      messages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 4096,
      stream: true,
    });
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  };

  try {
    let received = false;
    for await (const piece of attempt(config)) {
      received = true;
      yield piece;
    }
    if (received && config.name === "primary") markPrimaryHealthy();
  } catch (error) {
    if (fb && config.name === "primary" && isGatewayUnavailable(error)) {
      markPrimaryFailed();
      console.warn("[model-gateway] 流式主网关失败，降级重试");
      yield* attempt(fb);
    } else {
      throw error;
    }
  }
}

/**
 * LangChain ChatOpenAI 工厂（供 LangGraph Agent / 工具调用使用）
 * bindTools 场景由 LangChain 自行处理；此处返回已配置当前活跃网关的实例。
 */
export function getChatModel(options?: {
  temperature?: number;
  maxTokens?: number;
  streaming?: boolean;
}): ChatOpenAI {
  const config = activeGateway();
  return new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey,
    configuration: {
      baseURL: config.baseURL,
      timeout: env.MODEL_GATEWAY_TIMEOUT_MS,
    },
    temperature: options?.temperature ?? 0.2,
    maxTokens: options?.maxTokens ?? 4096,
    streaming: options?.streaming ?? false,
  });
}

/** 网关健康检查（工作台/数据源页展示用） */
export async function gatewayHealth(): Promise<{
  active: string;
  model: string;
  ok: boolean;
  latencyMs?: number;
  error?: string;
}> {
  const config = activeGateway();
  const start = Date.now();
  try {
    const content = await chatCompletion([{ role: "user", content: "ping" }], { maxTokens: 8 });
    return {
      active: config.name,
      model: config.model,
      ok: true,
      latencyMs: Date.now() - start,
      ...(content ? {} : {}),
    };
  } catch (error) {
    return {
      active: config.name,
      model: config.model,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
