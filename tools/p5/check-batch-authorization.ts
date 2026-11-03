import {
  P5_BATCH_CASES,
  P5_BATCH_BUDGET_CNY,
  P5_BATCH_INPUT_CAP_TOKENS,
  P5_BATCH_MODEL,
  P5BatchAuthorizationError,
  assertBatchRunAuthorized,
  defaultBatchGateConfig,
} from "../../lib/server/research/realModelBatchRunner";
import { CHAIN_OUTPUT_CAP_TOKENS } from "../../lib/server/research/batchInputBudget";

/**
 * 批次开跑前的授权与参数自检（只读，不发送任何请求）。
 *
 *   npx tsx tools/p5/check-batch-authorization.ts
 *
 * 退出码：0 = 授权通过；1 = 拒绝运行（原因会打印）。
 */
function main(): number {
  const gateConfig = defaultBatchGateConfig();
  const lines: string[] = [];

  lines.push("P5 真实模型批次 · 开跑前自检");
  lines.push(`模型 ${P5_BATCH_MODEL} · 输入上限 ${P5_BATCH_INPUT_CAP_TOKENS} tokens/请求 · 预算 ≤ ¥${P5_BATCH_BUDGET_CNY}`);
  lines.push(`输出上限 V1=${CHAIN_OUTPUT_CAP_TOKENS.v1} / V5=${CHAIN_OUTPUT_CAP_TOKENS.v5} · 最大请求数 ${gateConfig.maxRequests} · 连续失败 ${gateConfig.maxConsecutiveFailures} 例停批`);
  lines.push("");
  lines.push("样例：");
  for (const item of P5_BATCH_CASES) {
    lines.push(`  #${item.id} [${item.chain}] ${item.asin}  ${item.taskId}  — ${item.purpose}`);
  }
  lines.push("");

  try {
    const authorized = assertBatchRunAuthorized({
      mode: process.env.P5_BATCH_MODE,
      env: process.env,
      budgetCny: gateConfig.budgetCny,
    });
    lines.push(`授权：PASS（mode=${authorized.mode}）`);
    if (authorized.mode === "stub") {
      lines.push("提示：stub 模式只会打到本机替身，不会产生真实费用。");
    } else {
      lines.push(`提示：real 模式将发出最多 ${gateConfig.maxRequests} 次真实请求，最坏费用见方案文档 §7。`);
    }
    console.log(lines.join("\n"));
    return 0;
  } catch (error) {
    if (error instanceof P5BatchAuthorizationError) {
      lines.push(`授权：REFUSED [${error.code}]`);
      lines.push(error.message);
      console.log(lines.join("\n"));
      return 1;
    }
    throw error;
  }
}

process.exitCode = main();
