/**
 * Adjust 报告服务数据同步脚本 —— API → 本地 PG → 语义层
 *
 * 链路（doc/开发进度20260902.md §3.2）：
 * 1. 拉取 Adjust RS API /csv_report（day×network×country_code 粒度，
 *    指标：impressions/clicks/installs/sessions/register/FD/RD/network_cost）
 * 2. CSV 解析（lib/server/connectors/csv.ts，去 BOM + 数值推断）
 * 3. 幂等 upsert 至 data.adjust_daily_metrics（任务问答本地主链路）
 * 4. 挂载自定义语义模型「Adjust 投放日指标」（cause.semantic_models，
 *    关联已注册的「Adjust 报告服务」API 数据源；未注册时 data_source_id=null
 *    走内置演示库）→ run_operator 指标目录自动纳入
 * 5. 补录 Adjust 口径指标定义（cause.metrics，ON CONFLICT 幂等）
 *
 * 依赖 .env：ADJUST_API_TOKEN（必填）、DATABASE_URL、
 *           ADJUST_RS_API_BASE_URL（可选，默认 automate.adjust.com/reports-service）
 * 运行：npx tsx scripts/sync-adjust-data.ts [--days N]（默认回补近 3 天，Adjust 数据 T+1）
 * 幂等：重复执行为 upsert / 先删后插，可安全重跑。
 */
import { Pool } from "pg";
import { parseCsvTable, csvTableToObjects } from "../lib/server/connectors/csv";

process.loadEnvFile?.();

const TOKEN = process.env.ADJUST_API_TOKEN ?? "";
const BASE_URL = process.env.ADJUST_RS_API_BASE_URL ?? "https://automate.adjust.com/reports-service";
if (!TOKEN) {
  console.error("缺少 ADJUST_API_TOKEN，请在 .env 中配置（Adjust 控制面板 → 账户设置 → 个人档案）");
  process.exit(1);
}
const rawUrl = process.env.DATABASE_URL ?? "";
if (!rawUrl) {
  console.error("缺少 DATABASE_URL，请在 .env 中配置");
  process.exit(1);
}
// pg 不认识 ?schema= 参数，去掉
const connUrl = rawUrl.split("?")[0] ?? rawUrl;

// --days N 解析（默认 3：昨日 + 回补 2 天，覆盖 Adjust T+1 数据修正窗口）
const daysArgIdx = process.argv.indexOf("--days");
const DAYS = daysArgIdx >= 0 ? Math.max(1, Number(process.argv[daysArgIdx + 1]) || 3) : 3;

/** Adjust CSV 列 → 本地表列（维度 + 指标 slug 对齐） */
const METRIC_COLUMNS = [
  "impressions", "clicks", "installs", "sessions",
  "register_events", "firstdeposit_events", "recalldeposit_events", "network_cost",
] as const;

