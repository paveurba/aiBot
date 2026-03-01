const test = require("node:test");
const assert = require("node:assert/strict");

const { CommandService } = require("../lib/command_service");

function createService({ chatSettings = {}, orchestratorOverrides = {}, storeOverrides = {} } = {}) {
  const state = {
    settings: { ...chatSettings },
    savedSettings: [],
    savedSessions: [],
  };

  const store = {
    getChatSettings: async () => ({ ...state.settings }),
    setChatSettings: async (_chatId, value) => {
      state.settings = { ...(value || {}) };
      state.savedSettings.push({ ...state.settings });
    },
    clearChat: async () => {
      state.settings = {};
    },
    getSession: async () => null,
    setSession: async (chatId, agent, sessionId) => {
      state.savedSessions.push({ chatId, agent, sessionId });
    },
    ...storeOverrides,
  };

  const sentMessages = [];
  const orchestrator = {
    getDispatchStatus: () => null,
    clearDispatchStatus: () => {},
    decideExecutionMode: async () => ({ mode: "direct", tasks: [] }),
    runAgentDispatch: async () => ({ sessionId: "sid-1", reply: "voice-capable answer" }),
    sendReply: async (chatId, text) => {
      sentMessages.push({ chatId, text });
    },
    sendVoiceReply: async () => true,
    getManagerDiagnostics: async () => ({}),
    runCoordinatorDispatch: async () => {
      throw new Error("coordinator should not be called in this test");
    },
    dispatchSingleWorkerRequest: async () => null,
    ...orchestratorOverrides,
  };

  const botMessages = [];
  const service = new CommandService({
    bot: {
      sendMessage: async (chatId, text) => {
        botMessages.push({ chatId, text });
      },
    },
    store,
    orchestrator,
    defaultModel: "codex",
    reuseSessions: true,
    trimTelegram: (text) => String(text || ""),
    resolveAgent: () => "codex",
    resolveCodexModel: () => null,
    logInfo: () => {},
    logError: () => {},
  });

  return { service, state, orchestrator, botMessages, sentMessages };
}

test("/voice on persists mode toggle in chat settings", async () => {
  const { service, state, botMessages } = createService();
  const handled = await service.handleMessage("c1", "/voice on");

  assert.equal(handled, true);
  assert.equal(state.settings.voiceReplies, "1");
  assert.equal(botMessages.length, 1);
  assert.match(botMessages[0].text, /Voice replies on\./);
});

test("voice mode enabled: normal text request returns text and triggers voice reply", async () => {
  const voiceCalls = [];
  const { service, sentMessages } = createService({
    chatSettings: { voiceReplies: "1" },
    orchestratorOverrides: {
      sendVoiceReply: async (chatId, text) => {
        voiceCalls.push({ chatId, text });
        return true;
      },
    },
  });

  const handled = await service.handleMessage("c2", "hello there");
  assert.equal(handled, true);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, "voice-capable answer");
  assert.equal(voiceCalls.length, 1);
  assert.equal(voiceCalls[0].text, "voice-capable answer");
});

test("forced /voice prompt falls back to text when voice send fails", async () => {
  const voiceCalls = [];
  const { service, sentMessages } = createService({
    orchestratorOverrides: {
      sendVoiceReply: async (chatId, text) => {
        voiceCalls.push({ chatId, text });
        return false;
      },
    },
  });

  const handled = await service.handleMessage("c3", "/voice explain this");
  assert.equal(handled, true);
  assert.equal(voiceCalls.length, 1);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, "voice-capable answer");
});

test("voice intent in text triggers direct voice response path", async () => {
  const voiceCalls = [];
  const { service, sentMessages } = createService({
    orchestratorOverrides: {
      sendVoiceReply: async (chatId, text) => {
        voiceCalls.push({ chatId, text });
        return true;
      },
      decideExecutionMode: async () => {
        throw new Error("should not route through coordinator decision for voice intent");
      },
    },
  });

  const handled = await service.handleMessage("c4", "voice: tell me a short joke");
  assert.equal(handled, true);
  assert.equal(voiceCalls.length, 1);
  assert.equal(sentMessages.length, 0);
});

