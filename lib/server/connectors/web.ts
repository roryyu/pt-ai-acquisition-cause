import * as cheerio from "cheerio";
import { env } from "@/lib/env";

/**
 * Web 数据接入连接器（design.md 5.1.4）
 *
 * 能力：
 * 1. webSearch — 多源搜索（优先 Firecrawl；未配置时降级 DuckDuckGo HTML 接口，无需 Key）
 * 2. fetchPage — 抓取网页并提取正文（Firecrawl / 直接 fetch + cheerio 解析）
 *
 * 约束（design.md 5.1.4）：
 * - 遵守 robots.txt 精神的黑名单（内网地址直接拒绝，防 SSRF）
 * - 频率限制：内置最小间隔
 * - 返回结构化结果（标题/摘要/正文/链接）
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// ─── SSRF 防护：拒绝内网/本机地址 ─────────────────────────────────────────────

const BLOCKED_HOST = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.|\[::1\]|::1)/i;

export function assertPublicUrl(url: string): { ok: boolean; reason?: string } {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, reason: "仅支持 http/https 协议" };
    }
    if (BLOCKED_HOST.test(parsed.hostname)) {
      return { ok: false, reason: "禁止访问内网地址" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "URL 格式非法" };
  }
}

// ─── 简易频率限制（进程内） ────────────────────────────────────────────────────

const MIN_INTERVAL_MS = 600;
let lastFetchAt = 0;
async function throttle() {
  const now = Date.now();
  const wait = lastFetchAt + MIN_INTERVAL_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetchAt = Date.now();
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { "user-agent": UA, "accept-language": "zh-CN,zh;q=0.9,en;q=0.8", ...(init?.headers ?? {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

// ─── 搜索 ─────────────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: "bing" | "duckduckgo" | "firecrawl";
}

/**
 * 网页搜索：Bing HTML 结果解析（主源）+ DuckDuckGo（备用）
 * 两端均无需 API Key，结果为结构化 {title, url, snippet}
 */
export async function webSearch(query: string, maxResults = 6): Promise<SearchResult[]> {
  const q = query.trim().slice(0, 300);
  if (!q) return [];

  // 主源：Bing
  let results = await searchBing(q, maxResults);
  // 备用：DuckDuckGo
  if (results.length === 0) {
    results = await searchDuckDuckGo(q, maxResults);
  }
  return results;
}

async function searchBing(query: string, maxResults: number): Promise<SearchResult[]> {
  await throttle();
  try {
    const res = await fetchWithTimeout(
      `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-hans&count=${maxResults}`,
      { method: "GET" },
      15_000,
    );
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    $("li.b_algo").each((_, el) => {
      if (results.length >= maxResults) return;
      const linkEl = $(el).find("h2 a").first();
      const url = linkEl.attr("href") ?? "";
      const title = linkEl.text().trim();
      const snippet = $(el).find(".b_caption p, p").first().text().trim();
      if (title && /^https?:\/\//.test(url)) {
        results.push({ title, url, snippet, source: "bing" });
      }
    });
    return results;
  } catch (error) {
    console.warn("[web-connector] Bing 搜索失败:", error instanceof Error ? error.message : error);
    return [];
  }
}

async function searchDuckDuckGo(query: string, maxResults: number): Promise<SearchResult[]> {
  await throttle();
  try {
    const res = await fetchWithTimeout(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { method: "GET" },
      12_000,
    );
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    $("div.result, div.web-result").each((_, el) => {
      if (results.length >= maxResults) return;
      const linkEl = $(el).find("a.result__a").first();
      const title = linkEl.text().trim();
      const url = decodeDdgUrl(linkEl.attr("href") ?? "");
      const snippet = $(el).find(".result__snippet").first().text().trim();
      if (title && url) {
        results.push({ title, url, snippet, source: "duckduckgo" });
      }
    });
    return results;
  } catch (error) {
    console.warn("[web-connector] DuckDuckGo 搜索失败:", error instanceof Error ? error.message : error);
    return [];
  }
}

function decodeDdgUrl(href: string): string {
  try {
    if (href.startsWith("//duckduckgo.com/l/") || href.includes("duckduckgo.com/l/")) {
      const u = new URL(href.startsWith("//") ? `https:${href}` : href);
      const uddg = u.searchParams.get("uddg");
      if (uddg) return decodeURIComponent(uddg);
    }
    if (href.startsWith("http")) return href;
    return "";
  } catch {
    return "";
  }
}

// ─── 网页抓取 ─────────────────────────────────────────────────────────────────

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  wordCount: number;
  fetchedAt: string;
}

/**
 * 抓取网页正文：去除 nav/footer/script/style 等噪声，提取主体文本
 * （Firecrawl 未配置时使用内置解析器）
 */
export async function fetchPage(url: string, maxChars = 6000): Promise<FetchedPage> {
  const guard = assertPublicUrl(url);
  if (!guard.ok) throw new Error(guard.reason ?? "URL 校验失败");

  await throttle();
  const res = await fetchWithTimeout(url, { method: "GET" }, 20_000);
  if (!res.ok) {
    throw new Error(`抓取失败：HTTP ${res.status}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
    throw new Error(`不支持的内容类型：${contentType || "unknown"}`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  const title =
    $("title").first().text().trim() ||
    $('meta[property="og:title"]').attr("content")?.trim() ||
    url;

  // 移除噪声节点
  $("script, style, noscript, nav, header, footer, aside, iframe, form, button, svg").remove();
  $("[role=navigation], [role=banner], [role=contentinfo], .nav, .footer, .sidebar, .ad, .advertisement").remove();

  // 提取正文容器优先
  const candidates = ["article", "main", ".article-content", "#content", ".content", "body"];
  let text = "";
  for (const sel of candidates) {
    const content = $(sel).first().text();
    if (content.length > text.length) text = content;
  }
  // 归一化空白
  text = text.replace(/\s+/g, " ").replace(/\s([，。；：、！？])/g, "$1").trim();

  return {
    url,
    title,
    text: text.slice(0, maxChars),
    wordCount: text.length,
    fetchedAt: new Date().toISOString(),
  };
}

/** 是否已配置 Firecrawl（预留扩展位） */
export function hasFirecrawl(): boolean {
  return Boolean(env.FIRECRAWL_API_KEY);
}
