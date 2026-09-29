/**
 * BFF 会话与 OIDC 登录事务管理
 * 设计见 doc/鉴权接入PT-AI-Access设计.md D2/D5：
 * - 浏览器只持有 httpOnly 不透明 session token（明文不落库，DB 存 SHA-256）
 * - state/nonce/code_verifier 存 OidcTransaction，callback 一次性消费
 * - 每次请求经 Access principal 复核（60s 缓存，fail-closed），撤销即时生效
 */
import { env } from "@/lib/env";
import { prisma } from "@/lib/db";

import { AccessDeniedError, fetchPrincipal, invalidatePrincipal } from "./access-client";
import { pkceChallenge, randomToken, sha256Hex } from "./oidc";

/** 会话 cookie 名 */
export const SESSION_COOKIE = "pt_cause_session";
/** 空闲超时（12 小时无操作即失效） */
const SESSION_IDLE_SECONDS = 43_200;
/** 会话最长存活（7 天，滑动续期上限） */
const SESSION_MAX_SECONDS = 604_800;
/** 登录事务有效期（10 分钟，覆盖用户在 Keycloak 输密码的时间） */
const TRANSACTION_TTL_SECONDS = 600;
/** lastSeenAt 回写节流：距上次超过该秒数才更新，避免每请求写库 */
const TOUCH_THROTTLE_SECONDS = 60;

/** requireActor 返回的业务身份（27 个既有调用点消费的字段保持不变） */
export interface Actor {
  /** Access subject（Keycloak UUID），与 User.id 同值 */
  id: string;
  name: string;
  email: string;
  /** cause 原生业务角色（admin/analyst/operator/viewer），Access 不接管 */
  role: string;
}

/** 会话 cookie 属性（路由用 response.cookies.set 下发） */
export function buildSessionCookie(value: string | null): {
  name: string;
  value: string;
  httpOnly: boolean;
  path: string;
  sameSite: "lax";
  secure: boolean;
  maxAge: number;
} {
  return {
    name: SESSION_COOKIE,
    value: value ?? "",
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    maxAge: value ? SESSION_MAX_SECONDS : 0,
  };
}

// ─── OIDC 登录事务 ───────────────────────────────────────────────────────
/**
 * 发起登录：生成 state/nonce/verifier 并落库（哈希后），返回拼授权 URL 所需参数
 */
export async function createLoginTransaction(returnTo: string | null): Promise<{
  state: string;
  nonce: string;
  codeChallenge: string;
}> {
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(64);
  await prisma.oidcTransaction.create({
    data: {
      id: sha256Hex(state),
      nonce,
      verifier,
      returnTo,
      expiresAt: new Date(Date.now() + TRANSACTION_TTL_SECONDS * 1000),
    },
  });
  // 惰性清理过期记录（登录发起频率低，顺带做即可，无需定时任务）
  const cutoff = new Date();
  await Promise.all([
    prisma.oidcTransaction.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
    prisma.authSession.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
  ]).catch(() => {});
  return { state, nonce, codeChallenge: pkceChallenge(verifier) };
}

/**
 * callback 消费登录事务：校验存在/未过期/未被用过，标记 claimed 后返回
 * 事务不存在或已消费返回 null（state 无效，疑似 CSRF 或重放）
 */
export async function claimLoginTransaction(
  state: string,
): Promise<{ nonce: string; verifier: string; returnTo: string | null } | null> {
  const id = sha256Hex(state);
  const transaction = await prisma.oidcTransaction.findUnique({ where: { id } });
  if (!transaction || transaction.claimedAt || transaction.expiresAt <= new Date()) {
    return null;
  }
  await prisma.oidcTransaction.update({ where: { id }, data: { claimedAt: new Date() } });
  return { nonce: transaction.nonce, verifier: transaction.verifier, returnTo: transaction.returnTo };
}

// ─── 会话 ────────────────────────────────────────────────────────────────
/** 创建会话，返回明文 token（仅经 httpOnly cookie 下发，DB 只存哈希） */
export async function createSession(subject: string): Promise<string> {
  const token = randomToken();
  await prisma.authSession.create({
    data: {
      id: sha256Hex(token),
      subject,
      idleSeconds: SESSION_IDLE_SECONDS,
      expiresAt: new Date(Date.now() + SESSION_MAX_SECONDS * 1000),
    },
  });
  return token;
}

