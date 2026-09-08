"use client";

/**
 * 洞察画布编辑器（重组件，含 tldraw）：由 ./client 经 next/dynamic 懒加载，
 * 避免 tldraw 大体积依赖阻塞路由切换与页面首屏。
 * tldraw 画布 + 实时绑定形状 + 导入面板 + 导出/邮件/定时任务动作
 * - 加载时还原 snapshot（兼容编辑器快照 {document,session} 与脚本产出的扁平 {store,schema}），
 *   编辑防抖 1.5s 后 PUT 保存，保存失败显式提示，卸载/刷新前冲刷防抖窗口内的改动
 * - 每 10s 轮询 bindings（运行中的源刷新内容）并按 shapeId 回填形状 props
 * - 导出 PNG：editor.toImage 生成 Blob，浏览器下载 + POST 存档
 * - 邮件发送 / 定时任务走 delivery / schedules API
 */
import "tldraw/tldraw.css";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import {
  Tldraw,
  createShapeId,
  getSnapshot,
  DefaultMainMenu,
  DefaultMainMenuContent,
  type Editor,
  type TLShapeId,
  type TLEditorSnapshot,
  type TLStoreSnapshot,
} from "tldraw";
import {
  ArrowLeft,
  CalendarClock,
  Download,
  ImagePlus,
  Mail,
  Play,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { LiveContentShapeUtil } from "@/components/canvas/live-shape";
import { ImportPanel, type ImportSource } from "@/components/canvas/ImportPanel";
import type { BindingView } from "@/lib/canvas/types";
import { apiFetch } from "@/lib/api-fetch";

/** 保存防抖时长（毫秒） */
const SAVE_DEBOUNCE_MS = 1500;
/** 绑定轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 10_000;

/** snapshot 的 store 段是否为 tldraw 可加载的完整结构（含 schema、store 为 map 形式） */
function hasValidStoreSegment(part: unknown): boolean {
  if (!part || typeof part !== "object" || Array.isArray(part)) return false;
  const { store, schema } = part as { store?: unknown; schema?: unknown };
  if (!schema || typeof schema !== "object") return false;
  // 早期迁移脚本产出的 store 为数组，交给 loadSnapshot 会在 upgradeSchema 抛 TypeError
  return !!store && typeof store === "object" && !Array.isArray(store);
}

/**
 * 校验 snapshot 是否具备 tldraw 可加载的完整结构，兼容两种落盘格式：
 * - 编辑器快照 `{ document: { store, schema }, session }`：tldraw v3+ `getSnapshot(store)` 的产物，
 *   即画布自动保存写入数据库的实际格式
 * - 扁平 store 快照 `{ store, schema }`：migrate-insights / repair-snapshots 脚本的产物
 * 两者 `<Tldraw snapshot>` 都能加载（TLEditorSnapshot | TLStoreSnapshot）。
 */
function isValidTldrawSnapshot(s: unknown): s is TLStoreSnapshot | TLEditorSnapshot {
  if (!s || typeof s !== "object" || Array.isArray(s)) return false;
  const obj = s as Record<string, unknown>;
  return hasValidStoreSegment(obj) || hasValidStoreSegment(obj.document);
}

interface DocMeta {
  id: string;
  title: string;
  kind: string;
  snapshot: TLStoreSnapshot | null;
}

interface ScheduleJobView {
  id: string;
  action: "email" | "export";
  cronExpr: string;
  recipients: string[];
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

/** 自定义形状注册表（模块级常量，避免每次渲染重建） */
const SHAPE_UTILS = [LiveContentShapeUtil];

/** 覆盖 tldraw 主菜单：在内容区前注入「导入内容」入口 */
function CanvasMainMenu({ onOpenImport }: { onOpenImport: () => void }) {
  return (
    <DefaultMainMenu>
      <button
        onClick={onOpenImport}
        style={{
          margin: "4px 8px",
          padding: "6px 10px",
          borderRadius: 8,
          fontSize: 12,
          fontWeight: 600,
          color: "#fff",
          background: "var(--purple)",
          cursor: "pointer",
        }}
      >
        导入数据分析 / 深度研究
      </button>
      <DefaultMainMenuContent />
    </DefaultMainMenu>
  );
}

export function InsightsDetailEditor({
  docId,
  initialImport,
}: {
  docId: string;
  /** 深链导入参数 {sourceType}:{sourceId}：挂载后自动创建形状与绑定，消费一次后清除 URL 参数 */
  initialImport?: string;
}) {
  const [doc, setDoc] = useState<DocMeta | null>(null);
  const [loadError, setLoadError] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "dirty" | "saving">("idle");
  const [importOpen, setImportOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState<"" | "email" | "schedule">("");
  const [jobs, setJobs] = useState<ScheduleJobView[]>([]);
  const [busy, setBusy] = useState(false);

  // 邮件对话框状态
  const [recipients, setRecipients] = useState("");
  // 定时任务对话框状态
  const [jobAction, setJobAction] = useState<"email" | "export">("email");
  const [jobCron, setJobCron] = useState("0 9 * * *");
  const [jobRecipients, setJobRecipients] = useState("");

  const editorRef = useRef<Editor | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 是否有未落盘的改动：防抖窗口内的编辑需在卸载/刷新前冲刷一次 */
  const dirtyRef = useRef(false);
  /** 深链导入只消费一次（防 StrictMode 双调用与重复触发） */
  const importConsumed = useRef(false);

  const notify = useCallback((msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(""), 3200);
  }, []);

  /** 立即 PUT 画布快照，返回是否真正落盘成功 */
  const persistSnapshot = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed) return false;
    dirtyRef.current = false;
    setSaveState("saving");
    try {
      const json = await apiFetch(`/api/v1/insights/${docId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        // keepalive：页面刷新/关闭时浏览器仍会送出该请求
        keepalive: true,
        body: JSON.stringify({ snapshot: getSnapshot(ed.store) }),
      });
      // HTTP 非 2xx 或业务失败（如快照超限）同样视为未保存，避免“已保存”误提示
      if (!json.ok) {
        throw new Error(json.error?.message ?? "保存失败");
      }
      setSaveState("idle");
      return true;
    } catch (error) {
      dirtyRef.current = true;
      setSaveState("dirty");
      notify(error instanceof Error ? error.message : "保存失败，内容仅保留在当前页面");
      return false;
    }
  }, [docId, notify]);

  /** 防抖保存画布快照 */
  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    setSaveState("dirty");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void persistSnapshot();
    }, SAVE_DEBOUNCE_MS);
  }, [persistSnapshot]);

  // 组件卸载（站内返回/切换画布）与页面刷新前，冲刷防抖窗口内的最后一次编辑
  useEffect(() => {
    const flush = () => {
      if (!dirtyRef.current) return;
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      void persistSnapshot();
    };
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
    };
  }, [persistSnapshot]);

  // 初始加载文档（含 snapshot）与定时任务列表
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const json = await apiFetch(`/api/v1/insights/${docId}`);
        if (cancelled) return;
        if (json.ok) {
          const d = json.data;
          setDoc({
            id: d.id,
            title: d.title,
            kind: d.kind,
            snapshot: (d.snapshot ?? null) as TLStoreSnapshot | null,
          });
          setJobs(d.schedules ?? []);
        } else {
          setLoadError(json.error?.message ?? "文档加载失败");
        }
      } catch {
        if (!cancelled) setLoadError("网络异常，无法加载文档");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId]);

  /** 将 binding 最新 payload 回填到画布形状（含 bindingId/源信息，供删形状级联清理与溯源回跳） */
  const applyBinding = useCallback((b: BindingView) => {
    const ed = editorRef.current;
    if (!ed || !b.shapeId) return;
    const shapeId = b.shapeId as TLShapeId;
    const shape = ed.getShape(shapeId);
    if (!shape) return;
    const next = {
      bindingId: b.id,
      sourceType: b.sourceType,
      sourceId: b.sourceId ?? "",
      payload: b.payload,
      sourceStatus: b.sourceStatus,
      updatedAt: b.updatedAt,
    };
    const cur = shape.props as Partial<typeof next>;
    // 轮询每 10s 回填一次：内容未变则跳过，否则会把快照刷成“脏”并反复覆盖写入
    if (
      cur.bindingId === next.bindingId &&
      cur.sourceType === next.sourceType &&
      cur.sourceId === next.sourceId &&
      cur.sourceStatus === next.sourceStatus &&
      cur.updatedAt === next.updatedAt &&
      JSON.stringify(cur.payload ?? null) === JSON.stringify(next.payload ?? null)
    ) {
      return;
    }
    ed.updateShape({ id: shapeId, type: "live-content", props: next });
  }, []);

  // 编辑器挂载：snapshot 由组件 prop 直接还原，此处仅记录 editor 实例
  const handleMount = useCallback((ed: Editor) => {
    editorRef.current = ed;
    setEditor(ed);
  }, []);

  // scheduleSave 经 Effect Event 调用：始终读到最新闭包，但不作为依赖，
  // 避免 scheduleSave 变化时反复重订阅 store.listen（React 19.2+ useEffectEvent）
  const emitScheduleSave = useEffectEvent(() => {
    scheduleSave();
  });

  // 注册用户编辑监听（在 effect 内订阅并返回清理函数，避免卸载后监听泄漏）：
  // 1. 任意用户编辑 → 防抖保存；2. 删除实时卡片 → 级联删除对应绑定（孤儿清理）
  useEffect(() => {
    if (!editor) return;
    const dispose = editor.store.listen(
      (event) => {
        emitScheduleSave();
        for (const removed of Object.values(event.changes.removed)) {
          if (
            removed.typeName === "shape" &&
            removed.type === "live-content" &&
            removed.props.bindingId
          ) {
            // fire-and-forget：绑定清理失败不影响画布编辑，下轮轮询会自然暴露孤儿
            void apiFetch(`/api/v1/insights/bindings/${removed.props.bindingId}`, {
              method: "DELETE",
            });
          }
        }
      },
      { source: "user" },
    );
    return dispose;
  }, [editor]);

  // 每 10s 轮询绑定，刷新运行中源的内容
  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const json = await apiFetch(`/api/v1/insights/${docId}/bindings?refresh=1`);
        if (cancelled || !json.ok) return;
        (json.data.bindings as BindingView[]).forEach(applyBinding);
      } catch {
        // 轮询失败静默，下一轮重试
      }
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [editor, docId, applyBinding]);

  /** 手动保存：跳过防抖立即落盘 */
  const handleSaveNow = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    void persistSnapshot();
  }, [persistSnapshot]);

  /** 导入来源：创建实时形状 → 建立绑定 → 回填 payload */
  const handleImport = useCallback(
    async (source: ImportSource) => {
      const ed = editorRef.current;
      if (!ed) return;
      const shapeId = createShapeId();
      const screenCenter = ed.getViewportScreenCenter();
      const page = ed.screenToPage(screenCenter);
      ed.createShape({
        id: shapeId,
        type: "live-content",
        x: page.x - 230,
        y: page.y - 170,
        props: { sourceStatus: "running" },
      });
      const json = await apiFetch(`/api/v1/insights/${docId}/bindings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceType: source.sourceType, sourceId: source.sourceId, shapeId }),
      });
      if (!json.ok) {
        ed.deleteShape(shapeId);
        throw new Error(json.error?.message ?? "绑定失败");
      }
      applyBinding(json.data as BindingView);
      scheduleSave();
      notify("已导入，源任务更新时将自动刷新");
    },
    [docId, applyBinding, scheduleSave, notify],
  );

  // 深链自动导入：?import={sourceType}:{sourceId}，编辑器就绪后消费一次并清除 URL 参数
  useEffect(() => {
    if (!editor || !initialImport || importConsumed.current) return;
    importConsumed.current = true;
    const sep = initialImport.indexOf(":");
    const sourceType = initialImport.slice(0, sep);
    const sourceId = initialImport.slice(sep + 1);
    if ((sourceType === "question" || sourceType === "research") && sourceId) {
      handleImport({ sourceType, sourceId }).catch(() => {
        notify("自动导入失败，可经右上角「导入」手动重试");
      });
    }
    // 无论成败都清除参数，避免刷新重复导入
    window.history.replaceState(null, "", `/insights/${docId}`);
  }, [editor, initialImport, docId, handleImport, notify]);

  /** 导出 PNG：下载 + 存档 */
  const handleExport = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed) return;
    const shapes = ed.getCurrentPageShapeIds();
    if (shapes.size === 0) {
      notify("画布为空，无可导出内容");
      return;
    }
    setBusy(true);
    try {
      const { blob } = await ed.toImage([...shapes], { format: "png" });
      // 浏览器下载
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${doc?.title ?? "insight"}.png`;
      a.click();
      URL.revokeObjectURL(url);
      // base64 存档
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      const json = await apiFetch(`/api/v1/insights/${docId}/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pngBase64: dataUrl }),
      });
      notify(json.ok ? "已导出并存档" : json.error?.message ?? "存档失败");
    } catch {
      notify("导出失败，请重试");
    } finally {
      setBusy(false);
    }
  }, [doc, docId, notify]);

  /** 发送邮件 */
  const handleSendEmail = useCallback(async () => {
    if (!recipients.trim() || busy) return;
    setBusy(true);
    try {
      const json = await apiFetch(`/api/v1/insights/${docId}/deliver`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "email", recipients: recipients.trim() }),
      });
      if (json.ok) {
        const mock = json.data.detail?.mock;
        notify(mock ? "已记录（SMTP 未接入，内容已落盘）" : "邮件已发送");
        setDialog("");
        setRecipients("");
      } else {
        notify(json.error?.message ?? "发送失败");
      }
    } catch {
      notify("网络异常，发送失败");
    } finally {
      setBusy(false);
    }
  }, [docId, recipients, busy, notify]);

  /** 创建定时任务 */
  const handleCreateJob = useCallback(async () => {
    if (busy) return;
    const list = jobRecipients
      .split(/[,，;；\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (jobAction === "email" && list.length === 0) {
      notify("邮件任务需要填写收件人");
      return;
    }
    setBusy(true);
    try {
      const json = await apiFetch("/api/v1/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          docId,
          action: jobAction,
          cronExpr: jobCron.trim(),
          recipients: jobAction === "email" ? list : [],
        }),
      });
      if (json.ok) {
        setJobs((prev) => [json.data, ...prev]);
        setDialog("");
        notify("定时任务已创建");
      } else {
        notify(json.error?.message ?? "创建失败");
      }
    } catch {
      notify("网络异常，创建失败");
    } finally {
      setBusy(false);
    }
  }, [docId, jobAction, jobCron, jobRecipients, busy, notify]);

  /** 删除定时任务 */
  const handleDeleteJob = useCallback(
    async (id: string) => {
      try {
        const json = await apiFetch(`/api/v1/schedules/${id}`, { method: "DELETE" });
        if (json.ok) setJobs((prev) => prev.filter((j) => j.id !== id));
        else notify(json.error?.message ?? "删除失败");
      } catch {
        notify("网络异常，删除失败");
      }
    },
    [notify],
  );

  /** 手动触发到期任务（POST /api/v1/schedules/run） */
  const handleRunJobs = useCallback(async () => {
    setBusy(true);
    try {
      const json = await apiFetch("/api/v1/schedules/run", { method: "POST" });
      if (json.ok) {
        notify(`已触发，本次执行 ${json.data.executed ?? 0} 个任务`);
        // 刷新任务列表的 lastRunAt
        const list = await apiFetch(`/api/v1/schedules?docId=${docId}`);
        if (list.ok) setJobs(list.data.jobs ?? []);
      } else {
        notify(json.error?.message ?? "触发失败");
      }
    } catch {
      notify("网络异常，触发失败");
    } finally {
      setBusy(false);
    }
  }, [docId, notify]);

  const tldrawComponents = useMemo(
    () => ({
      MainMenu: () => <CanvasMainMenu onOpenImport={() => setImportOpen(true)} />,
    }),
    [],
  );

  // 加载失败 / 404
  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center py-24" role="alert">
        <p className="text-sm" style={{ color: "var(--danger)" }}>{loadError}</p>
        <Link href="/insights" className="mt-3 text-xs underline" style={{ color: "var(--muted)" }}>
          返回洞察画布列表
        </Link>
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="flex items-center justify-center py-24" role="status">
        <span className="text-sm" style={{ color: "var(--muted)" }}>画布加载中...</span>
      </div>
    );
  }

  return (
    <div className="-mx-2 space-y-3">
      {/* 顶部工具条 */}
      <div className="flex items-center gap-3">
        <Link
          href="/insights"
          className="flex items-center gap-1.5 rounded-[8px] border px-2.5 py-1.5 text-xs transition-colors hover:bg-black/5"
          style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
        >
          <ArrowLeft size={13} />
          返回列表
        </Link>
        <h1 className="flex-1 truncate text-base font-semibold" style={{ color: "var(--ink)" }}>
          {doc.title}
        </h1>
        <span className="text-[11px]" style={{ color: "var(--muted)" }} role="status">
          {saveState === "saving" ? "保存中..." : saveState === "dirty" ? "待保存" : "已保存"}
        </span>
        <button
          onClick={handleSaveNow}
          disabled={saveState === "idle"}
          className="flex items-center gap-1.5 rounded-[8px] border px-2.5 py-1.5 text-xs disabled:opacity-40"
          style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
        >
          <Save size={13} />
          保存
        </button>
        <button
          onClick={() => setImportOpen((v) => !v)}
          className="flex items-center gap-1.5 rounded-[8px] border px-2.5 py-1.5 text-xs"
          style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
        >
          <ImagePlus size={13} />
          导入
        </button>
        <button
          onClick={handleExport}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-[8px] border px-2.5 py-1.5 text-xs disabled:opacity-40"
          style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
        >
          <Download size={13} />
          导出 PNG
        </button>
        <button
          onClick={() => setDialog("email")}
          className="flex items-center gap-1.5 rounded-[8px] border px-2.5 py-1.5 text-xs"
          style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
        >
          <Mail size={13} />
          发送邮件
        </button>
        <button
          onClick={() => setDialog("schedule")}
          className="flex items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 text-xs font-medium text-white"
          style={{ background: "var(--purple)" }}
        >
          <CalendarClock size={13} />
          定时任务
        </button>
      </div>

      {/* 画布区域（相对定位承载导入面板与提示条） */}
      <div
        className="relative overflow-hidden rounded-[var(--radius-sm)] border"
        style={{ height: "calc(100vh - 232px)", minHeight: 480, borderColor: "var(--line)" }}
      >
        <Tldraw
          key={doc.id}
          shapeUtils={SHAPE_UTILS}
          snapshot={isValidTldrawSnapshot(doc.snapshot) ? doc.snapshot : undefined}
          components={tldrawComponents}
          onMount={handleMount}
        />
        <ImportPanel open={importOpen} onClose={() => setImportOpen(false)} onImport={handleImport} />
        {notice && (
          <div
            className="absolute bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full px-4 py-2 text-xs shadow-lg"
            style={{ background: "var(--ink)", color: "#fff" }}
            role="status"
          >
            {notice}
          </div>
        )}
      </div>

      {/* 邮件发送对话框 */}
      {dialog === "email" && (
        <Modal title="发送洞察邮件" onClose={() => setDialog("")}>
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            正文为画布文本摘要，并附带最近一次导出 PNG（先点「导出 PNG」可生成）。
            SMTP 未接入时将落盘记录。
          </p>
          <label className="mt-4 block text-xs font-medium" style={{ color: "var(--ink-soft)" }}>
            收件人（多个用逗号分隔）
          </label>
          <input
            type="text"
            value={recipients}
            onChange={(e) => setRecipients(e.target.value)}
            placeholder="alice@example.com, bob@example.com"
            className="mt-1.5 w-full rounded-[8px] border px-3 py-2.5 text-sm outline-none focus:border-[var(--purple)]"
            style={{ borderColor: "var(--line)", color: "var(--ink)", background: "var(--paper)" }}
            autoFocus
          />
          <div className="mt-6 flex justify-end gap-3">
            <ModalCancel onClose={() => setDialog("")} />
            <button
              onClick={handleSendEmail}
              disabled={!recipients.trim() || busy}
              className="rounded-[8px] px-5 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
              style={{ background: "var(--purple)" }}
            >
              {busy ? "发送中..." : "发送"}
            </button>
          </div>
        </Modal>
      )}

      {/* 定时任务对话框 */}
      {dialog === "schedule" && (
        <Modal title="定时任务" onClose={() => setDialog("")}>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium" style={{ color: "var(--ink-soft)" }}>动作</label>
              <select
                value={jobAction}
                onChange={(e) => setJobAction(e.target.value as "email" | "export")}
                className="mt-1.5 w-full rounded-[8px] border px-3 py-2.5 text-sm outline-none focus:border-[var(--purple)]"
                style={{ borderColor: "var(--line)", color: "var(--ink)", background: "var(--paper)" }}
              >
                <option value="email">发送邮件</option>
                <option value="export">导出存档</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium" style={{ color: "var(--ink-soft)" }}>
                cron 表达式
              </label>
              <input
                type="text"
                value={jobCron}
                onChange={(e) => setJobCron(e.target.value)}
                placeholder="0 9 * * *"
                className="mt-1.5 w-full rounded-[8px] border px-3 py-2.5 text-sm outline-none focus:border-[var(--purple)]"
                style={{ borderColor: "var(--line)", color: "var(--ink)", background: "var(--paper)" }}
              />
              <p className="mt-1 text-[10px]" style={{ color: "var(--muted)" }}>
                示例：0 9 * * * 每天 9 点；0 9 * * 1 每周一 9 点
              </p>
            </div>
          </div>
          {jobAction === "email" && (
            <div className="mt-4">
              <label className="block text-xs font-medium" style={{ color: "var(--ink-soft)" }}>
                收件人（多个用逗号分隔）
              </label>
              <input
                type="text"
                value={jobRecipients}
                onChange={(e) => setJobRecipients(e.target.value)}
                placeholder="alice@example.com"
                className="mt-1.5 w-full rounded-[8px] border px-3 py-2.5 text-sm outline-none focus:border-[var(--purple)]"
                style={{ borderColor: "var(--line)", color: "var(--ink)", background: "var(--paper)" }}
              />
            </div>
          )}

          {/* 该文档已有任务列表 */}
          <div className="mt-5">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-medium" style={{ color: "var(--ink-soft)" }}>
                已有任务（{jobs.length}）
              </h4>
              <button
                onClick={handleRunJobs}
                disabled={busy}
                className="flex items-center gap-1 rounded-[6px] border px-2 py-1 text-[11px] disabled:opacity-40"
                style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
              >
                <Play size={11} />
                立即触发到期任务
              </button>
            </div>
            <div className="mt-2 max-h-40 space-y-2 overflow-y-auto">
              {jobs.length === 0 ? (
                <p className="py-2 text-center text-[11px]" style={{ color: "var(--muted)" }}>
                  暂无定时任务
                </p>
              ) : (
                jobs.map((j) => (
                  <div
                    key={j.id}
                    className="flex items-center gap-2 rounded-[8px] border px-3 py-2 text-[11px]"
                    style={{ borderColor: "var(--line)", background: "var(--paper)" }}
                  >
                    <span className="font-mono" style={{ color: "var(--ink)" }}>{j.cronExpr}</span>
                    <span style={{ color: "var(--muted)" }}>
                      {j.action === "email" ? `邮件 → ${j.recipients.join(", ") || "无收件人"}` : "导出存档"}
                    </span>
                    <span className="flex-1" />
                    <span style={{ color: "var(--muted)" }}>
                      {j.lastRunAt
                        ? `上次 ${new Date(j.lastRunAt).toLocaleString("zh-CN")}`
                        : "未执行"}
                    </span>
                    <button
                      onClick={() => handleDeleteJob(j.id)}
                      className="rounded-full p-1 hover:bg-black/5"
                      aria-label="删除定时任务"
                    >
                      <Trash2 size={12} style={{ color: "var(--muted)" }} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="mt-6 flex justify-end gap-3">
            <ModalCancel onClose={() => setDialog("")} />
            <button
              onClick={handleCreateJob}
              disabled={busy}
              className="rounded-[8px] px-5 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
              style={{ background: "var(--purple)" }}
            >
              {busy ? "创建中..." : "创建任务"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** 通用居中对话框外壳 */
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgb(24 18 36 / 42%)" }}>
      <div
        className="w-[min(520px,calc(100%-48px))] rounded-[var(--radius-sm)] border p-7"
        style={{ borderColor: "var(--line)", background: "#fff", boxShadow: "0 24px 80px rgb(28 18 48 / 24%)" }}
        role="dialog"
        aria-label={title}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold" style={{ color: "var(--ink)" }}>{title}</h2>
          <button onClick={onClose} className="rounded-full p-1 hover:bg-black/5" aria-label="关闭">
            <X size={18} style={{ color: "var(--muted)" }} />
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

function ModalCancel({ onClose }: { onClose: () => void }) {
  return (
    <button
      onClick={onClose}
      className="rounded-[8px] px-4 py-2 text-sm hover:bg-black/5"
      style={{ color: "var(--ink-soft)" }}
    >
      取消
    </button>
  );
}
