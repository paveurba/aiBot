const { spawn } = require("child_process");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");

class AttachmentService {
  constructor(options) {
    this.bot = options.bot;
    this.orchestrator = options.orchestrator;
    this.workdir = options.workdir;
    this.requestTimeoutMs = Number(options.requestTimeoutMs || 180000);
    this.sanitizeFileName = options.sanitizeFileName;
    this.spawnEnv = options.spawnEnv;
    this.attachmentTtlMs = Math.max(60_000, Number(process.env.ATTACHMENT_TTL_MS || 6 * 60 * 60 * 1000));
  }

  withTimeout(promise, timeoutMs, label) {
    const waitMs = Math.max(1000, Number(timeoutMs || this.requestTimeoutMs || 180000));
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`${label || "operation"} timed out after ${waitMs}ms`));
      }, waitMs);
      Promise.resolve(promise)
        .then((result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  scheduleCleanup(filePath) {
    setTimeout(() => {
      fs.rm(filePath, { force: true }, () => {});
    }, this.attachmentTtlMs);
  }

  async downloadToFile(url, destinationPath) {
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

  async transcribeAudioWithOpenAI(filePath, mimeType) {
    const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) return null;

    const model = String(process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1").trim();
    const boundary = `----aiBotBoundary${Date.now()}${Math.random().toString(16).slice(2)}`;
    const fileName = path.basename(filePath);
    const fileData = fs.readFileSync(filePath);

    const head = Buffer.from(
      [
        `--${boundary}`,
        "Content-Disposition: form-data; name=\"model\"",
        "",
        model,
        `--${boundary}`,
        "Content-Disposition: form-data; name=\"response_format\"",
        "",
        "json",
        `--${boundary}`,
        `Content-Disposition: form-data; name=\"file\"; filename=\"${fileName}\"`,
        `Content-Type: ${mimeType || "application/octet-stream"}`,
        "",
      ].join("\r\n") + "\r\n"
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, fileData, tail]);

    const raw = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "api.openai.com",
          path: "/v1/audio/transcriptions",
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": String(body.length),
          },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              return resolve(data);
            }
            reject(new Error(`Transcription HTTP ${res.statusCode || "unknown"}: ${data}`));
          });
        }
      );
      req.setTimeout(this.requestTimeoutMs, () => {
        req.destroy(new Error(`OpenAI transcription request timed out after ${this.requestTimeoutMs}ms`));
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });

    try {
      const parsed = JSON.parse(String(raw || "{}"));
      return typeof parsed.text === "string" ? parsed.text.trim() : "";
    } catch {
      return "";
    }
  }

  async transcribeAudioWithLocalScript(filePath) {
    const scriptPath = String(process.env.LOCAL_STT_SCRIPT || "/home/pi/aiBot/scripts/transcribe_voice.sh").trim();
    if (!scriptPath || !fs.existsSync(scriptPath)) return null;

    const lang = String(process.env.WHISPER_LANG || "auto").trim();
    return new Promise((resolve, reject) => {
      const p = spawn(scriptPath, [filePath, lang], {
        cwd: this.workdir,
        env: this.spawnEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      const killTimer = setTimeout(() => {
        try {
          p.kill("SIGTERM");
        } catch {
          // ignore
        }
      }, this.requestTimeoutMs);

      p.stdout.on("data", (d) => {
        stdout += d.toString("utf8");
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
        if (code !== 0) {
          const errText = String(stderr || stdout || "").trim();
          reject(new Error(errText || `Local transcription failed with code ${code}`));
          return;
        }
        resolve(String(stdout || "").trim() || "");
      });
    });
  }

  async buildPromptFromMessage(msg) {
    const text = msg.text?.trim();
    if (text) return text;

    const caption = String(msg.caption || "").trim();
    const uploadDir = path.join(os.tmpdir(), "ai-bot-uploads");
    fs.mkdirSync(uploadDir, { recursive: true });

    if (Array.isArray(msg.photo) && msg.photo.length > 0) {
      const photo = msg.photo[msg.photo.length - 1];
      const file = await this.bot.getFile(photo.file_id);
      const ext = path.extname(file.file_path || "") || ".jpg";
      const fileName = `${Date.now()}-${msg.message_id || "m"}-photo${ext}`;
      const localPath = path.join(uploadDir, this.sanitizeFileName(fileName, "photo.jpg"));
      const fileLink = await this.bot.getFileLink(photo.file_id);
      await this.downloadToFile(fileLink, localPath);
      this.scheduleCleanup(localPath);

      return [
        caption || "Analyze the attached image.",
        "",
        "Attached file from Telegram:",
        "- type: photo",
        `- local_path: ${localPath}`,
        "",
        "Use this local file in your response.",
      ].join("\n");
    }

    if (msg.document?.file_id) {
      const file = await this.bot.getFile(msg.document.file_id);
      const fromName = this.sanitizeFileName(msg.document.file_name || "", "");
      const extFromPath = path.extname(file.file_path || "");
      const ext = path.extname(fromName) || extFromPath || ".bin";
      const base = fromName ? path.basename(fromName, path.extname(fromName)) : "document";
      const fileName = `${Date.now()}-${msg.message_id || "m"}-${base}${ext}`;
      const localPath = path.join(uploadDir, this.sanitizeFileName(fileName, "document.bin"));
      const fileLink = await this.bot.getFileLink(msg.document.file_id);
      await this.downloadToFile(fileLink, localPath);
      this.scheduleCleanup(localPath);

      return [
        caption || "Analyze the attached document.",
        "",
        "Attached file from Telegram:",
        "- type: document",
        `- name: ${msg.document.file_name || path.basename(localPath)}`,
        `- mime_type: ${msg.document.mime_type || "unknown"}`,
        `- local_path: ${localPath}`,
        "",
        "Use this local file in your response.",
      ].join("\n");
    }

    if (msg.voice?.file_id || msg.audio?.file_id) {
      const isVoice = Boolean(msg.voice?.file_id);
      const media = isVoice ? msg.voice : msg.audio;
      const file = await this.bot.getFile(media.file_id);
      const extFromPath = path.extname(file.file_path || "");
      const ext = extFromPath || (isVoice ? ".ogg" : ".mp3");
      const fileName = `${Date.now()}-${msg.message_id || "m"}-${isVoice ? "voice" : "audio"}${ext}`;
      const localPath = path.join(
        uploadDir,
        this.sanitizeFileName(fileName, isVoice ? "voice.ogg" : "audio.mp3")
      );
      const fileLink = await this.bot.getFileLink(media.file_id);
      await this.downloadToFile(fileLink, localPath);
      this.scheduleCleanup(localPath);

      let transcript = "";
      let transcribeError = "";
      try {
        transcript =
          (await this.withTimeout(
            this.orchestrator.transcribeAudioWithQueue(localPath, String(process.env.WHISPER_LANG || "auto").trim()),
            this.requestTimeoutMs,
            "queue transcription"
          )) || "";
        if (!transcript) {
          transcript =
            (await this.withTimeout(
              this.transcribeAudioWithOpenAI(localPath, media.mime_type || ""),
              this.requestTimeoutMs,
              "openai transcription"
            )) || "";
        }
        if (!transcript) {
          transcript =
            (await this.withTimeout(
              this.transcribeAudioWithLocalScript(localPath),
              this.requestTimeoutMs,
              "local transcription"
            )) || "";
        }
      } catch (e) {
        transcribeError = e.message || String(e);
      }

      if (transcript) {
        return [caption ? `User note: ${caption}` : "Transcribed voice message from Telegram:", "", transcript].join("\n");
      }

      return [
        caption || `Analyze the attached ${isVoice ? "voice message" : "audio file"}.`,
        "",
        "Attached file from Telegram:",
        `- type: ${isVoice ? "voice" : "audio"}`,
        `- mime_type: ${media.mime_type || "unknown"}`,
        `- duration_seconds: ${media.duration || "unknown"}`,
        `- local_path: ${localPath}`,
        "",
        transcribeError
          ? `Transcription failed: ${transcribeError}`
          : "No transcription configured (set OPENAI_API_KEY or LOCAL_STT_SCRIPT to enable speech-to-text).",
        "",
        "Use this local file in your response.",
      ].join("\n");
    }

    return "";
  }
}

module.exports = {
  AttachmentService,
};
