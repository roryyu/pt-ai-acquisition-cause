#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Generate 10,000 rows of mock data for data.adjust_daily_metrics
covering 2026-05-01 ~ 2026-09-08 (131 days), output as a PostgreSQL COPY SQL file.

Design notes (mirroring this account's real data profile):
  * Dimensions: day x network x country_code x os_name x campaign_network (5-dim PK).
  * Networks use the real vocabulary seen in the account: Facebook / Google Ads /
    TikTok / programmatic (Mintegral, Unity Ads, AppLovin, ironSource, Vungle) /
    regional DSPs (Oppo Ads, Vivo Global, Xiaomi Global, Chuanyin Ads,
    PropellerAds, Transsion Holdings) / zero-cost sources (Organic, web,
    Untrusted Devices).
  * network_cost is always 0 (channel-cost API not integrated - production convention).
  * cost / adjust_cost only exist on paid networks; free sources have 0 spend.
  * installs = organic_installs + non_organic_installs; paid rows are 100%
    non-organic (real MMP semantics), free rows are 100% organic.
  * Per-day ~76-77 active dimension combos (weighted sampling without replacement),
    so not every placement is active every day, like real MMP data.

Realism modeling (v2):
  * Campaign lifecycle: each placement has an active window [start, end] -
    always-on flagships / mid-flight launches / early pauses / short burst tests,
    with a 3-day budget ramp-in / ramp-out at genuine lifecycle edges.
  * Daily volume noise is autocorrelated (AR(1)) instead of iid, plus a mild
    30-day seasonal cycle and a linear business growth trend.
  * CTR / CVR / CPC fluctuate per day (lognormal) around each placement's base;
    CTR additionally decays with campaign age (creative fatigue); CPC inflates
    over the range (auction competition).
  * daus / recall_deposit scale with volume & growth instead of flat absolutes.

Usage:  python3 scripts/generate-adjust-mock-data.py
Output: data/adjust_daily_metrics_mock_20260501_20260908.sql
"""

from __future__ import annotations

import math
import random
import string
from datetime import date, timedelta
from pathlib import Path

SEED = 42
START = date(2026, 5, 1)
END = date(2026, 9, 8)
SYNCED_AT = "2026-09-09 06:00:00+08"  # batch backfill, aligned to UTC+8 (project convention)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
OUT_PATH = PROJECT_ROOT / "data" / "adjust_daily_metrics_mock_20260501_20260908.sql"

# ─── Dimension vocabulary ────────────────────────────────────────────────────
TIER1 = ["US", "GB", "DE", "FR", "JP", "KR", "CA", "AU"]
TIER2 = ["ES", "IT", "NL", "SE", "PL", "SG", "TW", "HK", "AE", "SA"]
TIER3 = ["IN", "ID", "VN", "TH", "MY", "PH", "BR", "MX", "TR", "RU", "NG", "KE", "AR", "CO"]
TIER_OF = {c: 1 for c in TIER1}
TIER_OF.update({c: 2 for c in TIER2})
TIER_OF.update({c: 3 for c in TIER3})
TIER_WEIGHT = {1: 1.0, 2: 0.75, 3: 0.6}
TIER_IMP_MU = {1: 10.8, 2: 10.2, 3: 9.7}   # lognormal median ~49k/27k/16k impressions

# (network, countries, sampling weight, volume scale, kind)
# kind = "paid" (iOS+Android split, has cost) | "free" (os='', no spend, no impressions)
NETWORKS = [
    ("Facebook", TIER1 + TIER2 + TIER3[:8], 1.00, 1.00, "paid"),
    ("Google Ads", TIER1 + TIER2 + TIER3[:8], 1.00, 0.95, "paid"),
    ("TikTok", TIER1 + TIER2 + TIER3[:6], 0.95, 1.05, "paid"),
    ("Google Ads Search", TIER1 + ["ES", "IT"], 0.40, 0.35, "paid"),
    ("Facebook Web", ["US", "GB", "DE", "FR", "JP", "BR", "MX", "IN", "ID", "VN"], 0.40, 0.45, "paid"),
    ("Google Ads H5-Inhouse", TIER3[:6], 0.30, 0.40, "paid"),
    ("Mintegral", ["US", "GB", "DE", "JP", "KR", "BR", "IN", "ID", "VN", "TH", "MX", "TR", "PL", "RU", "SA", "AE"], 0.60, 0.50, "paid"),
    ("Unity Ads", ["US", "GB", "DE", "JP", "KR", "BR", "IN", "ID", "VN", "TH", "MX", "TR", "PL", "RU"], 0.50, 0.45, "paid"),
    ("AppLovin", ["US", "GB", "DE", "JP", "KR", "BR", "ID", "VN", "TH", "MX", "TR", "PL", "RU", "SA"], 0.55, 0.50, "paid"),
    ("ironSource", ["US", "GB", "DE", "JP", "KR", "BR", "IN", "ID", "VN", "TH", "MX", "TR"], 0.40, 0.40, "paid"),
    ("Vungle", ["US", "GB", "DE", "JP", "KR", "BR", "ID", "VN", "TH", "MX"], 0.30, 0.35, "paid"),
    ("Snapchat", ["US", "GB", "FR", "DE", "AE", "SA", "TR", "MX", "BR", "IN"], 0.35, 0.40, "paid"),
    ("Oppo Ads", ["IN", "ID", "VN", "TH", "PH", "MY", "BR", "MX", "RU", "TR", "SA", "AE"], 0.50, 0.45, "paid"),
    ("Vivo Global", ["IN", "ID", "VN", "TH", "PH", "BR", "MX", "RU", "TR", "SA"], 0.40, 0.35, "paid"),
    ("Xiaomi Global", ["IN", "ID", "VN", "TH", "PH", "BR", "MX", "RU", "TR", "SA"], 0.40, 0.35, "paid"),
    ("Chuanyin Ads", ["IN", "ID", "VN", "TH", "PH", "BR", "MX"], 0.35, 0.30, "paid"),
    ("PropellerAds", ["US", "GB", "DE", "BR", "MX", "TR", "PL", "RU", "IN", "ID"], 0.30, 0.30, "paid"),
    ("Transsion Holdings", ["NG", "KE", "IN", "ID", "VN", "PH"], 0.25, 0.25, "paid"),
    ("Organic", TIER1 + TIER2 + TIER3[:4], 0.80, 1.00, "free"),
    ("web", TIER1 + TIER2 + TIER3[:4], 0.80, 0.90, "free"),
    ("Untrusted Devices", ["US", "GB", "DE", "IN", "ID", "VN", "BR", "MX"], 0.20, 0.30, "free"),
]

# Per-network per-country volume scale for free sources (organic installs base)
FREE_BASE_MU = 4.6  # lognormal median ~100 organic installs per row

def gen_campaign(rng: random.Random) -> str:
    """Random campaign name: English abbreviation (2-4 uppercase letters) + number."""
    letters = "".join(rng.choice(string.ascii_uppercase) for _ in range(rng.randint(2, 4)))
    return f"{letters}{rng.randint(100, 99999)}"


def assign_lifecycle(rng: random.Random, ndays: int) -> tuple[int, int]:
    """Decide a campaign's active window [start_day, end_day] within the range.

    Mirrors real ad-ops: some campaigns are always-on flagships, some launch
    mid-flight, some get paused early, and some are short burst tests.
    """
    r = rng.random()
    if r < 0.55:                                   # always-on flagship
        return 0, ndays - 1
    if r < 0.75:                                   # launched mid-flight
        return rng.randint(8, int(ndays * 0.60)), ndays - 1
    if r < 0.90:                                   # paused / killed early
        return 0, rng.randint(int(ndays * 0.35), ndays - 8)
    start = rng.randint(5, ndays - 25)             # short burst test
    return start, start + rng.randint(15, 25)


# ─── Build dimension pool (each entry: network, country, os, campaign_network) ─
def build_pool(rng: random.Random, ndays: int) -> list[dict]:
    pool: list[dict] = []
    for network, countries, net_w, scale, kind in NETWORKS:
        for country in countries:
            tier = TIER_OF[country]
            if kind == "paid":
                for os_name in ("iOS", "Android"):
                    life_start, life_end = assign_lifecycle(rng, ndays)
                    pool.append({
                        "network": network, "country": country, "os": os_name,
                        "campaign": gen_campaign(rng), "kind": kind, "tier": tier,
                        "life_start": life_start, "life_end": life_end,
                        "weight": net_w * TIER_WEIGHT[tier] * (0.7 if os_name == "iOS" else 1.0),
                        "imp_base": round(
                            rng.lognormvariate(TIER_IMP_MU[tier], 0.7) * scale
                            * (0.55 if os_name == "iOS" else 1.0), 0),
                        "ctr": rng.lognormvariate(-4.15 + {1: 0.0, 2: 0.12, 3: 0.25}[tier], 0.22)
                              * (1.08 if os_name == "Android" else 1.0),
                        "cvr": rng.uniform({1: 0.18, 2: 0.15, 3: 0.10}[tier],
                                           {1: 0.34, 2: 0.28, 3: 0.22}[tier])
                              + (0.03 if os_name == "iOS" else 0.0),
                        "cpc": rng.uniform({1: 0.60, 2: 0.35, 3: 0.15}[tier],
                                           {1: 2.00, 2: 1.00, 3: 0.60}[tier])
                              * (1.30 if os_name == "iOS" else 1.0),
                    })
            else:
                pool.append({
                    "network": network, "country": country, "os": "",
                    "campaign": "", "kind": kind, "tier": tier,
                    "life_start": 0, "life_end": ndays - 1,
                    "weight": net_w * TIER_WEIGHT[tier],
                    "org_base": round(rng.lognormvariate(FREE_BASE_MU, 0.8) * scale, 0) if scale else 0,
                    "imp_base": 0.0, "ctr": 0.0, "cvr": 0.0, "cpc": 0.0,
                })
    return pool


def weighted_sample(rng: random.Random, pool: list[dict], k: int) -> list[dict]:
    """Weighted sampling without replacement (exponential race)."""
    keys = [rng.random() ** (1.0 / max(e["weight"], 1e-9)) for e in pool]
    order = sorted(range(len(pool)), key=lambda i: keys[i], reverse=True)
    return [pool[i] for i in order[:k]]


def weekday_factor(d: date) -> float:
    return {5: 0.70, 6: 0.60}.get(d.weekday(), 1.0 if d.weekday() != 4 else 1.05)


def gen_rows() -> tuple[list[tuple], int]:
    rng = random.Random(SEED)
    ndays = (END - START).days + 1
    pool = build_pool(rng, ndays)
    days = [(START + timedelta(days=i)) for i in range(ndays)]
    # first 44 days get 77 rows, remaining 87 days get 76 rows -> exactly 10,000
    targets = [77 if i < 44 else 76 for i in range(ndays)]

    rows: list[tuple] = []
    ar = 0.0  # AR(1) state -> autocorrelated daily volume noise (smooth trends)
    for di, d in enumerate(days):
        # 1) 自相关大盘噪声（AR(1)，比 iid 更贴近真实趋势：昨天好今天大概率也好）
        ar = 0.70 * ar + rng.gauss(0.0, 0.11)
        day_noise = math.exp(max(-0.35, min(0.35, ar)))          # ~0.70 .. 1.42
        growth = 1.0 + 0.28 * (di / max(ndays - 1, 1))           # 业务线性爬坡
        seasonal = 1.0 + 0.06 * math.sin(2 * math.pi * di / 30.0)  # 月度轻周期
        cpc_drift = 1.0 + 0.15 * (di / max(ndays - 1, 1))        # 竞价推高 CPC
        day_factor = weekday_factor(d) * growth * seasonal * day_noise

        # 2) 仅当日处于活动生命周期窗口内的投放位可被抽中
        active = [e for e in pool if e["life_start"] <= di <= e["life_end"]]
        k = targets[di]
        assert len(active) >= k, f"day {d}: only {len(active)} active, need {k}"
        chosen = weighted_sample(rng, active, k)

        for e in chosen:
            kind = e["kind"]
            # 3) 生命周期首尾预算爬坡；窗口边界（=数据边界）的常驻活动不爬坡
            up = 1.0 if e["life_start"] == 0 else min(1.0, (di - e["life_start"] + 1) / 3.0)
            down = 1.0 if e["life_end"] == ndays - 1 else min(1.0, (e["life_end"] - di + 1) / 3.0)
            ramp = min(up, down)
            # 4) 创意疲劳：CTR 随活动投放天数缓慢衰减
            fatigue = max(0.72, 1.0 - 0.0022 * (di - e["life_start"]))

            if kind == "paid":
                impressions = max(0, int(e["imp_base"] * day_factor * ramp))
                # 率值每日波动（受众饱和 / 竞价环境），不再全周期固定
                ctr = e["ctr"] * fatigue * rng.lognormvariate(0.0, 0.12)
                cvr = e["cvr"] * rng.lognormvariate(0.0, 0.10)
                cpc = e["cpc"] * cpc_drift * rng.lognormvariate(0.0, 0.08)
                clicks = int(impressions * ctr)
                installs = int(clicks * cvr)
                organic = 0                 # 付费网络行恒为非自然量（真实 MMP 口径）
                non_organic = installs
                sessions = int(installs * rng.uniform(1.8, 5.5) * growth)
                base_sessions = int(sessions * rng.uniform(0.62, 0.93))
                reattrib = int(installs * rng.uniform(0.01, 0.05))
                registers = int(installs * rng.uniform(0.18, 0.45))
                fd = int(registers * rng.uniform(0.12, 0.28))
                rd = int(registers * rng.uniform(0.0, 0.05))   # 召回充值随规模缩放
                daus = int(installs * rng.uniform(2.0, 6.0) * growth)  # 含历史活跃用户
                rejected = int(installs * rng.uniform(0.0, 0.04))
                cost = round(clicks * cpc, 2)
                adjust_cost = round(cost * rng.uniform(0.995, 1.005), 2)
            else:  # free: no impressions/clicks/spend, no anti-fraud/re-attribution
                impressions = clicks = 0
                installs = max(0, int(e["org_base"] * day_factor * ramp))
                organic = installs
                non_organic = 0
                sessions = int(installs * rng.uniform(1.5, 4.0) * growth)
                base_sessions = int(sessions * rng.uniform(0.62, 0.93))
                reattrib = 0
                registers = int(installs * rng.uniform(0.12, 0.30))
                fd = int(registers * rng.uniform(0.10, 0.25))
                rd = int(registers * rng.uniform(0.0, 0.04))
                daus = int(installs * rng.uniform(3.0, 9.0) * growth)
                rejected = 0
                cost = adjust_cost = 0.0

            rows.append((
                d.isoformat(), e["network"], e["country"], e["os"], e["campaign"],
                impressions, clicks, installs, sessions, base_sessions,
                organic, non_organic, reattrib, registers, fd, rd,
                daus, rejected,
                f"{cost:.4f}", f"{adjust_cost:.4f}", "0.0000", SYNCED_AT,
            ))
    return rows, ndays


COLUMNS = (
    "stat_date, network, country_code, os_name, campaign_network, "
    "impressions, clicks, installs, sessions, base_sessions, "
    "organic_installs, non_organic_installs, reattributions, "
    "register_cnt, first_deposit_cnt, recall_deposit_cnt, "
    "daus, rejected_installs, cost, adjust_cost, network_cost, synced_at"
)

DDL = """CREATE TABLE IF NOT EXISTS data.adjust_daily_metrics (
    stat_date date NOT NULL,
    network text NOT NULL,
    country_code text NOT NULL,
    os_name text NOT NULL DEFAULT '',
    campaign_network text NOT NULL DEFAULT '',
    impressions bigint NOT NULL DEFAULT 0,
    clicks bigint NOT NULL DEFAULT 0,
    installs bigint NOT NULL DEFAULT 0,
    sessions bigint NOT NULL DEFAULT 0,
    base_sessions bigint NOT NULL DEFAULT 0,
    organic_installs bigint NOT NULL DEFAULT 0,
    non_organic_installs bigint NOT NULL DEFAULT 0,
    reattributions bigint NOT NULL DEFAULT 0,
    register_cnt bigint NOT NULL DEFAULT 0,
    first_deposit_cnt bigint NOT NULL DEFAULT 0,
    recall_deposit_cnt bigint NOT NULL DEFAULT 0,
    daus bigint NOT NULL DEFAULT 0,
    rejected_installs bigint NOT NULL DEFAULT 0,
    cost numeric(18,4) NOT NULL DEFAULT 0,
    adjust_cost numeric(18,4) NOT NULL DEFAULT 0,
    network_cost numeric(18,4) NOT NULL DEFAULT 0,
    synced_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT adjust_daily_metrics_pkey PRIMARY KEY (stat_date, network, country_code, os_name, campaign_network)
);"""


def sql_literal(v: object) -> str:
    """Format one value as a PostgreSQL SQL literal."""
    if isinstance(v, str):
        return "'" + v.replace("'", "''") + "'"
    return str(v)


def main() -> None:
    rows, ndays = gen_rows()
    assert len(rows) == 10_000, f"expected 10000 rows, got {len(rows)}"

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    header = f"""--
-- Mock data for data.adjust_daily_metrics (10000 rows)
-- stat_date range: {START.isoformat()} ~ {END.isoformat()} ({ndays} days)
-- Generated by: scripts/generate-adjust-mock-data.py (seed={SEED})
--
-- Realism notes (aligned with this account's production profile):
--   * network vocabulary: Facebook / Google Ads / TikTok / programmatic /
--     regional DSPs / zero-cost sources (Organic, web, Untrusted Devices)
--   * network_cost 恒为 0（该账号未接入渠道成本 API，与生产口径一致）
--   * cost / adjust_cost 仅出现在付费网络行；免费来源行花费为 0
--   * installs = organic_installs + non_organic_installs，恒成立
--   * 付费行恒为非自然量(organic=0)，免费行恒为自然量(non_organic=0)
--   * 免费来源行无 impressions/clicks，rejected_installs / reattributions 为 0
--   * 活动生命周期、AR(1) 大盘噪声、CTR/CVR/CPC 日波动、创意疲劳与 CPC 通胀
--
-- Load:
--   psql "$DATABASE_URL" -f data/adjust_daily_metrics_mock_20260501_20260908.sql
-- (如需先清空既有数据，加载前手动执行: TRUNCATE TABLE data.adjust_daily_metrics;)
--

{DDL}
"""

    col_list = ", ".join(c.strip() for c in COLUMNS.split(","))
    chunk = 500  # rows per INSERT statement
    stmts: list[str] = []
    for i in range(0, len(rows), chunk):
        values = ",\n".join(
            "(" + ", ".join(sql_literal(v) for v in r) + ")" for r in rows[i : i + chunk]
        )
        stmts.append(f"INSERT INTO data.adjust_daily_metrics ({col_list})\nVALUES\n{values};")
    OUT_PATH.write_text(header + "\n".join(stmts) + "\n", encoding="utf-8")
    print(f"wrote {len(rows)} rows ({ndays} days, {len(stmts)} INSERT statements) -> {OUT_PATH}")


if __name__ == "__main__":
    main()
