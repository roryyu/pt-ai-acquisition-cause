import * as cheerio from "cheerio";
import * as DDG from "duck-duck-scrape";
import { extractFromHtml } from "@extractus/article-extractor";
import { env } from "@/lib/env";

/**
 * Web 数据接入连接器（design.md 5.1.4）
 *
 * 能力（纯 Node 进程内，无需额外服务 / 无需 Docker / 无需 API Key）：
 * 1. webSearch — 多源搜索：DDG Lite（主，轻量端点带摘要）
 *    → DDG HTML / duck-duck-scrape（备）→ Bing RSS / Bing HTML（末位兜底）
 * 2. fetchPage — 抓取网页并提取正文：@extractus/article-extractor（Reader-Mode 级）
 *    → cheerio 启发式（兜底）
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
 * 网页搜索（纯 Node 进程内，无需 Key / 服务 / Docker）：
 * 主源 DDG Lite（轻量 HTML 端点，反爬宽松，结果相关度高且带摘要）
 * → DDG HTML（旧端点兜底）→ duck-duck-scrape（库直连，部分网络可用）
 * → Bing RSS（官方 XML feed）→ Bing HTML（最后兜底）
 * 注：Bing 对机器人客户端会降级返回低相关结果，故置于链路末位
 */
export async function webSearch(query: string, maxResults = 6): Promise<SearchResult[]> {
  const q = query.trim().slice(0, 300);
  if (!q) return [];

  let results = await searchDdgLite(q, maxResults);
  if (results.length === 0) results = await searchDuckDuckGo(q, maxResults);
  if (results.length === 0) results = await searchDdgLib(q, maxResults);
  if (results.length === 0) results = await searchBingRss(q, maxResults);
  if (results.length === 0) results = await searchBing(q, maxResults);
  return results;
}

/** 主源：DuckDuckGo Lite（极简 HTML 端点，结构稳定：a.result-link 标题 + 相邻 tr 的 td.result-snippet 摘要） */
async function searchDdgLite(query: string, maxResults: number): Promise<SearchResult[]> {
  await throttle();
  try {
    const res = await fetchWithTimeout(
      `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
      { method: "GET" },
      12_000,
    );
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    $("a.result-link").each((_, el) => {
      if (results.length >= maxResults) return;
      const title = $(el).text().trim();
      const url = decodeDdgUrl($(el).attr("href") ?? "");
      // 摘要位于标题所在 tr 的相邻 tr
      const snippet = $(el).closest("tr").next("tr").find("td.result-snippet").text().trim();
      if (title && url && !url.includes("duckduckgo.com/y.js")) {
        results.push({ title, url, snippet, source: "duckduckgo" });
      }
    });
    return results;
  } catch (error) {
    console.warn("[web-connector] DDG Lite 搜索失败:", error instanceof Error ? error.message : error);
    return [];
  }
}

/** 备源：duck-duck-scrape（npm 库，进程内直连，返回带摘要的结构化结果；部分网络会被风控拦截） */
async function searchDdgLib(query: string, maxResults: number): Promise<SearchResult[]> {
  await throttle();
  try {
    const res = await DDG.search(query, {
      safeSearch: DDG.SafeSearchType.OFF,
      locale: "cn-zh",
    });
    if (!res || res.noResults) return [];
    const out: SearchResult[] = [];
    for (const r of res.results) {
      if (out.length >= maxResults) break;
      const url = r.url ?? "";
      const title = (r.title ?? "").trim();
      if (title && /^https?:\/\//.test(url)) {
        out.push({ title, url, snippet: (r.description ?? "").trim(), source: "duckduckgo" });
      }
    }
    return out;
  } catch (error) {
    console.warn("[web-connector] DDG(lib) 搜索失败:", error instanceof Error ? error.message : error);
    return [];
  }
}

/** 次源：Bing 官方 RSS feed（结构化 XML，反爬远弱于 HTML 页，复用 cheerio 解析） */
async function searchBingRss(query: string, maxResults: number): Promise<SearchResult[]> {
  await throttle();
  try {
    const res = await fetchWithTimeout(
      `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&setmkt=zh-CN&count=${maxResults}`,
      { method: "GET" },
      15_000,
    );
    if (!res.ok) return [];
    const xml = await res.text();
    const $ = cheerio.load(xml, { xml: true });
    const results: SearchResult[] = [];
    $("item").each((_, el) => {
      if (results.length >= maxResults) return;
      const title = $(el).find("title").text().trim();
      const url = $(el).find("link").text().trim();
      const snippet = $(el).find("description").text().trim();
      if (title && /^https?:\/\//.test(url)) {
        results.push({ title, url, snippet, source: "bing" });
      }
    });
    return results;
  } catch (error) {
    console.warn("[web-connector] Bing RSS 搜索失败:", error instanceof Error ? error.message : error);
    return [];
  }
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
      // 过滤广告链接（uddg 解码后指向 duckduckgo.com/y.js 的为广告）
      if (title && url && !url.includes("duckduckgo.com/y.js")) {
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
 * 抓取网页正文：
 * 主提取器 @extractus/article-extractor（Reader-Mode 级正文抽取，自动去噪）
 * → 兜底 cheerio 启发式（抽取失败或正文过短时）
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

  // 主提取器：article-extractor（返回清洗后的正文 HTML 与标题）
  let title = "";
  let text = "";
  try {
    const article = await extractFromHtml(html, url);
    if (article) {
      title = (article.title ?? "").trim();
      text = cheerio.load(article.content ?? "").text();
    }
  } catch (error) {
    console.warn(
      "[web-connector] article-extractor 抽取失败，降级 cheerio:",
      error instanceof Error ? error.message : error,
    );
  }

  // 兜底：原 cheerio 启发式解析（抽取失败或正文过短时）
  if (text.trim().length < 120) {
    const $ = cheerio.load(html);
    title =
      title ||
      $("title").first().text().trim() ||
      $('meta[property="og:title"]').attr("content")?.trim() ||
      url;
    // 移除噪声节点
    $("script, style, noscript, nav, header, footer, aside, iframe, form, button, svg").remove();
    $("[role=navigation], [role=banner], [role=contentinfo], .nav, .footer, .sidebar, .ad, .advertisement").remove();
    // 提取正文容器优先
    const candidates = ["article", "main", ".article-content", "#content", ".content", "body"];
    let fallbackText = "";
    for (const sel of candidates) {
      const content = $(sel).first().text();
      if (content.length > fallbackText.length) fallbackText = content;
    }
    if (fallbackText.length > text.length) text = fallbackText;
  }

  if (!title) title = url;
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
