/**
 * Adjust 报告服务数据同步脚本（CLI 入口）
 *
 * 核心逻辑已下沉至 lib/server/integrations/adjust-sync.ts（与
 * `POST /api/v1/syncs/adjust` 服务内触发共用），本脚本仅负责
 * 环境变量加载、--days 参数解析与控制台输出。
 *
 * 运行：npx tsx scripts/sync-adjust-data.ts [--days N | --from YYYY-MM-DD --to YYYY-MM-DD] [--reset]
 *   --days N       回补近 N 天（默认 3：昨日 + 回补 2 天，Adjust 数据 T+1）
 *   --from / --to  回补绝对日期区间（含端点，YYYY-MM-DD），补任意历史中段（如已同步到 5/31 再补 5/1~5/30）；同时提供时优先于 --days
 *   --reset        清空重建：DROP 后按最新 5 维 DDL 重建再全量回补（PK 变更/首次重同步用）
 * 幂等：重复执行为 upsert / 先删后插，可安全重跑。
 */
export {}; // 标记为模块（顶层 await 需要）

process.loadEnvFile?.();

// --days N 解析（默认 3：昨日 + 回补 2 天，覆盖 Adjust T+1 数据修正窗口）
const daysArgIdx = process.argv.indexOf("--days");
const days = daysArgIdx >= 0 ? Math.max(1, Number(process.argv[daysArgIdx + 1]) || 3) : 3;
// --from / --to 解析（绝对日期区间 YYYY-MM-DD，回补历史中段；同时提供时优先于 --days）
const fromIdx = process.argv.indexOf("--from");
const toIdx = process.argv.indexOf("--to");
const from = fromIdx >= 0 ? process.argv[fromIdx + 1] : undefined;
const to = toIdx >= 0 ? process.argv[toIdx + 1] : undefined;
// --reset 解析（清空重建：DROP 后按最新 5 维 DDL 重建再全量回补）
const reset = process.argv.includes("--reset");

// 动态导入：确保 .env 先于 env 校验加载（静态 import 会提升先于 loadEnvFile 执行）
const { runAdjustSync } = await import("../lib/server/integrations/adjust-sync");

runAdjustSync({ days, from, to, reset, onLog: console.log })
  .then((result) => {
    if (result.skipped) console.log(`（本次跳过：${result.skipped}）`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("Adjust 数据同步失败:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
