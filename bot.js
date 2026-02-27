require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const { spawn } = require("child_process");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN in environment (.env).");
  process.exit(1);
}

const WORKDIR = process.env.BOT_WORKDIR || process.cwd();
const SETTINGS_PATH = path.join(__dirname, "settings.json");
const SESSIONS_PATH = path.join(__dirname, "sessions.json");

const CODEX_BIN = (process.env.CODEX_BIN || "codex").trim();
const CLAUDE_BIN = (process.env.CLAUDE_BIN || "claude").trim();

const DEFAULT_MODEL = (process.env.DEFAULT_MODEL || "").trim() || null;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 180000);
const SEEN_TTL_MS = Number(process.env.SEEN_TTL_MS || 10 * 60 * 1000);
const REUSE_SESSIONS = String(process.env.REUSE_SESSIONS || "1") === "1";

const MULTI_AGENT_MODE = String(process.env.MULTI_AGENT_MODE || "0") === "1";
const WORKER_AGENTS = (process.env.WORKER_AGENTS || "codex,claude")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s === "codex" || s === "claude");
const MAX_WORKER_TASKS = Math.max(1, Number(process.env.MAX_WORKER_TASKS || 10));
const MIN_WORKER_TASKS = Math.max(
  1,
  Math.min(MAX_WORKER_TASKS, Number(process.env.MIN_WORKER_TASKS || 2))
);

const ALLOWLIST = (process.env.TELEGRAM_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ALLOW_GROUPS = String(process.env.ALLOW_GROUPS || "0") === "1";

const bot = new TelegramBot(token, { polling: true });
const seenMessages = new Map();
const workerLoad = new Map();
const chatQueue = new Map();

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function loadSettings() {
  return loadJson(SETTINGS_PATH, {});
}

function saveSettings(settings) {
  saveJson(SETTINGS_PATH, settings);
}

function loadSessions() {
  return loadJson(SESSIONS_PATH, {});
}

function saveSessions(sessions) {
  saveJson(SESSIONS_PATH, sessions);
}

function isAllowedUser(msg) {
  if (ALLOWLIST.length === 0) return true;
  return ALLOWLIST.includes(String(msg.from?.id || ""));
}

function isAllowedChat(msg) {
  return ALLOW_GROUPS || msg.chat?.type === "private";
}

function resolveAgent(selection) {
  return String(selection || "").trim().toLowerCase() === "claude" ? "claude" : "codex";
}

function resolveCodexModel(selection) {
  const normalized = String(selection || "").trim().toLowerCase();
  if (!normalized || normalized === "codex" || normalized === "claude") return null;
  return selection;
}

function normalizeErrorMessage(message) {
  const raw = String(message || "").trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.detail === "string") return parsed.detail;
  } catch {
    // keep raw
  }
  return raw;
}

function spawnEnv() {
  const mergedPath =
    (process.env.BOT_PATH || "").trim() ||
    process.env.PATH ||
    "/usr/bin:/bin:/usr/sbin:/sbin";
  return { ...process.env, PATH: mergedPath };
}

function isDuplicateMessage(msg) {
  const chatId = String(msg.chat?.id || "");
  const messageId = String(msg.message_id || "");
  if (!chatId || !messageId) return false;

  const key = `${chatId}:${messageId}`;
  const now = Date.now();
  for (const [k, ts] of seenMessages) {
    if (now - ts > SEEN_TTL_MS) seenMessages.delete(k);
  }
  if (seenMessages.has(key)) return true;
  seenMessages.set(key, now);
  return false;
}

function enqueueChatJob(chatId, jobFn) {
  const previous = chatQueue.get(chatId) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => jobFn());
  chatQueue.set(chatId, current);
  current.finally(() => {
    if (chatQueue.get(chatId) === current) chatQueue.delete(chatId);
  });
  return current;
}

function getSessionForAgent(sessions, chatId, agent) {
  const raw = sessions[chatId];
  if (!raw) return null;
  if (typeof raw === "string") return agent === "codex" ? raw : null;
  if (typeof raw === "object") return raw[agent] || null;
  return null;
}

