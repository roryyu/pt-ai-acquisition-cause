/**
 * 投放渠道效果分析案例 —— 种子数据脚本
 *
 * 为「任务问答 /ask」初始化一个可完整运行的案例：流量投放渠道效果分析。
 * 覆盖 Meta / X / TikTok 三大投放渠道，经 app（应用下载）与 web（网页落地页）
 * 两个承接端，沉淀下载、注册、FD（首次充钱）、RD（再次召回充钱）全漏斗数据。
 *
 * 新增表（挂载在内置演示库 demo schema，sql_query 工具可直接查询）：
 * - demo.channel_daily_metrics  渠道×承接端×市场×日 粒度投放漏斗指标
 * - demo.channel_campaigns     投放计划维表 + 累计汇总（18 个计划）
 * 同时写入 cause 业务库：
 * - cause.metrics     指标口径定义（FD / RD / CPI / ROI 等，published 状态）
 * - cause.workspaces  案例工作区「流量投放渠道效果分析」
 *
 * 预埋洞察（供数据分析 / 异常归因 / 深度研究链路发现）：
 * 1. TikTok 量大质低：CPI 最低（下载最多）但 FD 率、RD 率垫底，ROI 差
 * 2. Meta 质高价贵：CPM/CPI 最高，但 FD 率与 RD 率最优，ROI 最佳
 * 3. X 渠道 2026-03 起持续恶化（CTR 降 / CPM 涨 / FD 率降），2026-06 起恶化加速
 *    ——供异常检测与归因下钻定位（按渠道→月份→市场逐层下钻）
 * 4. TikTok 2026-06 起竞价成本（CPM）跳涨约 40%，CPI 明显抬升（外部事件映射）
 * 5. web 承接端 RD（召回再充）占比显著高于 app；app 贡献几乎全部下载与 FD
 * 6. 市场结构：东南亚流量便宜但付费弱，北美付费能力最强（FD/RD 客单最高）
 * 7. 整体投放规模 12 个月增长约 45%，含周末上行与年末旺季季节性
 *
 * 幂等：重复执行先 DROP 目标表与案例指标/工作区再重建。
 * 注意：若重跑 scripts/seed-demo-data.ts（会 DROP 整个 demo schema），需再执行本脚本。
 * 运行：npx tsx scripts/seed-acquisition-data.ts
 */
import { Pool } from "pg";

process.loadEnvFile?.();

const rawUrl = process.env.DATABASE_URL ?? "";
if (!rawUrl) {
  console.error("缺少 DATABASE_URL，请在 .env 中配置");
  process.exit(1);
}
// pg 不认识 ?schema= 参数，去掉
const connUrl = rawUrl.split("?")[0] ?? rawUrl;

const pool = new Pool({ connectionString: connUrl, max: 4 });

// ─── 案例维度定义 ─────────────────────────────────────────────────────────────

const AD_CHANNELS = ["Meta", "X", "TikTok"] as const;
type AdChannel = (typeof AD_CHANNELS)[number];
const PLATFORMS = ["app", "web"] as const;
type Platform = (typeof PLATFORMS)[number];
const REGIONS = ["北美", "欧洲", "东南亚", "拉美", "日韩"] as const;
type Region = (typeof REGIONS)[number];

/** 市场（区域）修正系数：成本 / 付费能力 / 充值意愿 */
const REGION_MOD: Record<Region, { cost: number; monet: number; pay: number }> = {
  北美: { cost: 1.35, monet: 1.45, pay: 1.0 },
  欧洲: { cost: 1.15, monet: 1.1, pay: 0.95 },
  东南亚: { cost: 0.55, monet: 0.55, pay: 0.8 },
  拉美: { cost: 0.65, monet: 0.7, pay: 0.85 },
  日韩: { cost: 1.3, monet: 1.25, pay: 1.05 },
};

/** 渠道基础参数（日均量级 / 单价 / 漏斗转化 / 客单，美元口径） */
const CHANNEL_PROFILE: Record<
  AdChannel,
  {
    baseImpr: number; // 日均展示基数（×区域权重）
    cpm: number; // 千次展示成本
    ctr: number; // 点击率
    dlRate: number; // 点击→下载（app）
    regApp: number; // app：下载→注册
    regWeb: number; // web：点击→注册
    fdRate: number; // 注册→FD（首次充钱）
    rdShare: number; // RD 用户 / FD 用户（召回再充比例）
    fdAvg: number; // FD 客单
    rdAvg: number; // RD 客单
    weight: number; // 预算分配权重
  }
