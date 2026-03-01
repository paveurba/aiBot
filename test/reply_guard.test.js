const test = require("node:test");
const assert = require("node:assert/strict");

const { stripStaleCoordinatorReply } = require("../lib/reply_guard");

test("strips stale coordinator message from replies", () => {
  const staleReply = [
    "/coord <goal> forces coordinator mode.",
    "",
    "It tells worker-1 to split your goal into sub-tasks for workers 2..10.",
  ].join("\n");

  const result = stripStaleCoordinatorReply(staleReply);
  assert.ok(!/\/coord\s*<goal>\s*forces\s*coordinator\s*mode/i.test(result));
  assert.match(result, /Coordinator mode is automatic now\./);
});

test("keeps non-stale reply content unchanged", () => {
  const cleanReply = "Build completed. All tests passed.";
  const result = stripStaleCoordinatorReply(cleanReply);
  assert.equal(result, cleanReply);
});
