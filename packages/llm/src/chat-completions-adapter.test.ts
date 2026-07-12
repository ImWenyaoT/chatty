// parseJsonObject 的单元测试：completeJson 的 JSON 解析兜底是所有结构化
// LLM 输出（意图分类、信息抽取、评估器）的地基。非严格 provider 会无视
// response_format 往 JSON 前后塞说明文字，这里把回退提取行为固定下来。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonObject } from "./chat-completions-adapter.js";

test("纯 JSON 字符串直接解析", () => {
  assert.deepEqual(parseJsonObject('{"actionClass":"ask_info","n":1}'), {
    actionClass: "ask_info",
    n: 1,
  });
});

test("JSON 前后夹杂说明文字时用正则提取兜底", () => {
  const raw = '好的，分类结果如下：{"actionClass":"small_talk"} 请查收';
  assert.deepEqual(parseJsonObject(raw), { actionClass: "small_talk" });
});

test("markdown 代码块包裹的 JSON 也能提取", () => {
  const raw = '```json\n{"reason":"寒暄","reply":"您好"}\n```';
  assert.deepEqual(parseJsonObject(raw), { reason: "寒暄", reply: "您好" });
});

test("嵌套对象带前后缀文字时整体提取（贪婪匹配到最后一个右花括号）", () => {
  const raw = '输出：{"a":{"b":[1,2]}}。';
  assert.deepEqual(parseJsonObject(raw), { a: { b: [1, 2] } });
});

test("完全不含 JSON 对象时抛错并附回复片段便于排查", () => {
  assert.throws(
    () => parseJsonObject("抱歉，我无法以 JSON 回答"),
    /could not parse JSON/,
  );
});

test("多个并列 JSON 对象时贪婪匹配会解析失败（固定现状）", () => {
  // 正则 /\{[\s\S]*\}/ 贪婪匹配首个 { 到最后一个 }，两个并列对象会拼成非法 JSON 直接抛错。
  // 已知限制：若日后改进为提取第一个合法对象，这条用例提醒同步更新契约。
  assert.throws(() => parseJsonObject('{"a":1} 以及 {"b":2}'));
});
