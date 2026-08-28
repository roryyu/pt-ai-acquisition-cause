/**
 * SSE（Server-Sent Events）流式响应工具
 *
 * 问答 / 深度研究 / 算子试运行等接口共用：
 * 后台任务产生的事件实时推送给前端（fetch + ReadableStream 消费）。
 */

export type SseSender = (event: unknown) => void;

/**
 * 构造 SSE 响应：streamBody 内通过 send(event) 推送，
 * 事件以 `data: {json}\n\n` 帧格式输出。
 */
export function sseResponse(streamBody: (send: SseSender) => Promise<void>): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send: SseSender = (event) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // 客户端断开等场景
          closed = true;
        }
      };
      try {
        await streamBody(send);
      } finally {
        if (!closed) {
          try {
            controller.close();
          } catch {
            // already closed
          }
          closed = true;
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