> = {
  Meta: {
    baseImpr: 2_100_000, cpm: 9.6, ctr: 0.021, dlRate: 0.115, regApp: 0.60,
    regWeb: 0.062, fdRate: 0.075, rdShare: 0.44, fdAvg: 95, rdAvg: 78, weight: 0.40,
  },
  TikTok: {
    baseImpr: 3_300_000, cpm: 3.4, ctr: 0.028, dlRate: 0.175, regApp: 0.52,
    regWeb: 0.040, fdRate: 0.030, rdShare: 0.20, fdAvg: 55, rdAvg: 44, weight: 0.38,
  },
  X: {
    baseImpr: 1_150_000, cpm: 7.0, ctr: 0.013, dlRate: 0.092, regApp: 0.55,
    regWeb: 0.046, fdRate: 0.042, rdShare: 0.30, fdAvg: 75, rdAvg: 60, weight: 0.22,
  },
};

/** 承接端（app / web）预算占比 */
const PLATFORM_SHARE: Record<Platform, number> = { app: 0.68, web: 0.32 };
/** 区域展示量权重 */
const REGION_SHARE: Record<Region, number> = {
  北美: 0.30, 欧洲: 0.24, 东南亚: 0.20, 拉美: 0.14, 日韩: 0.12,
};

/** 确定性伪随机（mulberry32），保证每次生成数据一致 */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260826);

// ─── 预埋事件修正（洞察来源） ─────────────────────────────────────────────────

interface DayMods {
  cpm: number;
  ctr: number;
  fdRate: number;
  demand: number; // 投放需求/量级放大
}

function dayMods(channel: AdChannel, t: number): DayMods {
  const mods: DayMods = { cpm: 1, ctr: 1, fdRate: 1, demand: 1 };
  // 年末旺季（12-12 ~ 12-31）：电商抢量推高竞价，Meta/TikTok 需求上行
  if (channel !== "X" && t >= Date.UTC(2025, 11, 12) && t <= Date.UTC(2025, 11, 31)) {
    mods.cpm *= 1.22;
    mods.demand *= 1.15;
  }
  // 春节档（2026-02）：整体缩量
  if (t >= Date.UTC(2026, 1, 1) && t <= Date.UTC(2026, 1, 28)) {
    mods.demand *= 0.85;
  }
  // TikTok 2026-06 起竞价成本跳涨（平台政策/流量结构变化，映射外部事件）
  if (channel === "TikTok" && t >= Date.UTC(2026, 5, 1)) {
    mods.cpm *= 1.4;
  }
  // X 渠道持续恶化：2026-03 起 CTR 降 + CPM 涨 + FD 质量降，2026-06 起加速
  if (channel === "X") {
    if (t >= Date.UTC(2026, 2, 1)) {
      const days = (t - Date.UTC(2026, 2, 1)) / 86400000;
      const ramp = Math.min(1, days / 90);
      mods.ctr *= 1 - 0.22 * ramp;
      mods.cpm *= 1 + 0.18 * ramp;
      mods.fdRate *= 1 - 0.15 * ramp;
    }
    if (t >= Date.UTC(2026, 5, 1)) {
      const days = (t - Date.UTC(2026, 5, 1)) / 86400000;
      const ramp = Math.min(1, days / 45);
      mods.ctr *= 1 - 0.10 * ramp;
      mods.fdRate *= 1 - 0.10 * ramp;
    }
  }
  return mods;
}

// ─── 数据生成 ─────────────────────────────────────────────────────────────────

type DailyRow = [
  string, AdChannel, Platform, Region,
  number, number, number, number, number,
  number, number, number, number,
];