/** 从请求 Cookie 头解析会话 token（不查库） */
export function readSessionToken(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE && rest.length > 0) {
      const value = rest.join("=");
      if (value) return value;
    }
  }
  return null;
}

/** 撤销请求携带的会话（登出/复核不过时调用），并清理 principal 缓存 */
export async function revokeCurrentSession(request: Request): Promise<void> {
  const token = readSessionToken(request);
  if (!token) return;
  const session = await prisma.authSession.findUnique({ where: { id: sha256Hex(token) } });
  if (session && !session.revokedAt) {
    await prisma.authSession
      .update({ where: { id: session.id }, data: { revokedAt: new Date() } })
      .catch(() => {});
    invalidatePrincipal(session.subject);
  }
}

/**
 * 解析请求的业务身份：cookie → 会话有效性 → Access principal 复核 → 本地 User
 * 未登录/会话失效/被 Access 拒绝返回 null；Access 不可达抛 AccessUnavailableError（fail-closed）
 */
export async function getSessionActor(request: Request): Promise<Actor | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const session = await prisma.authSession.findUnique({ where: { id: sha256Hex(token) } });
  if (!session || session.revokedAt) return null;

  const now = new Date();
  const idleDeadline = new Date(session.lastSeenAt.getTime() + session.idleSeconds * 1000);
  if (session.expiresAt <= now || idleDeadline <= now) {
    await prisma.authSession.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  // 请求期复核：Access 拒绝（停用/撤权）→ 会话即刻作废；不可达 → 上抛由调用方 fail-closed
  try {
    await fetchPrincipal(session.subject);
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      await prisma.authSession
        .update({ where: { id: session.id }, data: { revokedAt: now } })
        .catch(() => {});
      return null;
    }
    throw error;
  }

  const user = await prisma.user.findUnique({ where: { id: session.subject } });
  if (!user) {
    // 会话存在但本地用户被删（如手工清库）：按 subject 重建最小档案
    const rebuilt = await upsertUserFromSubject(session.subject);
    if (!rebuilt) return null;
    return { id: rebuilt.id, name: rebuilt.name, email: rebuilt.email ?? "", role: rebuilt.role };
  }

  // 滑动续期（节流回写，避免每请求 UPDATE）
  if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_THROTTLE_SECONDS * 1000) {
    await prisma.authSession
      .update({
        where: { id: session.id },
        data: {
          lastSeenAt: now,
          expiresAt: new Date(now.getTime() + SESSION_MAX_SECONDS * 1000),
        },
      })
      .catch(() => {});
  }
  return { id: user.id, name: user.name, email: user.email ?? "", role: user.role };
}

/**
 * 按 principal 落地/更新本地 User（JIT）：id = Access subject，业务角色保持 cause 自管
 * upsert 不覆盖既有 role——Access 撤销/变更不影响 cause 内部授权
 */
export async function upsertUserFromPrincipal(principal: {
  subject: string;
  username: string;
  usernameDisplay: string;
  displayName: string;
  email: string | null;
}): Promise<{ id: string; name: string; email: string | null; role: string }> {
  const data = {
    username: principal.username,
    email: principal.email,
    name: principal.displayName || principal.usernameDisplay || principal.username,
    lastLoginAt: new Date(),
  };
  // email 唯一约束让位：鉴权桩时代的历史用户（如 user_dev_default）可能占用同一邮箱，
  // Access subject 是权威身份，旧行清空 email 避免 upsert 撞 P2002
  if (principal.email) {
    await prisma.user
      .updateMany({
        where: { email: principal.email, NOT: { id: principal.subject } },
        data: { email: null },
      })
      .catch(() => {});
  }
  const user = await prisma.user.upsert({
    where: { id: principal.subject },
    create: { id: principal.subject, ...data },
    update: data,
  });
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

/** 仅有 subject 时的最小重建（principal 拉不到具体档案的兜底） */
async function upsertUserFromSubject(subject: string) {
  const principal = await fetchPrincipal(subject).catch(() => null);
  if (!principal) return null;
  return upsertUserFromPrincipal(principal);
}
