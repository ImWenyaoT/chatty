/**
 * 声明一个 Eval，但不写它的名字——名字由 runner 从文件路径派生。
 *
 * 与 `agent/tools/` 的区别在判别方式：`tools/` 下每个 `.ts` 都是 Tool，而 `evals/` 用
 * `*.eval.ts` 后缀判别，所以本目录里可以并存 `lib/` 和 `evals.config.ts` 这类非 Eval 模块。
 * 两者仍是同一条规则：身份来自路径，文件里不写 id 或 name。
 */

/** 一次 Eval 的结果。`metrics` 是给人看的补充读数，不参与 gate 判定。 */
export type EvalResult = {
  passed: number;
  total: number;
  metrics?: Readonly<Record<string, number>>;
};

export type EvalDefinition = {
  description: string;
  /** 是否需要 Model API key。runner 用它决定跳过还是执行。 */
  requiresModel?: boolean;
  /** 返回 false 即判定未通过，runner 据此设置退出码。缺省用 config 的 defaultGate。 */
  gate?: (result: EvalResult) => boolean;
  run: () => Promise<EvalResult> | EvalResult;
};

export function defineEval(definition: EvalDefinition): EvalDefinition {
  return definition;
}
