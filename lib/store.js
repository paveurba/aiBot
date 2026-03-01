const fs = require("fs");
const path = require("path");
const IORedis = require("ioredis");

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

class FileStore {
  constructor({ settingsPath, sessionsPath }) {
    this.settingsPath = settingsPath;
    this.sessionsPath = sessionsPath;
  }

  async getChatSettings(chatId) {
    const all = loadJson(this.settingsPath, {});
    return all[String(chatId)] || {};
  }

  async setChatSettings(chatId, settings) {
    const all = loadJson(this.settingsPath, {});
    const key = String(chatId);
    if (!settings || Object.keys(settings).length === 0) {
      delete all[key];
    } else {
      all[key] = settings;
    }
    saveJson(this.settingsPath, all);
  }

  async clearChat(chatId) {
    const settings = loadJson(this.settingsPath, {});
    const sessions = loadJson(this.sessionsPath, {});
    delete settings[String(chatId)];
    delete sessions[String(chatId)];
    saveJson(this.settingsPath, settings);
    saveJson(this.sessionsPath, sessions);
  }

  _getChatSessions(chatId) {
    const all = loadJson(this.sessionsPath, {});
    return all[String(chatId)] || {};
  }

  _setChatSessions(chatId, value) {
    const all = loadJson(this.sessionsPath, {});
    const key = String(chatId);
    if (!value || Object.keys(value).length === 0) {
      delete all[key];
    } else {
      all[key] = value;
    }
    saveJson(this.sessionsPath, all);
  }

  async getSession(chatId, agent) {
    const sessions = this._getChatSessions(chatId);
    return sessions[agent] || null;
  }

  async setSession(chatId, agent, sessionId) {
    if (!sessionId) return;
    const sessions = this._getChatSessions(chatId);
    sessions[agent] = sessionId;
    this._setChatSessions(chatId, sessions);
  }

  async getWorkerSession(chatId, agent, workerId) {
    const sessions = this._getChatSessions(chatId);
    return sessions.workers?.[agent]?.[String(workerId)] || null;
  }

  async setWorkerSession(chatId, agent, workerId, sessionId) {
    if (!sessionId) return;
    const sessions = this._getChatSessions(chatId);
    if (!sessions.workers || typeof sessions.workers !== "object") sessions.workers = {};
    if (!sessions.workers[agent] || typeof sessions.workers[agent] !== "object") {
      sessions.workers[agent] = {};
    }
    sessions.workers[agent][String(workerId)] = sessionId;
    this._setChatSessions(chatId, sessions);
  }

  async getCoordinatorSession(chatId, agent) {
    const sessions = this._getChatSessions(chatId);
    return sessions.coordinator?.[agent] || null;
  }

  async setCoordinatorSession(chatId, agent, sessionId) {
    if (!sessionId) return;
    const sessions = this._getChatSessions(chatId);
    if (!sessions.coordinator || typeof sessions.coordinator !== "object") {
      sessions.coordinator = {};
    }
    sessions.coordinator[agent] = sessionId;
    this._setChatSessions(chatId, sessions);
  }

  async getManagerSession(chatId, agent) {
    const sessions = this._getChatSessions(chatId);
    return sessions.manager?.[agent] || null;
  }

  async setManagerSession(chatId, agent, sessionId) {
    if (!sessionId) return;
    const sessions = this._getChatSessions(chatId);
    if (!sessions.manager || typeof sessions.manager !== "object") {
      sessions.manager = {};
    }
    sessions.manager[agent] = sessionId;
    this._setChatSessions(chatId, sessions);
  }
}

class RedisStore {
  constructor({ redisUrl, prefix = "aibot" }) {
    this.prefix = prefix;
    this.redis = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }

  _settingsKey(chatId) {
    return `${this.prefix}:settings:${chatId}`;
  }

  _sessionsKey(chatId) {
    return `${this.prefix}:sessions:${chatId}`;
  }

  async getChatSettings(chatId) {
    const data = await this.redis.hgetall(this._settingsKey(String(chatId)));
    return data || {};
  }

  async setChatSettings(chatId, settings) {
    const key = this._settingsKey(String(chatId));
    if (!settings || Object.keys(settings).length === 0) {
      await this.redis.del(key);
      return;
    }
    await this.redis.del(key);
    await this.redis.hset(key, settings);
  }

  async clearChat(chatId) {
    const c = String(chatId);
    await this.redis.del(this._settingsKey(c));
    await this.redis.del(this._sessionsKey(c));
  }

  async getSession(chatId, agent) {
    return await this.redis.hget(this._sessionsKey(String(chatId)), `session:${agent}`);
  }

  async setSession(chatId, agent, sessionId) {
    if (!sessionId) return;
    await this.redis.hset(this._sessionsKey(String(chatId)), `session:${agent}`, String(sessionId));
  }

  async getWorkerSession(chatId, agent, workerId) {
    return await this.redis.hget(this._sessionsKey(String(chatId)), `worker:${agent}:${String(workerId)}`);
  }

  async setWorkerSession(chatId, agent, workerId, sessionId) {
    if (!sessionId) return;
    await this.redis.hset(
      this._sessionsKey(String(chatId)),
      `worker:${agent}:${String(workerId)}`,
      String(sessionId)
    );
  }

  async getCoordinatorSession(chatId, agent) {
    return await this.redis.hget(this._sessionsKey(String(chatId)), `coordinator:${agent}`);
  }

  async setCoordinatorSession(chatId, agent, sessionId) {
    if (!sessionId) return;
    await this.redis.hset(this._sessionsKey(String(chatId)), `coordinator:${agent}`, String(sessionId));
  }

  async getManagerSession(chatId, agent) {
    return await this.redis.hget(this._sessionsKey(String(chatId)), `manager:${agent}`);
  }

  async setManagerSession(chatId, agent, sessionId) {
    if (!sessionId) return;
    await this.redis.hset(this._sessionsKey(String(chatId)), `manager:${agent}`, String(sessionId));
  }
}

function createStore({ settingsPath, sessionsPath }) {
  const redisUrl = String(process.env.REDIS_URL || "").trim();
  const redisPrefix = String(process.env.REDIS_PREFIX || "aibot").trim();
  if (redisUrl) {
    return new RedisStore({ redisUrl, prefix: redisPrefix });
  }
  return new FileStore({ settingsPath: path.resolve(settingsPath), sessionsPath: path.resolve(sessionsPath) });
}

module.exports = {
  createStore,
};
