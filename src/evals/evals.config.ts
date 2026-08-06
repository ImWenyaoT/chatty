/**
 * `evals/` 根的唯一配置文件。
 *
 * eve 在这里放 judge model、reporters、maxConcurrency——那些都是它 runner 的配置项。
 * chatty 的 runner 只需要两件事：默认 gate，以及缺少凭据时怎么处理需要 Model 的 Eval。
 */

import type { EvalResult } from "./lib/define-eval.ts";

export type EvalsConfig = {
  /** 每个 Eval 未自带 gate 时用它判定。默认要求全部 case 通过。 */
  defaultGate: (result: EvalResult) => boolean;
  /** 缺少 Model 凭据时：skip 记为跳过并保持退出码 0，fail 直接判失败。 */
  onMissingCredentials: "skip" | "fail";
};

export default {
  defaultGate: (result) => result.passed === result.total,
  onMissingCredentials: "fail",
} satisfies EvalsConfig;
