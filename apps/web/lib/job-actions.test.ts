import assert from "node:assert/strict";
import test from "node:test";
import { jobActionMessage } from "../app/dashboard/JobActions";

test("job actions expose precise durable transition outcomes", () => {
  assert.equal(jobActionMessage({ ok: true }, "retry"), "retry 已提交");
  assert.equal(
    jobActionMessage({ ok: false, error: "not_found" }, "cancel"),
    "任务不存在或已被清理",
  );
  assert.equal(
    jobActionMessage(
      { ok: false, error: "invalid_state_transition" },
      "cancel",
    ),
    "任务状态已变化，请刷新后重试",
  );
});