/** 拉取 CSV 报告（脚本直连 fetch，不经连接器 200KB 截断限制） */
async function fetchCsvReport(datePeriod: string): Promise<string | null> {
  const url = new URL(`${BASE_URL}/csv_report`);
  url.searchParams.set("dimensions", "day,network,country_code");
  url.searchParams.set("metrics", METRIC_COLUMNS.join(","));
  url.searchParams.set("date_period", datePeriod);
  url.searchParams.set("sort", "-installs");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (res.status === 204) return null; // 区间无数据
  if (!res.ok) {
    throw new Error(`Adjust API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.text();
}

async function main() {
  const pool = new Pool({ connectionString: connUrl, max: 4 });
  const client = await pool.connect();
  try {
    // ─── 1. 拉取 ──────────────────────────────────────────────────────────
    const datePeriod = `-${DAYS}d:-1d`;
    console.log(`→ 拉取 Adjust CSV 报告（date_period=${datePeriod}，day×network×country_code）...`);
    const csvText = await fetchCsvReport(datePeriod);
    if (csvText === null) {
      console.log("✅ API 返回 204（区间无数据），本次无同步");
      return;
    }
    const table = parseCsvTable(csvText);
    const records = csvTableToObjects(table).filter((r) => r["day"] && r["network"] && r["country_code"]);
    console.log(`   解析 ${records.length} 行（表头：${table.header.join(", ")}）`);
    if (records.length === 0) {
      console.log("✅ 无有效数据行，本次无同步");
      return;
    }

    // ─── 2. 建表（幂等）──────────────────────────────────────────────────
    console.log("→ 确保 data.adjust_daily_metrics 表存在 ...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS data.adjust_daily_metrics (
        stat_date            DATE NOT NULL,
        network              TEXT NOT NULL,
        country_code         TEXT NOT NULL,
        impressions          BIGINT NOT NULL DEFAULT 0,
        clicks               BIGINT NOT NULL DEFAULT 0,
        installs             BIGINT NOT NULL DEFAULT 0,
        sessions             BIGINT NOT NULL DEFAULT 0,
        register_cnt         BIGINT NOT NULL DEFAULT 0,
        first_deposit_cnt    BIGINT NOT NULL DEFAULT 0,
        recall_deposit_cnt   BIGINT NOT NULL DEFAULT 0,
        network_cost         NUMERIC(14,4) NOT NULL DEFAULT 0,
        synced_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (stat_date, network, country_code)
      );
      CREATE INDEX IF NOT EXISTS idx_adm_date ON data.adjust_daily_metrics(stat_date);
      CREATE INDEX IF NOT EXISTS idx_adm_network ON data.adjust_daily_metrics(network);
    `);

    // ─── 3. 批量 upsert ──────────────────────────────────────────────────
    console.log("→ 幂等 upsert（ON CONFLICT (stat_date, network, country_code) DO UPDATE）...");
    const BATCH = 400;
    let upserted = 0;
    for (let i = 0; i < records.length; i += BATCH) {
      const chunk = records.slice(i, i + BATCH);
      const values: unknown[] = [];
      const placeholders = chunk
        .map((_, ri) => `(${Array.from({ length: 11 }, (_, ci) => `$${ri * 11 + ci + 1}`).join(",")}, now())`)
        .join(",");
      for (const r of chunk) {
        values.push(
          String(r["day"]), String(r["network"]), String(r["country_code"]),
          Number(r["impressions"] ?? 0), Number(r["clicks"] ?? 0),
          Number(r["installs"] ?? 0), Number(r["sessions"] ?? 0),
          Number(r["register_events"] ?? 0), Number(r["firstdeposit_events"] ?? 0),
          Number(r["recalldeposit_events"] ?? 0), Number(r["network_cost"] ?? 0),
        );
      }
      const result = await client.query(
        `INSERT INTO data.adjust_daily_metrics
           (stat_date, network, country_code, impressions, clicks, installs, sessions,
            register_cnt, first_deposit_cnt, recall_deposit_cnt, network_cost, synced_at)
         VALUES ${placeholders}
         ON CONFLICT (stat_date, network, country_code) DO UPDATE SET
           impressions = EXCLUDED.impressions,
           clicks = EXCLUDED.clicks,
           installs = EXCLUDED.installs,
           sessions = EXCLUDED.sessions,
           register_cnt = EXCLUDED.register_cnt,
           first_deposit_cnt = EXCLUDED.first_deposit_cnt,
           recall_deposit_cnt = EXCLUDED.recall_deposit_cnt,
           network_cost = EXCLUDED.network_cost,
           synced_at = now()`,
        values,
      );
      upserted += result.rowCount ?? 0;
    }
    console.log(`   upsert ${upserted} 行`);

    // ─── 4. 语义模型挂载（先删后插，幂等）─────────────────────────────────
    console.log("→ 挂载语义模型「Adjust 投放日指标」（cause.semantic_models）...");
    const modelId = "semantic_model_adjust_daily";
    const fields = {
      description:
        "Adjust 归因平台真实投放数据：渠道(network)×国家(country_code)×日 粒度的安装/会话/注册/首存(FD)/复存(RD)漏斗，" +
        "由 scripts/sync-adjust-data.ts 每日从 Adjust 报告服务 API 同步（T+1）",
      timeColumn: "stat_date",
      metrics: [
        // apiSlug：上游 Adjust API 的指标 slug（API 源直查时算子自动映射，与本地字段名不同时用）；同名指标缺省
        { id: "installs", name: "安装量", column: "installs", agg: "sum", unit: "次", description: "Adjust 归因安装数（install 事件）" },
        { id: "clicks", name: "点击量", column: "clicks", agg: "sum", unit: "次", description: "广告点击数" },
        { id: "impressions", name: "展示量", column: "impressions", agg: "sum", unit: "次", description: "广告展示数（部分渠道不回传，可能为 0）" },
        { id: "sessions", name: "会话数", column: "sessions", agg: "sum", unit: "次", description: "应用会话数（含老用户活跃）" },
        { id: "register_cnt", name: "注册数", column: "register_cnt", agg: "sum", unit: "人", apiSlug: "register_events", description: "Register 自定义事件数" },
        { id: "first_deposit_cnt", name: "首存数（FD）", column: "first_deposit_cnt", agg: "sum", unit: "人", apiSlug: "firstdeposit_events", description: "FirstDeposit 自定义事件数" },
        { id: "recall_deposit_cnt", name: "复存数（RD）", column: "recall_deposit_cnt", agg: "sum", unit: "人", apiSlug: "recalldeposit_events", description: "RecallDeposit 自定义事件数" },
        { id: "network_cost", name: "渠道花费", column: "network_cost", agg: "sum", unit: "美元", description: "渠道回传成本（未配置支出数据时为 0）" },
      ],
      dimensions: [
        { id: "network", name: "投放渠道", column: "network", description: "Adjust network 名称（如 web/gadmobe-apk/Organic）" },
        { id: "country_code", name: "国家码", column: "country_code", description: "ISO 3166-1 alpha-2 小写国家码" },
        { id: "stat_date", name: "日期", column: "stat_date", apiSlug: "day", description: "统计日期（UTC）" },
      ],
    };
    await client.query("DELETE FROM cause.semantic_models WHERE id = $1", [modelId]);
    // 关联已注册的 Adjust API 数据源（血缘可追溯）；未注册时为 NULL 走内置演示库
    const adjustSource = await client.query<{ id: string }>(
      "SELECT id FROM cause.data_sources WHERE name = 'Adjust 报告服务' AND type = 'api' LIMIT 1",
    );
    await client.query(
      `INSERT INTO cause.semantic_models(id, name, data_source_id, table_ref, fields, created_at, updated_at)
       VALUES ($1, 'Adjust 投放日指标', $3, 'data.adjust_daily_metrics', $2::jsonb, now(), now())`,
      [modelId, JSON.stringify(fields), adjustSource.rows[0]?.id ?? null],
    );

    // ─── 5. 指标口径补录（幂等）──────────────────────────────────────────
    console.log("→ 补录 Adjust 口径指标定义（cause.metrics）...");
    await client.query(
      "INSERT INTO cause.users(id, email, name, role) VALUES ('user_dev_default', 'dev@example.com', '开发用户', 'admin') ON CONFLICT (id) DO NOTHING",
    );
    const metrics: Array<[string, string, string, string, string]> = [
      ["metric_adjust_installs", "Adjust 安装量", "Adjust 归因口径的应用安装数", "SUM(installs)", "次"],
      ["metric_adjust_register", "Adjust 注册数", "Register 自定义事件数", "SUM(register_cnt)", "人"],
      ["metric_adjust_fd", "Adjust 首存数（FD）", "FirstDeposit 自定义事件数", "SUM(first_deposit_cnt)", "人"],
      ["metric_adjust_rd", "Adjust 复存数（RD）", "RecallDeposit 自定义事件数", "SUM(recall_deposit_cnt)", "人"],
      ["metric_adjust_fd_rate", "Adjust FD转化率", "首存数 / 注册数", "first_deposit_cnt / register_cnt", "%"],
    ];
    for (const [id, name, desc, formula, unit] of metrics) {
      await client.query(
        `INSERT INTO cause.metrics(id, name, description, formula, unit, owner_id, status, version, updated_at)
         VALUES ($1,$2,$3,$4,$5,'user_dev_default','published',1, now())
         ON CONFLICT (id) DO UPDATE SET name=$2, description=$3, formula=$4, unit=$5, updated_at=now()`,
        [id, name, desc, formula, unit],
      );
    }

    // ─── 6. 验证 ─────────────────────────────────────────────────────────
    console.log("→ 验证同步结果 ...");
    const totals = await client.query<{ days: string; rows: string; installs: string; fd: string }>(`
      SELECT COUNT(DISTINCT stat_date) AS days, COUNT(*) AS rows,
             SUM(installs) AS installs, SUM(first_deposit_cnt) AS fd
      FROM data.adjust_daily_metrics
    `);
    const t = totals.rows[0]!;
    const byNetwork = await client.query<{ network: string; installs: string; register_cnt: string; fd: string }>(`
      SELECT network, SUM(installs) AS installs, SUM(register_cnt) AS register_cnt, SUM(first_deposit_cnt) AS fd
      FROM data.adjust_daily_metrics
      WHERE stat_date = (SELECT MAX(stat_date) FROM data.adjust_daily_metrics)
      GROUP BY network ORDER BY SUM(installs) DESC LIMIT 8
    `);
    console.log(`   最新日期渠道分布：`);
    console.table(byNetwork.rows);
    console.log(
      `✅ 同步完成：库内 ${t.days} 天 / ${t.rows} 行 / 总安装 ${Number(t.installs).toLocaleString()} / 总FD ${Number(t.fd).toLocaleString()}（本次 upsert ${upserted} 行）`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Adjust 数据同步失败:", err instanceof Error ? err.message : err);
  process.exit(1);
});