test("voice replies bypass reused session and pass unique request id per request", async () => {
  const runOptions = [];
  const voiceOptions = [];
  const { service } = createService({
    chatSettings: { voiceReplies: "1" },
    orchestratorOverrides: {
      runAgentDispatch: async (_agent, options) => {
        runOptions.push({ ...options });
        return { sessionId: "reused-session", reply: `fresh:${options.prompt}` };
      },
      sendVoiceReply: async (_chatId, _text, options) => {
        voiceOptions.push({ ...(options || {}) });
        return true;
      },
    },
  });

  const handledOne = await service.handleMessage("c5", "same prompt");
  const handledTwo = await service.handleMessage("c5", "same prompt");
  assert.equal(handledOne, true);
  assert.equal(handledTwo, true);
  assert.equal(runOptions.length, 2);
  assert.equal(runOptions[0].sessionId, null);
  assert.equal(runOptions[1].sessionId, null);

  assert.equal(voiceOptions.length, 2);
  assert.ok(voiceOptions[0].requestId);
  assert.ok(voiceOptions[1].requestId);
  assert.notEqual(voiceOptions[0].requestId, voiceOptions[1].requestId);
});

test("voice request including bear binds user id and enforces bear topic validation", async () => {
  const voiceCalls = [];
  const { service } = createService({
    orchestratorOverrides: {
      sendVoiceReply: async (_chatId, _text, options) => {
        voiceCalls.push({ ...(options || {}) });
        return true;
      },
    },
  });

  const handled = await service.handleMessage("c6", "/voice tell me a bear story");
  assert.equal(handled, true);
  assert.equal(voiceCalls.length, 1);
  assert.equal(voiceCalls[0].userId, "c6");
  assert.equal(voiceCalls[0].requiredTopic, "bear");
  assert.ok(String(voiceCalls[0].sourcePrompt || "").toLowerCase().includes("bear"));
});

test("end-to-end bear voice requests keep bear scope and fresh per-request payload", async () => {
  const voiceCalls = [];
  const promptsSeen = [];
  const { service } = createService({
    orchestratorOverrides: {
      runAgentDispatch: async (_agent, options) => {
        promptsSeen.push(String(options.prompt || ""));
        if (String(options.prompt || "").toLowerCase().includes("polar")) {
          return { sessionId: null, reply: "Polar bear audio response" };
        }
        return { sessionId: null, reply: "Brown bear audio response" };
      },
      sendVoiceReply: async (_chatId, text, options) => {
        voiceCalls.push({
          text: String(text || ""),
          requestId: String(options?.requestId || ""),
          requiredTopic: String(options?.requiredTopic || ""),
          sourcePrompt: String(options?.sourcePrompt || ""),
        });
        return true;
      },
    },
  });

  const handledOne = await service.handleMessage("bear-chat", "/voice tell me about brown bears");
  const handledTwo = await service.handleMessage("bear-chat", "/voice tell me about polar bears");

  assert.equal(handledOne, true);
  assert.equal(handledTwo, true);
  assert.deepEqual(promptsSeen, ["tell me about brown bears", "tell me about polar bears"]);
  assert.equal(voiceCalls.length, 2);
  assert.equal(voiceCalls[0].requiredTopic, "bear");
  assert.equal(voiceCalls[1].requiredTopic, "bear");
  assert.ok(voiceCalls[0].text.toLowerCase().includes("bear"));
  assert.ok(voiceCalls[1].text.toLowerCase().includes("bear"));
  assert.notEqual(voiceCalls[0].requestId, voiceCalls[1].requestId);
  assert.notEqual(voiceCalls[0].text, voiceCalls[1].text);
});

test("incoming voice/audio source is dispatched to worker lane", async () => {
  const workerCalls = [];
  const runCalls = [];
  const { service, botMessages } = createService({
    orchestratorOverrides: {
      runAgentDispatch: async (_agent, options) => {
        runCalls.push({ ...options });
        return { sessionId: "sid-voice", reply: "should not be used for voice source dispatch" };
      },
      dispatchSingleWorkerRequest: async (options) => {
        workerCalls.push({ ...options });
        return { status: "dispatched", workerId: 4 };
      },
    },
  });

  const handled = await service.handleMessage(
    "voice-chat",
    "Transcribed voice message from Telegram:\n\nhow to build a shed",
    {
      requestId: "req-voice-1",
      sourceType: "voice",
    }
  );

  assert.equal(handled, true);
  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].requestId, "req-voice-1");
  assert.equal(runCalls.length, 0);
  assert.equal(botMessages.length, 1);
  assert.match(botMessages[0].text, /Accepted voice task\. Assigned to worker-4\./);
});