function setSessionForAgent(sessions, chatId, agent, sessionId) {
  if (!sessionId) return;
  const current = sessions[chatId];
  if (typeof current === "string") {
    sessions[chatId] = { codex: current };
  } else if (!current || typeof current !== "object") {
    sessions[chatId] = {};
  }
  sessions[chatId][agent] = sessionId;
}

function getWorkerSessionForAgent(sessions, chatId, agent, workerId) {
  const raw = sessions[chatId];
  if (!raw || typeof raw !== "object") return null;
  const workersByAgent = raw.workers?.[agent];
  if (!workersByAgent || typeof workersByAgent !== "object") return null;
  return workersByAgent[String(workerId)] || null;
}

function setWorkerSessionForAgent(sessions, chatId, agent, workerId, sessionId) {
  if (!sessionId) return;
  const current = sessions[chatId];
  if (typeof current === "string") {
    sessions[chatId] = { codex: current };
  } else if (!current || typeof current !== "object") {
    sessions[chatId] = {};
  }
  if (!sessions[chatId].workers || typeof sessions[chatId].workers !== "object") {
    sessions[chatId].workers = {};
  }
  if (!sessions[chatId].workers[agent] || typeof sessions[chatId].workers[agent] !== "object") {
    sessions[chatId].workers[agent] = {};
  }
  sessions[chatId].workers[agent][String(workerId)] = sessionId;
}

function workerLoadKey(chatId, agent, workerId) {
  return `${chatId}:${agent}:${workerId}`;
}

function getWorkerLoad(chatId, agent, workerId) {
  return workerLoad.get(workerLoadKey(chatId, agent, workerId)) || 0;
}

function incWorkerLoad(chatId, agent, workerId) {
  const key = workerLoadKey(chatId, agent, workerId);
  workerLoad.set(key, getWorkerLoad(chatId, agent, workerId) + 1);
}

function decWorkerLoad(chatId, agent, workerId) {
  const key = workerLoadKey(chatId, agent, workerId);
  const next = getWorkerLoad(chatId, agent, workerId) - 1;
  if (next > 0) workerLoad.set(key, next);
  else workerLoad.delete(key);
}

function selectWorkersForTasks(chatId, agent, taskCount) {
  const count = Math.max(1, Math.min(MAX_WORKER_TASKS, Number(taskCount) || 1));
  const ranked = Array.from({ length: MAX_WORKER_TASKS }, (_, i) => i + 1).map((id) => ({
    id,
    load: getWorkerLoad(chatId, agent, id),
  }));
  ranked.sort((a, b) => a.load - b.load || a.id - b.id);
  return ranked.slice(0, count).map((x) => x.id);
}

function trimTelegram(text) {
  const t = String(text || "");
  return t.length > 4000 ? t.slice(0, 4000) + "\n…(truncated)" : t;
}