function generateDaily(startMs: number, days: number): DailyRow[] {
  const rows: DailyRow[] = [];
  for (let i = 0; i < days; i++) {
    const t = startMs + i * 86400000;
    const d = new Date(t);
    const dateStr = d.toISOString().slice(0, 10);
    const yearFrac = i / days;
    const dow = d.getUTCDay();
    // 整体投放规模增长约 45% + 周末上行 + 噪声
    const trend = 1 + 0.45 * yearFrac;
    const weekly = dow === 0 || dow === 6 ? 1.1 : 1;

    for (const channel of AD_CHANNELS) {
      const p = CHANNEL_PROFILE[channel];
      const ev = dayMods(channel, t);
      for (const platform of PLATFORMS) {
        for (const region of REGIONS) {
          const rm = REGION_MOD[region];
          const noise = () => 0.92 + rand() * 0.16;

          const impressions = Math.max(
            1000,
            Math.round(p.baseImpr * p.weight * PLATFORM_SHARE[platform] * REGION_SHARE[region] * trend * weekly * ev.demand * noise()),
          );
          const cpm = p.cpm * rm.cost * ev.cpm * noise();
          const spend = Math.round(impressions * cpm / 1000 * 100) / 100;
          const ctr = Math.max(0.002, p.ctr * ev.ctr * (0.95 + rand() * 0.1));
          const clicks = Math.round(impressions * ctr);

          let downloads = 0;
          let registrations: number;
          if (platform === "app") {
            downloads = Math.round(clicks * p.dlRate * noise());
            registrations = Math.round(downloads * p.regApp * noise());
          } else {
            registrations = Math.round(clicks * p.regWeb * noise());
          }

          // FD：首次充钱（web 端召回页付费意愿略低）
          const fdAdj = platform === "web" ? 0.9 : 1;
          const fdUsers = Math.round(registrations * p.fdRate * ev.fdRate * rm.pay * fdAdj * noise());
          const fdAmount = Math.round(fdUsers * p.fdAvg * rm.monet * (0.9 + rand() * 0.2) * 100) / 100;
          // RD：再次召回充钱（web 承接端召回更优 → RD 占比更高）
          const rdShareAdj = platform === "web" ? 1.25 : 1;
          const rdUsers = Math.round(fdUsers * p.rdShare * rdShareAdj * noise());
          const rdAmount = Math.round(rdUsers * p.rdAvg * rm.monet * (0.9 + rand() * 0.2) * 100) / 100;

          rows.push([
            dateStr, channel, platform, region,
            spend, impressions, clicks, downloads, registrations,
            fdUsers, fdAmount, rdUsers, rdAmount,
          ]);
        }
      }
    }
  }
  return rows;
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────

async function main() {
  const client = await pool.connect();
  try {
    console.log("→ 清理旧投放案例数据 ...");
    await client.query(`
      DROP TABLE IF EXISTS demo.channel_campaigns CASCADE;
      DROP TABLE IF EXISTS demo.channel_daily_metrics CASCADE;
      DELETE FROM cause.metrics WHERE id LIKE 'metric_acq_%';
      DELETE FROM cause.workspaces WHERE id = 'workspace_acq_demo';
    `);
    await client.query("CREATE SCHEMA IF NOT EXISTS demo");

    console.log("→ 创建投放案例表 ...");
    await client.query(`
      CREATE TABLE demo.channel_daily_metrics (
        stat_date      DATE NOT NULL,
        ad_channel     TEXT NOT NULL,
        platform       TEXT NOT NULL,
        region         TEXT NOT NULL,
        spend          NUMERIC(12,2) NOT NULL,
        impressions    BIGINT NOT NULL,
        clicks         BIGINT NOT NULL,
        downloads      INT NOT NULL,
        registrations  INT NOT NULL,
        fd_users       INT NOT NULL,
        fd_amount      NUMERIC(14,2) NOT NULL,
        rd_users       INT NOT NULL,
        rd_amount      NUMERIC(14,2) NOT NULL,
        PRIMARY KEY (stat_date, ad_channel, platform, region)
      );
      CREATE INDEX idx_cdm_date ON demo.channel_daily_metrics(stat_date);
      CREATE INDEX idx_cdm_channel ON demo.channel_daily_metrics(ad_channel);

      CREATE TABLE demo.channel_campaigns (
        id            SERIAL PRIMARY KEY,
        campaign_no   TEXT NOT NULL UNIQUE,
        ad_channel    TEXT NOT NULL,
        platform      TEXT NOT NULL,
        objective     TEXT NOT NULL,
        campaign_name TEXT NOT NULL,
        status        TEXT NOT NULL,
        start_date    DATE NOT NULL,
        daily_budget  NUMERIC(10,2) NOT NULL,
        total_spend   NUMERIC(14,2) NOT NULL,
        downloads     INT NOT NULL,
        registrations INT NOT NULL,
        fd_users      INT NOT NULL,
        rd_users      INT NOT NULL
      );
    `);

    console.log("→ 生成 channel_daily_metrics（2025-08-25 ~ 2026-08-25）...");
    const startMs = Date.UTC(2025, 7, 25);
    const days = Math.round((Date.UTC(2026, 7, 25) - startMs) / 86400000) + 1;
    const rows = generateDaily(startMs, days);
    console.log(`   共 ${rows.length} 行，批量写入 ...`);
    const COLS = 13;
    const BATCH = 400;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const values: unknown[] = [];
      const placeholders = chunk
        .map((row, ri) => `(${row.map((_, ci) => `$${ri * COLS + ci + 1}`).join(",")})`)
        .join(",");
      for (const row of chunk) values.push(...row);
      await client.query(
        `INSERT INTO demo.channel_daily_metrics
         (stat_date, ad_channel, platform, region, spend, impressions, clicks,
          downloads, registrations, fd_users, fd_amount, rd_users, rd_amount)
         VALUES ${placeholders}`,
        values,
      );
    }

    console.log("→ 生成投放计划维表 channel_campaigns（3 渠道 × 2 承接端 × 3 目标 = 18 个）...");
    await client.query(`
      INSERT INTO demo.channel_campaigns
        (campaign_no, ad_channel, platform, objective, campaign_name, status,
         start_date, daily_budget, total_spend, downloads, registrations, fd_users, rd_users)
      SELECT
        'CMP-' || g.ad_channel || '-' || g.platform || '-' || o.objective_code,
        g.ad_channel, g.platform, o.objective,
        g.ad_channel || '_' || g.platform || '_' || o.objective_code || '_全球通投',
        o.status, o.start_date, o.daily_budget,
        ROUND(g.total_spend * o.spend_share, 2),
        ROUND(g.downloads * o.spend_share)::int,
        ROUND(g.registrations * o.spend_share)::int,
        ROUND(g.fd_users * o.spend_share)::int,
        ROUND(g.rd_users * o.spend_share)::int
      FROM (
        SELECT ad_channel, platform,
               SUM(spend) AS total_spend, SUM(downloads) AS downloads,
               SUM(registrations) AS registrations, SUM(fd_users) AS fd_users,
               SUM(rd_users) AS rd_users
        FROM demo.channel_daily_metrics
        GROUP BY ad_channel, platform
      ) g
      CROSS JOIN (VALUES
        ('dl',  '拉新下载', 'active',    DATE '2025-09-01', 3000.00, 0.45),
        ('fd',  '首次充值', 'active',    DATE '2025-11-15', 2200.00, 0.35),
        ('rd',  '召回充值', 'paused',    DATE '2026-03-01', 1200.00, 0.20)
      ) AS o(objective_code, objective, status, start_date, daily_budget, spend_share)
    `);

    console.log("→ 写入指标口径定义（cause.metrics）...");
    await client.query("INSERT INTO cause.users(id, email, name, role) VALUES ('user_dev_default', 'dev@example.com', '开发用户', 'admin') ON CONFLICT (id) DO NOTHING");
    const metrics: Array<[string, string, string, string, string]> = [
      ["metric_acq_fd_users", "首次充钱用户数（FD）", "投放带来完成首次充值的去重用户数", "COUNT(DISTINCT user_id) WHERE first_deposit", "人"],
      ["metric_acq_fd_amount", "首次充钱金额（FD金额）", "FD 用户首次充值金额合计", "SUM(first_deposit_amount)", "美元"],
      ["metric_acq_rd_users", "召回充钱用户数（RD）", "经召回触达后再次充值的用户数", "COUNT(DISTINCT user_id) WHERE recall_deposit", "人"],
      ["metric_acq_rd_amount", "召回充钱金额（RD金额）", "RD 用户再次充值金额合计", "SUM(recall_deposit_amount)", "美元"],
      ["metric_acq_downloads", "下载量", "app 端广告带来的应用下载次数", "SUM(downloads)", "次"],
      ["metric_acq_cpi", "单下载成本（CPI）", "投放花费 / 下载量", "spend / downloads", "美元/次"],
      ["metric_acq_roi", "投放ROI", "(FD金额 + RD金额) / 投放花费", "(fd_amount + rd_amount) / spend", "倍"],
      ["metric_acq_fd_rate", "FD转化率", "首次充钱用户数 / 注册用户数", "fd_users / registrations", "%"],
      ["metric_acq_ctr", "点击率（CTR）", "点击量 / 展示量", "clicks / impressions", "%"],
    ];
    for (const [id, name, desc, formula, unit] of metrics) {
      await client.query(
        `INSERT INTO cause.metrics(id, name, description, formula, unit, owner_id, status, version, updated_at)
         VALUES ($1,$2,$3,$4,$5,'user_dev_default','published',1, now())`,
        [id, name, desc, formula, unit],
      );
    }

    console.log("→ 创建案例工作区（cause.workspaces）...");
    await client.query(
      `INSERT INTO cause.workspaces(id, name, owner_id)
       VALUES ('workspace_acq_demo', '流量投放渠道效果分析', 'user_dev_default')`,
    );

    // ─── 验证预埋洞察 ────────────────────────────────────────────────────────
    console.log("→ 验证数据与预埋洞察 ...");
    const byChannel = await client.query<{
      ad_channel: string; spend: string; downloads: string; fd: string; rd: string;
      cpi: string; roi: string; fd_rate: string;
    }>(`
      SELECT ad_channel,
             ROUND(SUM(spend)) AS spend,
             SUM(downloads) AS downloads,
             SUM(fd_users) AS fd,
             SUM(rd_users) AS rd,
             ROUND(SUM(spend) / NULLIF(SUM(downloads), 0), 2) AS cpi,
             ROUND((SUM(fd_amount) + SUM(rd_amount)) / NULLIF(SUM(spend), 0), 3) AS roi,
             ROUND(SUM(fd_users)::numeric / NULLIF(SUM(registrations), 0), 4) AS fd_rate
      FROM demo.channel_daily_metrics
      GROUP BY ad_channel ORDER BY roi DESC
    `);
    console.table(byChannel.rows);

    const byPlatform = await client.query<{
      platform: string; downloads: string; fd: string; rd: string; rd_ratio: string;
    }>(`
      SELECT platform, SUM(downloads) AS downloads, SUM(fd_users) AS fd, SUM(rd_users) AS rd,
             ROUND(SUM(rd_users)::numeric / NULLIF(SUM(fd_users), 0), 3) AS rd_ratio
      FROM demo.channel_daily_metrics GROUP BY platform
    `);
    console.table(byPlatform.rows);

    const xTrend = await client.query<{ month: string; spend: string; ctr: string; fd_rate: string }>(`
      SELECT to_char(stat_date, 'YYYY-MM') AS month,
             ROUND(SUM(spend)) AS spend,
             ROUND(SUM(clicks)::numeric / NULLIF(SUM(impressions), 0), 5) AS ctr,
             ROUND(SUM(fd_users)::numeric / NULLIF(SUM(registrations), 0), 4) AS fd_rate
      FROM demo.channel_daily_metrics
      WHERE ad_channel = 'X' AND stat_date >= '2026-01-01'
      GROUP BY 1 ORDER BY 1
    `);
    console.log("   X 渠道 2026 逐月（验证恶化趋势）:");
    console.table(xTrend.rows);

    const tiktokCpi = await client.query<{ month: string; cpi: string }>(`
      SELECT to_char(stat_date, 'YYYY-MM') AS month,
             ROUND(SUM(spend) / NULLIF(SUM(downloads), 0), 3) AS cpi
      FROM demo.channel_daily_metrics
      WHERE ad_channel = 'TikTok' AND platform = 'app' AND stat_date >= '2026-03-01'
      GROUP BY 1 ORDER BY 1
    `);
    console.log("   TikTok app 逐月 CPI（验证 2026-06 跳涨）:");
    console.table(tiktokCpi.rows);

    const totals = await client.query<{ days: string; rows: string; spend: string; campaigns: string }>(`
      SELECT COUNT(DISTINCT stat_date) AS days, COUNT(*) AS rows,
             ROUND(SUM(spend)) AS spend,
             (SELECT COUNT(*) FROM demo.channel_campaigns) AS campaigns
      FROM demo.channel_daily_metrics
    `);
    const t = totals.rows[0]!;
    console.log(`✅ 种子完成：${t.days} 天 / ${t.rows} 行明细 / 总花费 $${Number(t.spend).toLocaleString()} / ${t.campaigns} 个投放计划`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("投放案例种子脚本失败:", err);
  process.exit(1);
});
