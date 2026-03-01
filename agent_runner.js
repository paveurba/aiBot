const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

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

function runCodex({ sessionId, prompt, model, config }) {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(
      os.tmpdir(),
      `codex-last-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
    );
    const args = ["exec"];
    if (config.CODEX_BYPASS_SANDBOX) args.push("--dangerously-bypass-approvals-and-sandbox");
    if (config.REUSE_SESSIONS && sessionId) args.push("resume", sessionId);
    args.push("--skip-git-repo-check", "--json", "--output-last-message", outputPath);
    if (model) args.push("-m", model);
    args.push(prompt);

    const p = spawn(config.CODEX_BIN, args, {
      cwd: config.WORKDIR,
      env: spawnEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const killTimer = setTimeout(() => {
      try {
        p.kill("SIGTERM");
      } catch {}
    }, config.REQUEST_TIMEOUT_MS);

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
          // ignore JSON parsing errors from non-JSON lines
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
      let fileText = "";
      try {
        fileText = fs.readFileSync(outputPath, "utf8").trim();
      } catch {
        // ignore output read errors
      } finally {
        fs.rmSync(outputPath, { force: true });
      }

      if (code === 0) {
        const reply = fileText || normalizeErrorMessage(stderr) || "(no text output)";
        return resolve({ sessionId: foundSessionId, reply });
      }

      reject(new Error(normalizeErrorMessage(stderr) || `codex exited with code ${code}`));
    });
  });
}

function runClaude({ sessionId, prompt, config }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "bypassPermissions",
    ];
    if (config.REUSE_SESSIONS && sessionId) args.push("--resume", sessionId);
    args.push(prompt);

    const p = spawn(config.CLAUDE_BIN, args, {
      cwd: config.WORKDIR,
      env: spawnEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const softKillTimer = setTimeout(() => {
      try {
        p.kill("SIGTERM");
      } catch {}
    }, config.REQUEST_TIMEOUT_MS);

    const hardKillTimer = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {}
    }, config.REQUEST_TIMEOUT_MS + 5000);

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

async function runAgent(agent, options) {
  const resolved = String(agent || "").trim().toLowerCase() === "claude" ? "claude" : "codex";
  if (resolved === "claude") return runClaude(options);
  return runCodex(options);
}

module.exports = {
  runAgent,
};