function sanitizeFileName(name, fallback = "file") {
  const base = String(name || "").trim() || fallback;
  return base.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function downloadToFile(url, destinationPath) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Download failed with status ${response.statusCode}`));
      }

      const stream = fs.createWriteStream(destinationPath);
      response.pipe(stream);
      stream.on("finish", () => stream.close(resolve));
      stream.on("error", (err) => reject(err));
    });

    request.on("error", (err) => reject(err));
  });
}

async function buildPromptFromMessage(botInstance, msg) {
  const text = msg.text?.trim();
  if (text) return text;

  const caption = String(msg.caption || "").trim();
  const uploadDir = path.join(os.tmpdir(), "ai-bot-uploads");
  fs.mkdirSync(uploadDir, { recursive: true });

  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1];
    const fileId = photo.file_id;
    const file = await botInstance.getFile(fileId);
    const ext = path.extname(file.file_path || "") || ".jpg";
    const fileName = `${Date.now()}-${msg.message_id || "m"}-photo${ext}`;
    const localPath = path.join(uploadDir, sanitizeFileName(fileName, "photo.jpg"));
    const fileLink = await botInstance.getFileLink(fileId);
    await downloadToFile(fileLink, localPath);

    return [
      caption || "Analyze the attached image.",
      "",
      "Attached file from Telegram:",
      `- type: photo`,
      `- local_path: ${localPath}`,
      "",
      "Use this local file in your response.",
    ].join("\n");
  }

  if (msg.document?.file_id) {
    const fileId = msg.document.file_id;
    const file = await botInstance.getFile(fileId);
    const fromName = sanitizeFileName(msg.document.file_name || "", "");
    const extFromPath = path.extname(file.file_path || "");
    const ext = path.extname(fromName) || extFromPath || ".bin";
    const base = fromName ? path.basename(fromName, path.extname(fromName)) : "document";
    const fileName = `${Date.now()}-${msg.message_id || "m"}-${base}${ext}`;
    const localPath = path.join(uploadDir, sanitizeFileName(fileName, "document.bin"));
    const fileLink = await botInstance.getFileLink(fileId);
    await downloadToFile(fileLink, localPath);

    return [
      caption || "Analyze the attached document.",
      "",
      "Attached file from Telegram:",
      `- type: document`,
      `- name: ${msg.document.file_name || path.basename(localPath)}`,
      `- mime_type: ${msg.document.mime_type || "unknown"}`,
      `- local_path: ${localPath}`,
      "",
      "Use this local file in your response.",
    ].join("\n");
  }

  return "";
}

function parseJsonBlock(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // try fenced block
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      return null;
    }
  }
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(raw.slice(first, last + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function shouldUseMultipleWorkers(userTask) {
  const t = String(userTask || "").trim();
  if (!t) return false;
  return t.length >= 60 || /\\band\\b|,|;|\\n/i.test(t);
}

function estimateRequestedWorkerCount(userTask) {
  const t = String(userTask || "").trim();
  if (!t) return 1;

  const numbered = t
    .split(/\r?\n/)
    .filter((line) => /^\s*(\d+[\).\:-]|[-*])\s+/.test(line))
    .length;
  const byQuestionMark = t.split("?").filter((s) => s.trim()).length;
  const byNewline = t.split(/\r?\n+/).filter((s) => s.trim()).length;

  const explicit = Math.max(numbered, byQuestionMark > 1 ? byQuestionMark : 0, byNewline > 1 ? byNewline : 0, 1);
  const floor = shouldUseMultipleWorkers(t) ? MIN_WORKER_TASKS : 1;
  return Math.max(floor, Math.min(MAX_WORKER_TASKS, explicit));
}

function buildFallbackTasks(agent, userTask) {
  const taskTemplates = [
    ["Primary solution", "Solve the request directly and concisely."],
    ["Alternative solution", "Provide an alternative implementation approach."],
    ["Risks and edge cases", "Analyze risks, edge cases, and likely failure modes."],
    ["Testing strategy", "Design practical tests for the request."],
    ["Performance", "Optimize for speed and resource efficiency."],
    ["Reliability", "Focus on retries, timeouts, and fault tolerance."],
    ["Security review", "Identify security concerns and concrete mitigations."],
    ["DX improvements", "Improve usability, logs, and developer workflow."],
    ["Validation checklist", "Produce a concise acceptance checklist."],
    ["Rollback plan", "Describe safe rollback and recovery steps."],
  ];
  return taskTemplates.slice(0, MAX_WORKER_TASKS).map(([title, instruction]) => ({
    title,
    agent,
    prompt: `${instruction}\n\nRequest:\n${userTask}`,
  }));
}

function ensureMinimumWorkerTasks(tasks, agent, userTask, targetCount) {
  const normalized = Array.isArray(tasks) ? tasks.slice(0, MAX_WORKER_TASKS) : [];
  const requiredCount = Math.max(1, Math.min(MAX_WORKER_TASKS, Number(targetCount) || 1));
  if (normalized.length >= requiredCount) return normalized;

  const fallback = buildFallbackTasks(agent, userTask);
  const used = new Set(normalized.map((t) => `${t.title || ""}|${t.prompt || ""}`));

  for (const task of fallback) {
    if (normalized.length >= requiredCount || normalized.length >= MAX_WORKER_TASKS) break;
    const key = `${task.title || ""}|${task.prompt || ""}`;
    if (used.has(key)) continue;
    normalized.push(task);
    used.add(key);
  }

  return normalized.slice(0, MAX_WORKER_TASKS);
}

function runCodex({ sessionId, prompt, model }) {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(os.tmpdir(), `codex-last-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    const args = ["exec"];
    if (REUSE_SESSIONS && sessionId) args.push("resume", sessionId);
    args.push("--skip-git-repo-check", "--json", "--output-last-message", outputPath);
    if (model) args.push("-m", model);
    args.push(prompt);

    const p = spawn(CODEX_BIN, args, {
      cwd: WORKDIR,
      env: spawnEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const killTimer = setTimeout(() => {
      try {
        p.kill("SIGTERM");
      } catch {}
    }, REQUEST_TIMEOUT_MS);

    let stdoutBuf = "";
    let stderr = "";
    let foundSessionId = sessionId || null;

    p.stdout.on("data", (d) => {
      stdoutBuf += d.toString("utf8");
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          const maybeSessionId = evt.session_id || evt.sessionId || evt.thread_id || evt.threadId;
          if (!foundSessionId && maybeSessionId) foundSessionId = maybeSessionId;
        } catch {
          // ignore
        }
      }
    });

    p.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });

    p.on("error", (err) => {
      clearTimeout(killTimer);
      reject(err);
    });

    p.on("close", (code) => {
      clearTimeout(killTimer);
      try {
        if (code === 0) {
          const fileText = fs.readFileSync(outputPath, "utf8").trim();
          return resolve({ sessionId: foundSessionId, reply: fileText || "(no text output)" });
        }
      } catch {
        // ignore
      } finally {
        fs.rmSync(outputPath, { force: true });
      }

      reject(new Error(normalizeErrorMessage(stderr) || `codex exited with code ${code}`));
    });
  });
}

