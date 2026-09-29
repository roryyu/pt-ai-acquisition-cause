import { describe, expect, it } from "vitest";

import { safeRelativeReturnTo } from "@/lib/server/auth/safe-return-to";

/**
 * 登录回跳目标白名单：这是开放重定向的唯一防线，
 * /api/auth/login 与登录页共用，任何一条被绕过都等于把用户送去钓鱼站。
 */
describe("safeRelativeReturnTo", () => {
  it("放行常规站内路径并保留 query 与 hash", () => {
    expect(safeRelativeReturnTo("/insights")).toBe("/insights");
    expect(safeRelativeReturnTo("/insights?id=1&tab=2")).toBe("/insights?id=1&tab=2");
    expect(safeRelativeReturnTo("/boards#section")).toBe("/boards#section");
    expect(safeRelativeReturnTo("/")).toBe("/");
  });

  it("空值与非法类型回落 fallback", () => {
    expect(safeRelativeReturnTo(null)).toBe("/");
    expect(safeRelativeReturnTo(undefined)).toBe("/");
    expect(safeRelativeReturnTo("")).toBe("/");
    expect(safeRelativeReturnTo(null, "/boards")).toBe("/boards");
    expect(safeRelativeReturnTo(123 as unknown as string)).toBe("/");
  });

  it("拒绝站外与协议相对地址（开放重定向）", () => {
    expect(safeRelativeReturnTo("https://evil.com/x")).toBe("/");
    expect(safeRelativeReturnTo("//evil.com/x")).toBe("/");
    expect(safeRelativeReturnTo("/\\evil.com")).toBe("/");
    expect(safeRelativeReturnTo("javascript:alert(1)")).toBe("/");
  });

  it("拒绝编码绕过与控制字符", () => {
    expect(safeRelativeReturnTo("/%2fevil.com")).toBe("/");
    expect(safeRelativeReturnTo("/%5Cevil.com")).toBe("/");
    expect(safeRelativeReturnTo("/insights\nSet-Cookie: x=1")).toBe("/");
    expect(safeRelativeReturnTo("/insights\u0000")).toBe("/");
  });

  it("排除 /login 与 /api/auth/*，避免重定向死循环", () => {
    expect(safeRelativeReturnTo("/login")).toBe("/");
    expect(safeRelativeReturnTo("/LOGIN?x=1")).toBe("/");
    expect(safeRelativeReturnTo("/api/auth/login")).toBe("/");
    expect(safeRelativeReturnTo("/api/auth/callback?code=x")).toBe("/");
  });

  it("超长地址回落 fallback", () => {
    expect(safeRelativeReturnTo(`/${"a".repeat(2000)}`)).toBe("/");
    expect(safeRelativeReturnTo(`/${"a".repeat(2000)}`, "/", 4096)).toBe(`/${"a".repeat(2000)}`);
  });
});
