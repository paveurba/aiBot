const test = require("node:test");
const assert = require("node:assert/strict");

const { CommandService } = require("../lib/command_service");

test("smoke: repeated text requests in voice mode trigger stable voice replies", async () => {
  const voiceCalls = [];
  const textReplies = [];
  const promptsSeen = [];
  const voiceRequestIds = [];

  const service = new CommandService({
    bot: {
      sendMessage: async () => {},
    },
    store: {
      getChatSettings: async () => ({ voiceReplies: "1" }),
      setChatSettings: async () => {},
      clearChat: async () => {},
      getSession: async () => "seed-session",
      setSession: async () => {},
    },
    orchestrator: {
      getDispatchStatus: () => null,
      clearDispatchStatus: () => {},
      decideExecutionMode: async () => ({ mode: "direct", tasks: [] }),
      runAgentDispatch: async (_agent, options) => {
        promptsSeen.push(String(options.prompt));
        return { sessionId: "voice-session", reply: `spoken: ${options.prompt}` };
      },
      sendReply: async (_chatId, text) => {
        textReplies.push(String(text));
      },
      sendVoiceReply: async (_chatId, text, options = {}) => {
        voiceCalls.push(String(text));
        voiceRequestIds.push(String(options.requestId || ""));
        return true;
      },
    },
    defaultModel: "codex",
    reuseSessions: true,
    trimTelegram: (text) => String(text || ""),
    resolveAgent: () => "codex",
    resolveCodexModel: () => null,
    logInfo: () => {},
    logError: () => {},
  });

  const requests = ["ping one", "ping two", "ping three"];
  for (const request of requests) {
    const handled = await service.handleMessage("smoke-chat", request);
    assert.equal(handled, true);
  }

  assert.deepEqual(promptsSeen, requests);
  assert.equal(textReplies.length, requests.length);
  assert.equal(voiceCalls.length, requests.length);
  assert.ok(voiceCalls.every((item) => item.startsWith("spoken: ")));
  assert.equal(new Set(voiceRequestIds).size, requests.length);
  assert.ok(voiceRequestIds.every((id) => id.startsWith("voice-")));
});