function runClaude({ sessionId, prompt }) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--verbose", "--output-format", "stream-json", "--permission-mode", "bypassPermissions"];
    if (REUSE_SESSIONS && sessionId) args.push("--resume", sessionId);
    args.push(prompt);

    const p = spawn(CLAUDE_BIN, args, {
      cwd: WORKDIR,
      env: spawnEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const softKillTimer = setTimeout(() => {
      try {
        p.kill("SIGTERM");
      } catch {}
    }, REQUEST_TIMEOUT_MS);

    const hardKillTimer = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {}
    }, REQUEST_TIMEOUT_MS + 5000);

    let stdoutBuf = "";
    let stderr = "";
    let foundSessionId = sessionId || null;
    let streamError = "";
    let finalResultText = "";
    const assistantText = [];

    p.stdout.on("data", (d) => {
      stdoutBuf += d.toString("utf8");
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;

        try {
          const evt = JSON.parse(line);
          if (!foundSessionId && evt.session_id) foundSessionId = evt.session_id;
          if (evt.error) streamError = normalizeErrorMessage(evt.error);
          if (evt.type === "result" && evt.is_error) {
            streamError = normalizeErrorMessage(evt.result || evt.subtype || "Claude request failed");
          }
          if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
            const text = evt.message.content
              .filter((c) => c && c.type === "text" && typeof c.text === "string")
              .map((c) => c.text)
              .join("")
              .trim();
            if (text) assistantText.push(text);
          }
          if (evt.type === "result" && typeof evt.result === "string" && evt.result.trim()) {
            finalResultText = evt.result.trim();
          }
        } catch {
          // ignore
        }
      }
    });

    p.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });

    p.on("error", (err) => {
      clearTimeout(softKillTimer);
      clearTimeout(hardKillTimer);
      reject(err);
    });

    p.on("close", (code) => {
      clearTimeout(softKillTimer);
      clearTimeout(hardKillTimer);

      if (code !== 0) {
        return reject(new Error(streamError || normalizeErrorMessage(stderr) || `claude exited with code ${code}`));
      }

      const reply = (finalResultText || assistantText.join("\n\n").trim() || "(no text output)").trim();
      resolve({ sessionId: foundSessionId, reply });
    });
  });
}

