import { describe, expect, it } from "vitest";

import {
  ACQUISITION_SCOPE_ENV,
  isBatchCaptureScopeAllowed,
  resolveAcquisitionScope,
} from "@/lib/server/acquisitionScope";

/**
 * 运行范围门禁：默认只允许单 ASIN 采集。
 * 批量采集（BCR 创建 / 自动分轮 / 执行器）必须显式声明 `V5_ACQUISITION_SCOPE=batch_and_single`。
 */
describe("采集运行范围门禁", () => {
  it("未声明时默认只允许单 ASIN（批量关闭）", () => {
    expect(resolveAcquisitionScope({})).toBe("single_asin_only");
    expect(isBatchCaptureScopeAllowed({})).toBe(false);
  });

  it("显式声明 batch_and_single 才放开批量", () => {
    expect(resolveAcquisitionScope({ [ACQUISITION_SCOPE_ENV]: "batch_and_single" })).toBe("batch_and_single");
    expect(isBatchCaptureScopeAllowed({ [ACQUISITION_SCOPE_ENV]: "batch_and_single" })).toBe(true);
  });

  it("非法值按默认关闭处理，不因拼写错误意外放开", () => {
    for (const value of ["", "batch", "BATCH_AND_SINGLE", "true", "1", "all"]) {
      expect(resolveAcquisitionScope({ [ACQUISITION_SCOPE_ENV]: value })).toBe("single_asin_only");
      expect(isBatchCaptureScopeAllowed({ [ACQUISITION_SCOPE_ENV]: value })).toBe(false);
    }
  });
});
