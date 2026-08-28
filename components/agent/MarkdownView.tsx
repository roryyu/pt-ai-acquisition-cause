"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Markdown 渲染（Agent 回答 / 研究报告 / 报告正文共用）
 * 样式与设计系统对齐，链接可外跳
 */
export function MarkdownView({ content }: { content: string }) {
  return (
    <div className="markdown-body text-sm leading-relaxed" style={{ color: "var(--ink-soft)" }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (props) => (
            <h1 className="mt-5 mb-2.5 text-lg font-bold" style={{ color: "var(--ink)" }} {...props} />
          ),
          h2: (props) => (
            <h2
              className="mt-5 mb-2 border-b pb-1.5 text-base font-bold"
              style={{ color: "var(--ink)", borderColor: "var(--line)" }}
              {...props}
            />
          ),
          h3: (props) => (
            <h3 className="mt-4 mb-1.5 text-sm font-bold" style={{ color: "var(--purple)" }} {...props} />
          ),
          p: (props) => <p className="my-2" {...props} />,
          ul: (props) => <ul className="my-2 list-disc space-y-1 pl-5" {...props} />,
          ol: (props) => <ol className="my-2 list-decimal space-y-1 pl-5" {...props} />,
          li: (props) => <li className="leading-relaxed" {...props} />,
          strong: (props) => (
            <strong className="font-semibold" style={{ color: "var(--ink)" }} {...props} />
          ),
          blockquote: (props) => (
            <blockquote
              className="my-3 rounded-r-md border-l-4 py-1.5 pl-3 pr-2 text-xs"
              style={{ borderColor: "var(--purple)", background: "var(--purple-pale)" }}
              {...props}
            />
          ),
          code: ({ className, children, ...rest }) => {
            const isBlock = /language-/.test(className ?? "");
            if (isBlock) {
              return (
                <code
                  className="block overflow-x-auto rounded-md p-3 font-mono text-xs"
                  style={{ background: "var(--purple-pale)", color: "var(--ink)" }}
                  {...rest}
                >
                  {children}
                </code>
              );
            }
            return (
              <code
                className="rounded px-1 py-0.5 font-mono text-xs"
                style={{ background: "var(--purple-pale)", color: "var(--purple)" }}
                {...rest}
              >
                {children}
              </code>
            );
          },
          pre: (props) => <pre className="my-3" {...props} />,
          table: (props) => (
            <div className="my-3 overflow-x-auto">
              <table className="w-full border-collapse text-xs" {...props} />
            </div>
          ),
          thead: (props) => (
            <thead style={{ background: "var(--purple-pale)" }} {...props} />
          ),
          th: (props) => (
            <th
              className="whitespace-nowrap border px-2.5 py-1.5 text-left font-semibold"
              style={{ borderColor: "var(--line)", color: "var(--ink)" }}
              {...props}
            />
          ),
          td: (props) => (
            <td
              className="border px-2.5 py-1.5"
              style={{ borderColor: "var(--line)" }}
              {...props}
            />
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-dotted underline-offset-2"
              style={{ color: "var(--purple)" }}
            >
              {children}
            </a>
          ),
          hr: () => <hr className="my-4" style={{ borderColor: "var(--line)" }} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