function runAgent(agent, options) {
  return agent === "claude" ? runClaude(options) : runCodex(options);
}

async function createWorkerPlan({ coordinatorAgent, coordinatorSessionId, userTask }) {
  const targetWorkers = estimateRequestedWorkerCount(userTask);
  const pool = coordinatorAgent;
  const prompt = [
    "You are a coordinator.",
    `Break task into exactly ${targetWorkers} worker tasks.`,
    `Allowed agents: ${pool}.`,
    "Return ONLY strict JSON:",
    `{"tasks":[{"title":"...","agent":"${coordinatorAgent}","prompt":"..."}]}`,
    "User task:",
    userTask,
  ].join("\n");

  const { sessionId, reply } = await runAgent(coordinatorAgent, {
    sessionId: coordinatorSessionId,
    prompt,
    model: resolveCodexModel(coordinatorAgent),
  });

  const parsed = parseJsonBlock(reply);
  if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    return {
      sessionId,
      tasks: ensureMinimumWorkerTasks(
        [{ title: "Main task", agent: coordinatorAgent, prompt: userTask }],
        coordinatorAgent,
        userTask,
        targetWorkers
      ),
    };
  }

  const tasks = parsed.tasks
    .slice(0, MAX_WORKER_TASKS)
    .map((t, i) => ({
      title: String(t.title || `Task ${i + 1}`).slice(0, 80),
      agent: coordinatorAgent,
      prompt: String(t.prompt || "").trim(),
    }))
    .filter((t) => t.prompt);

  if (!tasks.length) {
    return {
      sessionId,
      tasks: ensureMinimumWorkerTasks(
        [{ title: "Main task", agent: coordinatorAgent, prompt: userTask }],
        coordinatorAgent,
        userTask,
        targetWorkers
      ),
    };
  }

  return { sessionId, tasks: ensureMinimumWorkerTasks(tasks, coordinatorAgent, userTask, targetWorkers) };
}

async function processMultiAgentJob({ chatId, text, coordinatorAgent, coordinatorModel, sessions }) {
  const requestedWorkers = estimateRequestedWorkerCount(text);

  if (requestedWorkers <= 1) {
    const workerId = 1;
    const workerSessionId = REUSE_SESSIONS
      ? getWorkerSessionForAgent(sessions, chatId, coordinatorAgent, workerId)
      : null;

    incWorkerLoad(chatId, coordinatorAgent, workerId);
    try {
      const { sessionId: newWorkerSessionId, reply } = await runAgent(coordinatorAgent, {
        sessionId: workerSessionId,
        prompt: text,
        model: coordinatorModel,
      });
      if (REUSE_SESSIONS && newWorkerSessionId && newWorkerSessionId !== workerSessionId) {
        setWorkerSessionForAgent(sessions, chatId, coordinatorAgent, workerId, newWorkerSessionId);
        saveSessions(sessions);
      }
      await bot.sendMessage(chatId, trimTelegram(`worker-${workerId} [${coordinatorAgent}]\n${reply || "(no text output)"}`));
    } finally {
      decWorkerLoad(chatId, coordinatorAgent, workerId);
    }
    return;
  }

  let coordinatorSessionId = REUSE_SESSIONS ? getSessionForAgent(sessions, chatId, coordinatorAgent) : null;

  const plan = await createWorkerPlan({
    coordinatorAgent,
    coordinatorSessionId,
    userTask: text,
  });

  coordinatorSessionId = plan.sessionId || coordinatorSessionId;
  if (REUSE_SESSIONS && coordinatorSessionId) {
    setSessionForAgent(sessions, chatId, coordinatorAgent, coordinatorSessionId);
    saveSessions(sessions);
  }

  const assignedWorkerIds = selectWorkersForTasks(chatId, coordinatorAgent, plan.tasks.length);
  for (const id of assignedWorkerIds) incWorkerLoad(chatId, coordinatorAgent, id);

  const results = await Promise.all(
    plan.tasks.map(async (task, i) => {
      const workerId = assignedWorkerIds[i] || 1;
      try {
        const workerSessionId = REUSE_SESSIONS
          ? getWorkerSessionForAgent(sessions, chatId, task.agent, workerId)
          : null;
        const { sessionId: newWorkerSessionId, reply } = await runAgent(task.agent, {
          sessionId: workerSessionId,
          prompt: task.prompt,
          model: task.agent === "codex" ? coordinatorModel : null,
        });
        if (REUSE_SESSIONS && newWorkerSessionId && newWorkerSessionId !== workerSessionId) {
          setWorkerSessionForAgent(sessions, chatId, task.agent, workerId, newWorkerSessionId);
          saveSessions(sessions);
        }
        return { index: workerId, agent: task.agent, title: task.title, reply };
      } catch (e) {
        return {
          index: workerId,
          agent: task.agent,
          title: task.title,
          reply: `Worker failed: ${e.message || String(e)}`,
        };
      } finally {
        decWorkerLoad(chatId, coordinatorAgent, workerId);
      }
    })
  );

  const ordered = results.slice().sort((a, b) => a.index - b.index);
  for (const result of ordered) {
    const title = String(result.title || "task").slice(0, 80);
    const body = [
      `worker-${result.index} [${result.agent}] ${title}`,
      result.reply || "(no text output)",
    ].join("\n");
    await bot.sendMessage(chatId, trimTelegram(body));
  }
}

