"use client";

import { useCallback, useRef, useState } from "react";
import {
  applyAgentEvent,
  emptyStreamState,
  type AgentEvent,
  type AgentStreamState,
} from "@/lib/agent-events";

/**
 * Agent SSE 流消费 Hook
 *
 * fetch POST + ReadableStream 逐行解析 `data: {json}` 帧，
 * 事件经 applyAgentEvent 折叠为聚合状态（steps/charts/tables/citations/answer）
 */
export function useAgentStream() {
  const [state, setState] = useState<AgentStreamState>(emptyStreamState);
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(
    async (url: string, body: Record<string, unknown>, onDone?: (finalState: AgentStreamState) => void) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setStreaming(true);
      setState(emptyStreamState());

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          const errJson = await res.json().catch(() => null);
          throw new Error(errJson?.error?.message ?? `请求失败 (${res.status})`);
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error("无法读取响应流");

        const decoder = new TextDecoder();
        let buffer = "";
        let last: AgentStreamState = emptyStreamState();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const jsonStr = line.slice(6).trim();
            if (!jsonStr) continue;
            try {
              const event = JSON.parse(jsonStr) as AgentEvent;
              last = applyAgentEvent(last, event);
              setState(last);
            } catch {
              // 忽略解析失败的帧
            }
          }
        }

        onDone?.(last);
        return last;
      } finally {
        setStreaming(false);
      }
    },
    [],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
  }, []);

  const reset = useCallback(() => {
    setState(emptyStreamState());
  }, []);

  return { state, streaming, start, stop, reset };
}
