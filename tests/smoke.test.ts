import { describe, expect, it } from "vitest";

describe("项目初始化冒烟测试", () => {
  it("ESM 运行时与测试框架工作正常", () => {
    expect(typeof process).toBe("object");
    expect(typeof fetch).toBe("function");
  });
});
