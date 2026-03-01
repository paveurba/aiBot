const STALE_COORDINATOR_REPLY_PATTERNS = [
  /\/coord\s*<goal>\s*forces\s*coordinator\s*mode\.?/i,
];

function stripStaleCoordinatorReply(text) {
  const value = String(text || "");
  const hasStaleReply = STALE_COORDINATOR_REPLY_PATTERNS.some((pattern) => pattern.test(value));
  if (!hasStaleReply) return value;

  return [
    "Coordinator mode is automatic now.",
    "Send your request directly and I will route it.",
  ].join("\n");
}

module.exports = {
  stripStaleCoordinatorReply,
  STALE_COORDINATOR_REPLY_PATTERNS,
};