function helpText() {
  return [
    "Commands:",
    "/help — show this help",
    "/reset — clear chat settings and chat history",
    "/agent — show current agent",
    "/agent codex|claude — set agent",
    "/agent default — reset to default agent",
    `/worker <1-${MAX_WORKER_TASKS}> <message> — send task to a specific worker`,
    "/worker list — show worker IDs",
    "Send photo/document with optional caption — bot downloads file and passes local path to agent",
    "",
    MULTI_AGENT_MODE
      ? "Default mode: coordinator + background workers."
      : "Default mode: single agent final response.",
    "",
    "Security:",
    "- Only allowlisted user IDs can use this bot.",
    "- Groups are blocked by default.",
  ].join("\n");
}

bot.on("message", async (msg) => {
  const chatId = String(msg.chat?.id || "");
  if (!chatId) return;
  if (isDuplicateMessage(msg)) return;

  if (!isAllowedChat(msg)) return;
  if (!isAllowedUser(msg)) return bot.sendMessage(chatId, "Not allowed.");

  let text = "";
  try {
    text = await buildPromptFromMessage(bot, msg);
  } catch (e) {
    return bot.sendMessage(chatId, trimTelegram(`Failed to process attachment: ${e.message || String(e)}`));
  }
  if (!text) return;

  if (text === "/help") return bot.sendMessage(chatId, helpText());

  enqueueChatJob(chatId, async () => {
    const settings = loadSettings();
    const sessions = loadSessions();
    const selection = settings[chatId]?.model || DEFAULT_MODEL;
    const agent = resolveAgent(selection);
    const codexModel = resolveCodexModel(selection);

    if (text === "/reset") {
      if (settings[chatId]) {
        delete settings[chatId];
        saveSettings(settings);
      }
      if (sessions[chatId]) {
        delete sessions[chatId];
        saveSessions(sessions);
      }
      return bot.sendMessage(chatId, "Reset done.");
    }

    if (text === "/agent" || text === "/model") {
      return bot.sendMessage(chatId, `Current agent: ${agent}`);
    }

    if (text === "/worker list") {
      return bot.sendMessage(
        chatId,
        `Workers: ${Array.from({ length: MAX_WORKER_TASKS }, (_, i) => i + 1).join(", ")}`
      );
    }

    if (text.startsWith("/worker ")) {
      const match = text.match(/^\/worker\s+(\d+)\s+([\s\S]+)$/i);
      if (!match) {
        return bot.sendMessage(chatId, `Usage: /worker <1-${MAX_WORKER_TASKS}> <message>`);
      }

      const workerId = Number(match[1]);
      const workerPrompt = String(match[2] || "").trim();
      if (!Number.isInteger(workerId) || workerId < 1 || workerId > MAX_WORKER_TASKS) {
        return bot.sendMessage(chatId, `Worker must be between 1 and ${MAX_WORKER_TASKS}.`);
      }
      if (!workerPrompt) {
        return bot.sendMessage(chatId, `Usage: /worker <1-${MAX_WORKER_TASKS}> <message>`);
      }

      try {
        const workerSessionId = REUSE_SESSIONS
          ? getWorkerSessionForAgent(sessions, chatId, agent, workerId)
          : null;
        const { sessionId: newWorkerSessionId, reply } = await runAgent(agent, {
          sessionId: workerSessionId,
          prompt: workerPrompt,
          model: codexModel,
        });
        if (REUSE_SESSIONS && newWorkerSessionId && newWorkerSessionId !== workerSessionId) {
          setWorkerSessionForAgent(sessions, chatId, agent, workerId, newWorkerSessionId);
          saveSessions(sessions);
        }
        return bot.sendMessage(chatId, trimTelegram(`worker-${workerId} [${agent}]\n${reply}`));
      } catch (e) {
        return bot.sendMessage(chatId, trimTelegram(`worker-${workerId} [${agent}] failed: ${e.message || String(e)}`));
      }
    }

    if (text.startsWith("/agent ") || text.startsWith("/model ")) {
      const requested = text.replace(/^\/(agent|model)\s+/i, "").trim().toLowerCase();
      if (!requested) return bot.sendMessage(chatId, "Usage: /agent codex|claude");

      if (requested === "default") {
        if (settings[chatId]?.model) {
          delete settings[chatId].model;
          if (Object.keys(settings[chatId]).length === 0) delete settings[chatId];
          saveSettings(settings);
        }
        return bot.sendMessage(chatId, `Agent reset to default: ${DEFAULT_MODEL || "codex"}`);
      }

      if (requested !== "codex" && requested !== "claude") {
        return bot.sendMessage(chatId, "Use: /agent codex or /agent claude");
      }

      settings[chatId] = { ...(settings[chatId] || {}), model: requested };
      saveSettings(settings);
      return bot.sendMessage(chatId, `Agent set to: ${requested}`);
    }

    if (MULTI_AGENT_MODE) {
      await processMultiAgentJob({
        chatId,
        text,
        coordinatorAgent: agent,
        coordinatorModel: codexModel,
        sessions,
      });
      return;
    }

    const sessionId = REUSE_SESSIONS ? getSessionForAgent(sessions, chatId, agent) : null;
    const { sessionId: newSessionId, reply } = await runAgent(agent, {
      sessionId,
      prompt: text,
      model: codexModel,
    });

    if (REUSE_SESSIONS && newSessionId && newSessionId !== sessionId) {
      setSessionForAgent(sessions, chatId, agent, newSessionId);
      saveSessions(sessions);
    }

    await bot.sendMessage(chatId, trimTelegram(reply));
  }).catch(async (e) => {
    const out = `Error: ${e.message || String(e)}`.slice(0, 4000);
    await bot.sendMessage(chatId, out);
  });
});

console.log("Telegram bot running.");
console.log("BOT_WORKDIR:", WORKDIR);
console.log("Default model:", DEFAULT_MODEL || "(none)");
console.log("Reuse sessions:", REUSE_SESSIONS);
console.log("Multi-agent mode:", MULTI_AGENT_MODE);
console.log("Worker agents:", WORKER_AGENTS.join(", ") || "(none)");
console.log("Groups allowed:", ALLOW_GROUPS);
console.log("Allowlist:", ALLOWLIST.length ? ALLOWLIST.join(", ") : "(empty -> allows all)");
