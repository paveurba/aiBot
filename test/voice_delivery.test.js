const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { validateVoiceFile, sendVoiceWithRetry } = require("../lib/voice_delivery");

function writeTempFile(name, data) {
  const p = path.join(os.tmpdir(), name);
  fs.writeFileSync(p, data);
  return p;
}

test("validateVoiceFile accepts valid ogg/opus files", () => {
  const filePath = writeTempFile(`voice-valid-${Date.now()}.ogg`, Buffer.from("OggSvoicepayload", "utf8"));
  const resolved = validateVoiceFile(filePath);
  assert.equal(resolved, path.resolve(filePath));
  fs.unlinkSync(filePath);
});

test("validateVoiceFile rejects unsupported format extension", () => {
  const filePath = writeTempFile(`voice-invalid-ext-${Date.now()}.mp3`, Buffer.from("OggSvoicepayload", "utf8"));
  assert.throws(() => validateVoiceFile(filePath), /Unsupported voice file format/);
  fs.unlinkSync(filePath);
});

test("validateVoiceFile rejects invalid ogg header", () => {
  const filePath = writeTempFile(`voice-invalid-header-${Date.now()}.ogg`, Buffer.from("NOPEcontent", "utf8"));
  assert.throws(() => validateVoiceFile(filePath), /Invalid OGG container header/);
  fs.unlinkSync(filePath);
});

test("sendVoiceWithRetry retries transient telegram failures and succeeds", async () => {
  const filePath = writeTempFile(`voice-retry-${Date.now()}.ogg`, Buffer.from("OggSretrypayload", "utf8"));
  const events = [];
  const logger = (event, fields) => events.push({ event, ...(fields || {}) });
  let attempts = 0;

  const requestFn = async () => {
    attempts += 1;
    if (attempts === 1) {
      return {
        statusCode: 429,
        body: JSON.stringify({
          ok: false,
          description: "Too Many Requests",
          parameters: { retry_after: 1 },
        }),
      };
    }
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true }),
    };
  };

  let sleptMs = 0;
  const sleepFn = async (ms) => {
    sleptMs += ms;
  };

  const result = await sendVoiceWithRetry({
    token: "token",
    chatId: "123",
    filePath,
    maxAttempts: 3,
    logger,
    sleepFn,
    requestFn,
  });

  assert.equal(result.statusCode, 200);
  assert.equal(attempts, 2);
  assert.ok(sleptMs >= 1000);
  assert.ok(events.some((e) => e.event === "voice_send_retry"));
  assert.ok(events.some((e) => e.event === "voice_send_success"));
  fs.unlinkSync(filePath);
});

test("sendVoiceWithRetry fails fast on non-retryable errors", async () => {
  const filePath = writeTempFile(`voice-fail-${Date.now()}.ogg`, Buffer.from("OggSfailpayload", "utf8"));
  let attempts = 0;

  await assert.rejects(
    () =>
      sendVoiceWithRetry({
        token: "token",
        chatId: "123",
        filePath,
        maxAttempts: 3,
        logger: () => {},
        sleepFn: async () => {},
        requestFn: async () => {
          attempts += 1;
          return {
            statusCode: 400,
            body: JSON.stringify({ ok: false, description: "Bad Request: wrong file identifier" }),
          };
        },
      }),
    /Telegram voice send failed/
  );

  assert.equal(attempts, 1);
  fs.unlinkSync(filePath);
});
