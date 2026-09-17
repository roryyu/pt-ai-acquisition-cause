"use client";

import { useEffect } from "react";

/** 会话探测间隔：与 Access principal 缓存同量级，撤权/停用一个轮询周期内可感知 */
const PROBE_INTERVAL_MS = 60_000;

/**
 * 会话活性监测（挂在 dashboard layout，不渲染任何 UI）。
 *
 * 解决的问题：BFF 会话可能在页面打开期间失效——空闲超时、Access 侧撤权/停用、
 * 管理员改权。此时页面仍是旧快照，用户下一次操作才会撞上 401，体验很割裂。
 *
 * 策略（够用就好）：
 * - 定时探测 /api/auth/session，仅在标签页可见时轮询，后台标签不做无谓请求；
 * - 标签页重新可见时立即探测一次（覆盖「电脑休眠一夜后回到页面」这个高发场景）；
 * - 只有 401 才跳转重新登录；503（Access 不可达）等一律忽略，避免服务抖动时把人踢出去。
 *
 * 跳转目标选 /api/auth/login 而不是 /login：identity 的 SSO 会话若还在，
 * 整个过程对用户是无感的；若权限真被收回，Entry Gate 会把人拦在错误页。
 */
export function SessionWatch() {
  useEffect(() => {
    let redirecting = false;

    const probe = async () => {
      if (redirecting || document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/auth/session", { cache: "no-store" });
        if (res.status !== 401) return;
        redirecting = true;
        const returnTo = window.location.pathname + window.location.search;
        // 刻意用整页跳转而非 router.push：会话已失效，需要丢掉全部客户端状态，
        // 让服务端重新走一遍鉴权（router 软导航会保留旧页面快照，反而更容易出错）
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
      } catch {
        // 网络抖动：本轮跳过，等下一个周期
      }
    };

    const timer = window.setInterval(probe, PROBE_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void probe();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return null;
}
