class CommandService {
  constructor(options) {
    this.bot = options.bot;
    this.store = options.store;
    this.orchestrator = options.orchestrator;
    this.defaultModel = options.defaultModel;
    this.reuseSessions = options.reuseSessions;
    this.trimTelegram = options.trimTelegram;
    this.resolveAgent = options.resolveAgent;
    this.resolveCodexModel = options.resolveCodexModel;
    this.logInfo = options.logInfo || (() => {});
    this.logError = options.logError || (() => {});
  }

  helpText() {
    return [
      "Commands:",
      "/help — show this help",
      "/reset — clear chat settings and chat history",
      "/agent — show current agent",
      "/agent codex|claude — set agent",
      "/agent default — reset to default agent",
      "/voice status|on|off — toggle automatic voice replies",
      "/voice <prompt> — force direct voice reply for this prompt",
      "/manager — direct manager diagnostics (no coordinator delegation)",
      "Send photo/document with optional caption — bot downloads file and passes local path to agent",
      "Send voice/audio — bot transcribes automatically via OPENAI_API_KEY or LOCAL_STT_SCRIPT",
      "",
      "Security:",
      "- Only allowlisted user IDs can use this bot.",
      "- Groups are blocked by default.",
    ].join("\n");
  }

  isTaskLikeRequest(text) {
    const t = String(text || "").trim().toLowerCase();
    if (!t) return false;
    return /\b(implement|build|create|write|fix|debug|refactor|analyze|investigate|check|review|install|configure|setup|plan|task|split|deploy|migrate|optimi[sz]e)\b/.test(
      t
    );
  }

  isVoiceModeEnabled(chatSettings) {
    const value = chatSettings?.voiceReplies;
    return value === true || value === "1" || value === 1;
  }

