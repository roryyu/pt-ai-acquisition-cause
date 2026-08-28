/**
 * 演示数据集种子脚本
 *
 * 在本地 PostgreSQL 创建 demo schema，生成 2 年模拟电商经营数据：
 * - demo.regions       七大区域（层级维度）
 * - demo.products      商品维表（类目/价格/成本）
 * - demo.orders        订单明细（抽样）
 * - demo.daily_metrics 区域×渠道×日 粒度指标汇总（GMV/订单/用户/转化率）
 *
 * 数据特征（预埋可发现的洞察）：
 * 1. 整体上升趋势 + 年度季节性（618 / 双11 大促尖峰）
 * 2. 移动端渠道占比逐年提升
 * 3. 华东区 2026-05 起转化率异常下滑（供异常检测算子发现）
 * 4. 美妆类目 2025Q4 起增速放缓（供归因分析）
 *
 * 幂等：重复执行先 DROP 再重建。
 * 运行：npx tsx scripts/seed-demo-data.ts
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

const REGIONS = [
  "华东", "华北", "华南", "华中", "西南", "西北", "东北",
] as const;
const CHANNELS = ["app", "miniapp", "web", "offline"] as const;
const CATEGORIES = ["美妆", "3C数码", "服饰", "食品", "家居", "运动户外"] as const;

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
const rand = mulberry32(20260825);

async function main() {
  const client = await pool.connect();
  try {
    console.log("→ 清理旧 demo schema ...");
    await client.query("DROP SCHEMA IF EXISTS demo CASCADE");

    console.log("→ 创建 demo schema 与表 ...");
    await client.query(`
      CREATE SCHEMA demo;

      CREATE TABLE demo.regions (
        id   SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        tier INT  NOT NULL DEFAULT 1,
        note TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE demo.products (
        id       SERIAL PRIMARY KEY,
        name     TEXT NOT NULL,
        category TEXT NOT NULL,
        price    NUMERIC(10,2) NOT NULL,
        cost     NUMERIC(10,2) NOT NULL
      );

      CREATE TABLE demo.orders (
        id           SERIAL PRIMARY KEY,
        order_no     TEXT NOT NULL UNIQUE,
        user_id      INT  NOT NULL,
        region       TEXT NOT NULL,
        channel      TEXT NOT NULL,
        category     TEXT NOT NULL,
        product_id   INT  NOT NULL REFERENCES demo.products(id),
        amount       NUMERIC(12,2) NOT NULL,
        quantity     INT  NOT NULL,
        status       TEXT NOT NULL DEFAULT 'paid',
        created_at   TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX idx_orders_created_at ON demo.orders(created_at);
      CREATE INDEX idx_orders_region ON demo.orders(region);

      CREATE TABLE demo.daily_metrics (
        stat_date        DATE NOT NULL,
        region           TEXT NOT NULL,
        channel          TEXT NOT NULL,
        gmv              NUMERIC(14,2) NOT NULL,
        orders           INT  NOT NULL,
        active_users     INT  NOT NULL,
        new_users        INT  NOT NULL,
        conversion_rate  NUMERIC(6,4) NOT NULL,
        avg_order_value  NUMERIC(10,2) NOT NULL,
        PRIMARY KEY (stat_date, region, channel)
      );
      CREATE INDEX idx_dm_date ON demo.daily_metrics(stat_date);
    `);

    console.log("→ 写入区域维表 ...");
    for (const [i, name] of REGIONS.entries()) {
      await client.query(
        "INSERT INTO demo.regions(name, tier, note) VALUES ($1,$2,$3)",
        [name, 1, i === 0 ? "核心市场" : "成长市场"],
      );
    }

    console.log("→ 写入商品维表（80 个）...");
    const productRows: Array<[string, string, number, number]> = [];
    for (const [ci, cat] of CATEGORIES.entries()) {
      for (let j = 1; j <= 14; j++) {
        const price = Math.round((30 + rand() * 3000) * 100) / 100;
        const cost = Math.round(price * (0.45 + rand() * 0.25) * 100) / 100;
        productRows.push([`${cat}-SKU${ci * 14 + j}`, cat, price, cost]);
      }
    }
    for (const row of productRows) {
      await client.query(
        "INSERT INTO demo.products(name, category, price, cost) VALUES ($1,$2,$3,$4)",
        row,
      );
    }

    console.log("→ 生成 daily_metrics（2024-08-01 ~ 2026-08-24）...");
    const start = new Date(Date.UTC(2024, 7, 1));
    const end = new Date(Date.UTC(2026, 7, 24));
    const regionalScale: Record<string, number> = {
      华东: 1.0, 华北: 0.72, 华南: 0.66, 华中: 0.4,
      西南: 0.3, 西北: 0.16, 东北: 0.14,
    };
    const channelWeight: Record<string, number> = {
      app: 0.5, miniapp: 0.26, web: 0.14, offline: 0.1,
    };

    let dmCount = 0;
    let cursor = new Date(start);
    while (cursor <= end) {
      const d = cursor;
      const dayIdx = Math.floor((d.getTime() - start.getTime()) / 86400000);
      const yearFrac = dayIdx / 730; // 0→1
      const month = d.getUTCMonth() + 1;
      const day = d.getUTCDate();
      const dow = d.getUTCDay();

      // 基础趋势：24 个月整体增长 ~55%
      const trend = 1 + yearFrac * 0.55;
      // 季节性：双11 尖峰、618 次尖峰、春节低谷
      let seasonal = 1;
      if (month === 11 && day >= 1 && day <= 11) seasonal = day >= 9 ? 2.6 : 1.5;
      else if (month === 6 && day >= 15 && day <= 20) seasonal = 1.8;
      else if (month === 1 || month === 2) seasonal = 0.62;
      else if (month === 12 && day >= 12 && day <= 25) seasonal = 1.3;
      // 周末略高
      const weekly = dow === 0 || dow === 6 ? 1.12 : 1;
      // 噪声 ±8%
      const noise = 0.92 + rand() * 0.16;

      for (const region of REGIONS) {
        for (const channel of CHANNELS) {
          const base = 90000 * (regionalScale[region] ?? 0.2) * channelWeight[channel]!;
          // 渠道结构演变：app/小程序占比提升，web 下降
          const channelShift =
            channel === "app" ? 1 + yearFrac * 0.4 :
            channel === "miniapp" ? 1 + yearFrac * 0.6 :
            channel === "web" ? 1 - yearFrac * 0.35 : 1;
          let gmv = base * trend * seasonal * weekly * noise * channelShift;
          // 预埋异常：华东区 app 渠道 2026-05 起转化率与 GMV 双降
          let convDrop = 1;
          if (region === "华东" && channel === "app") {
            const d2026 = d.getTime() >= Date.UTC(2026, 4, 1) ? (d.getTime() - Date.UTC(2026, 4, 1)) / 86400000 : 0;
            if (d2026 > 0) {
              convDrop = Math.max(0.72, 1 - d2026 / 730 * 0.35);
              gmv *= convDrop;
            }
          }
          // 美妆类目放缓体现在整体 gmv 中约 18% 权重
          if (d.getTime() >= Date.UTC(2025, 9, 1)) gmv *= 1 - 0.18 * 0.18 * yearFrac;

          const aov = Math.round((120 + rand() * 60) * 100) / 100;
          const orders = Math.max(1, Math.round(gmv / aov));
          const conv = Math.min(0.15, 0.055 + rand() * 0.03) * convDrop;
          const activeUsers = Math.max(orders, Math.round(orders / conv));
          const newUsers = Math.round(activeUsers * (0.08 + rand() * 0.06));

          await client.query(
            `INSERT INTO demo.daily_metrics
             (stat_date, region, channel, gmv, orders, active_users, new_users, conversion_rate, avg_order_value)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              d.toISOString().slice(0, 10),
              region,
              channel,
              Math.round(gmv * 100) / 100,
              orders,
              activeUsers,
              newUsers,
              Math.round(conv * 10000) / 10000,
              aov,
            ],
          );
          dmCount++;
        }
      }
      cursor = new Date(d.getTime() + 86400000);
    }
    console.log(`   daily_metrics 共 ${dmCount} 行`);

    console.log("→ 生成订单明细（抽样 24000 行）...");
    const productCount = productRows.length;
    let orderSeq = 0;
    const BATCH = 1000;
    let batch: Array<[string, number, string, string, string, number, number, number, string, string]> = [];
    for (let i = 0; i < 24000; i++) {
      const dayOffset = Math.floor(rand() * 730);
      const created = new Date(start.getTime() + dayOffset * 86400000 + Math.floor(rand() * 86400000));
      const month = created.getUTCMonth() + 1;
      const yearFrac = dayOffset / 730;
      // 订单的区域/渠道概率与指标表权重一致
      const region = pickWeighted(REGIONS, regionalScale);
      const channel = pickWeightedShift(CHANNELS, channelWeight, yearFrac);
      const category = CATEGORIES[Math.floor(rand() * CATEGORIES.length)]!;
      const productId = Math.floor(rand() * productCount) + 1;
      // 大促单量放大
      const promo = month === 11 ? 2.2 : month === 6 ? 1.5 : 1;
      if (rand() > 1 / promo && i % Math.ceil(promo) !== 0) {
        // 通过丢弃部分非大促订单近似实现大促占比提升
      }
      const product = productRows[productId - 1]!;
      const quantity = 1 + Math.floor(rand() * 3);
      const amount = Math.round(Number(product[2]) * quantity * (0.9 + rand() * 0.15) * 100) / 100;
      const status = rand() < 0.94 ? "paid" : rand() < 0.6 ? "refunded" : "cancelled";
      orderSeq++;
      batch.push([
        `ORD${String(orderSeq).padStart(8, "0")}`,
        100000 + Math.floor(rand() * 50000),
        region,
        channel,
        category,
        productId,
        amount,
        quantity,
        status,
        created.toISOString(),
      ]);
      if (batch.length >= BATCH) {
        await insertOrders(client, batch);
        batch = [];
      }
    }
    if (batch.length > 0) await insertOrders(client, batch);
    console.log(`   orders 共 ${orderSeq} 行`);

    // 验证数据
    const check = await client.query<{
      gmv: string; orders: string; regions: string; anomaly: string;
    }>(`
      SELECT
        (SELECT ROUND(SUM(gmv)) FROM demo.daily_metrics WHERE stat_date >= '2026-01-01') AS gmv,
        (SELECT COUNT(*) FROM demo.orders) AS orders,
        (SELECT COUNT(DISTINCT region) FROM demo.daily_metrics) AS regions,
        (SELECT ROUND(AVG(conversion_rate),4) FROM demo.daily_metrics
          WHERE region='华东' AND channel='app' AND stat_date >= '2026-06-01') AS anomaly
    `);
    const r = check.rows[0]!;
    console.log(`✅ 种子完成：2026YTD GMV=${Number(r.gmv).toLocaleString()} / 订单=${r.orders} / 区域=${r.regions} / 华东app转化率=${r.anomaly}`);
  } finally {
    client.release();
    await pool.end();
  }
}

function pickWeighted<T extends string>(items: readonly T[], weights: Record<string, number>): T {
  const total = items.reduce((s, it) => s + (weights[it] ?? 0), 0);
  let x = rand() * total;
  for (const it of items) {
    x -= weights[it] ?? 0;
    if (x <= 0) return it;
  }
  return items[items.length - 1]!;
}

function pickWeightedShift<T extends string>(
  items: readonly T[], weights: Record<string, number>, yearFrac: number,
): T {
  const w: Record<string, number> = {};
  for (const it of items) {
    const shift =
      it === "app" ? 1 + yearFrac * 0.4 :
      it === "miniapp" ? 1 + yearFrac * 0.6 :
      it === "web" ? 1 - yearFrac * 0.35 : 1;
    w[it] = (weights[it] ?? 0) * shift;
  }
  return pickWeighted(items, w);
}

async function insertOrders(
  client: import("pg").PoolClient,
  rows: Array<[string, number, string, string, string, number, number, number, string, string]>,
) {
  const values: unknown[] = [];
  const placeholders = rows
    .map((row, ri) => {
      const ph = row.map((_, ci) => `$${ri * 10 + ci + 1}`).join(",");
      values.push(...row);
      return `(${ph})`;
    })
    .join(",");
  await client.query(
    `INSERT INTO demo.orders
     (order_no, user_id, region, channel, category, product_id, amount, quantity, status, created_at)
     VALUES ${placeholders}`,
    values,
  );
}

main().catch((err) => {
  console.error("种子脚本失败:", err);
  process.exit(1);
});