  extractVoiceIntentPrompt(text) {
    const input = String(text || "").trim();
    if (!input) return null;

    const patterns = [
      /^voice:\s*/i,
      /^audio:\s*/i,
      /^(please\s+)?(reply|respond)\s+in\s+(voice|audio)\s*[:,-]?\s*/i,
    ];

    for (const re of patterns) {
      if (re.test(input)) {
        const prompt = input.replace(re, "").trim();
        return prompt || "Please answer.";
      }
    }

    if (/#voice\b/i.test(input)) {
      const prompt = input.replace(/#voice\b/gi, "").trim();
      return prompt || "Please answer.";
    }

    // Natural-language voice intent without explicit slash command.
    if (/\b(voice message|voice note|audio message|send voice|as voice|in voice)\b/i.test(input)) {
      let prompt = input;
      const cleanup = [
        /\b(and\s+)?(send|reply|respond|return|convert)\s+(it|this|that|the answer|the response)?\s*(as|in)\s+(a\s*)?(voice message|voice note|voice|audio message|audio)\b/gi,
        /\b(send|reply|respond|return|convert)\s+(as|in)\s+(a\s*)?(voice message|voice note|voice|audio message|audio)\b/gi,
        /\b(i need|i want|please)\s+(a\s*)?(voice message|voice note|audio message)\s+(from you)\b/gi,
      ];
      for (const re of cleanup) {
        prompt = prompt.replace(re, " ");
      }
      prompt = prompt
        .replace(/\s+/g, " ")
        .replace(/\s+[.,;:!?]+$/g, "")
        .replace(/\b(and|then)\s*$/i, "")
        .trim();
      return prompt || "Please answer.";
    }

    return null;
  }

  async runDirectAndReply({
    chatId,
    agent,
    codexModel,
    prompt,
    voiceReply = false,
    sendTextReply = true,
    requestId = null,
  }) {
    const voiceRequestId = `voice-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const shouldReuseSession = this.reuseSessions && !voiceReply;
    const sessionId = shouldReuseSession ? await this.store.getSession(chatId, agent) : null;
    const { sessionId: newSessionId, reply } = await this.orchestrator.runAgentDispatch(agent, {
      chatId,
      sessionId,
      prompt,
      model: codexModel,
      requestId,
    });

    if (shouldReuseSession && newSessionId && newSessionId !== sessionId) {
      await this.store.setSession(chatId, agent, newSessionId);
    }

    const output = this.trimTelegram(reply);
    if (sendTextReply) {
      await this.orchestrator.sendReply(chatId, output, { requestId });
    }

    if (voiceReply) {
      const normalizedPrompt = String(prompt || "").toLowerCase();
      const requiredTopic = normalizedPrompt.includes("bear") ? "bear" : null;
      const sent = await this.orchestrator.sendVoiceReply(chatId, output, {
        requestId: voiceRequestId,
        userId: String(chatId),
        requiredTopic,
        sourcePrompt: String(prompt || ""),
        correlationId: requestId || null,
      });
      if (!sent && !sendTextReply) {
        await this.orchestrator.sendReply(chatId, output, { requestId });
      }
    }
  }

  async launchDirectAnswer({ chatId, agent, codexModel, text, requestId = null }) {
    this.orchestrator
      .runAgent(agent, {
        sessionId: null,
        prompt: text,
        model: codexModel,
        requestId,
      })
      .then(async ({ reply }) => {
        await this.orchestrator.sendReply(chatId, this.trimTelegram(reply), { requestId });
      })
      .catch(async (e) => {
        this.logError(`direct_answer_failed chat=${chatId} agent=${agent}`, e?.stack || e?.message || String(e));
        await this.bot.sendMessage(chatId, `Answer error: ${(e?.message || String(e)).slice(0, 3900)}`);
      });
  }

  async handleMessage(chatId, text, context = {}) {
    const requestId = String(context.requestId || `req-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
    const sourceType = String(context.sourceType || "text").toLowerCase();
    const fromVoiceOrAudio = sourceType === "voice" || sourceType === "audio";
    if (text === "/help") {
      await this.bot.sendMessage(chatId, this.helpText());
      return true;
    }

    const chatSettings = await this.store.getChatSettings(chatId);
    const selection = chatSettings?.model || this.defaultModel;
    const agent = this.resolveAgent(selection);
    const codexModel = this.resolveCodexModel(selection);
    const voiceModeEnabled = this.isVoiceModeEnabled(chatSettings);

    if (text === "/reset") {
      await this.store.clearChat(chatId);
      await this.bot.sendMessage(chatId, "Reset done.");
      return true;
    }

    if (text === "/agent") {
      await this.bot.sendMessage(chatId, `Current agent: ${agent}`);
      return true;
    }

    if (text === "/model" || text.startsWith("/model ")) {
      await this.bot.sendMessage(chatId, "Use /agent, for example: /agent codex");
      return true;
    }

    if (text === "/voice" || text.startsWith("/voice ")) {
      const arg = text.replace(/^\/voice\s*/i, "").trim();
      if (!arg) {
        await this.bot.sendMessage(chatId, "Usage: /voice status|on|off OR /voice <prompt>");
        return true;
      }

      if (arg === "status") {
        await this.bot.sendMessage(chatId, `Voice replies: ${voiceModeEnabled ? "on" : "off"}`);
        return true;
      }

      if (arg === "on" || arg === "off") {
        const updated = { ...(chatSettings || {}) };
        if (arg === "on") {
          updated.voiceReplies = "1";
        } else {
          delete updated.voiceReplies;
        }
        await this.store.setChatSettings(chatId, updated);
        await this.bot.sendMessage(chatId, `Voice replies ${arg}.`);
        return true;
      }

      await this.runDirectAndReply({
        chatId,
        agent,
        codexModel,
        prompt: arg,
        voiceReply: true,
        sendTextReply: false,
        requestId,
      });
      return true;
    }

    if (text === "/manager" || text.startsWith("/manager ")) {
      const managerInput = text.replace(/^\/manager\s*/i, "").trim();
      const diagnostics = await this.orchestrator.getManagerDiagnostics(chatId, { scope: "global" });
      const managerPrompt = [
        "You are manager worker-1 running in independent mode.",
        "You must answer based on the live diagnostics payload below.",
        "If data is unavailable in diagnostics, say it clearly and do not invent values.",
        "Keep response concise and operational.",
        "",
        `User request: ${
          managerInput || "Provide a concise status update for all workers, locks, queue health, and failures."
        }`,
        `request_id: ${requestId}`,
        "",
        "Diagnostics JSON:",
        JSON.stringify(diagnostics, null, 2),
      ].join("\n");

      const managerSession =
        this.reuseSessions && typeof this.store.getManagerSession === "function"
          ? await this.store.getManagerSession(chatId, agent)
          : null;
      const { sessionId: nextManagerSession, reply } = await this.orchestrator.runAgentDispatch(agent, {
        chatId,
        sessionId: managerSession || null,
        prompt: managerPrompt,
        model: codexModel,
        requestId,
      });

      if (
        this.reuseSessions &&
        nextManagerSession &&
        nextManagerSession !== managerSession &&
        typeof this.store.setManagerSession === "function"
      ) {
        await this.store.setManagerSession(chatId, agent, nextManagerSession);
      }

      await this.orchestrator.sendReply(chatId, this.trimTelegram(reply), { requestId });
      return true;
    }

    if (text.startsWith("/agent ")) {
      const requested = text.replace(/^\/agent\s+/i, "").trim().toLowerCase();
      if (!requested) {
        await this.bot.sendMessage(chatId, "Usage: /agent codex|claude");
        return true;
      }

      if (requested === "default") {
        const updated = { ...(chatSettings || {}) };
        delete updated.model;
        await this.store.setChatSettings(chatId, updated);
        await this.bot.sendMessage(chatId, `Agent reset to default: ${this.defaultModel || "codex"}`);
        return true;
      }

      if (requested !== "codex" && requested !== "claude") {
        await this.bot.sendMessage(chatId, "Use: /agent codex or /agent claude");
        return true;
      }

      const updated = { ...(chatSettings || {}), model: requested };
      await this.store.setChatSettings(chatId, updated);
      await this.bot.sendMessage(chatId, `Agent set to: ${requested}`);
      return true;
    }

    if (fromVoiceOrAudio && typeof this.orchestrator.dispatchSingleWorkerRequest === "function") {
      const result = await this.orchestrator.dispatchSingleWorkerRequest({
        chatId,
        agent,
        codexModel,
        goal: text,
        requestId,
      });
      if (result?.status === "dispatched") {
        await this.bot.sendMessage(chatId, `Accepted voice task. Assigned to worker-${result.workerId}.`);
      } else if (result?.status === "queued") {
        const position = Number(result.position);
        const suffix = Number.isFinite(position) && position > 0 ? ` Queue position: ${position}.` : "";
        await this.bot.sendMessage(chatId, `All workers are busy. I queued your voice task.${suffix}`);
      } else {
        await this.bot.sendMessage(chatId, "Could not schedule voice task right now.");
      }
      return true;
    }

    const voiceIntentPrompt = this.extractVoiceIntentPrompt(text);
    if (voiceIntentPrompt) {
      await this.runDirectAndReply({
        chatId,
        agent,
        codexModel,
        prompt: voiceIntentPrompt,
        voiceReply: true,
        sendTextReply: false,
        requestId,
      });
      return true;
    }

    const isTaskLike = this.isTaskLikeRequest(text);
    if (isTaskLike && typeof this.orchestrator.dispatchSingleWorkerRequest === "function") {
      const result = await this.orchestrator.dispatchSingleWorkerRequest({
        chatId,
        agent,
        codexModel,
        goal: text,
        requestId,
      });
      if (result?.status === "dispatched") {
        await this.bot.sendMessage(chatId, `Accepted. Assigned to worker-${result.workerId}.`);
      } else if (result?.status === "queued") {
        const position = Number(result.position);
        const suffix = Number.isFinite(position) && position > 0 ? ` Queue position: ${position}.` : "";
        await this.bot.sendMessage(chatId, `All workers are busy. I queued your task.${suffix}`);
      } else {
        await this.bot.sendMessage(chatId, "Could not schedule task right now.");
      }
      return true;
    }

    await this.runDirectAndReply({
      chatId,
      agent,
      codexModel,
      prompt: text,
      voiceReply: voiceModeEnabled,
      sendTextReply: true,
      requestId,
    });
    return true;
  }
}

module.exports = {
  CommandService,
};
