import {
  Browsers,
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from "@whiskeysockets/baileys";
import pino from "pino";
import { Boom } from "@hapi/boom";
import { createClient } from "redis";
import { createServer } from "http";
import { inspect } from "util";
import { exec } from "child_process";
import useRedisAuthState from "./useRedisAuthState.js";

const logger = pino({ level: "silent" });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const redis = createClient({ url: process.env.REDIS_URL || "redis://localhost:6379" });
redis.on("error", (err) => console.error("[Redis]", err));
await redis.connect();

const PORT = process.env.PORT || 3000;

let sockRef = null;
let status = "disconnected";

const routes = {
  "GET /health": (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status, uptime: process.uptime() }));
  },

  "POST /send": async (req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { jid, message } = JSON.parse(body);
        if (!jid || !message) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "jid and message required" }));
        }
        if (!sockRef || status !== "open") {
          res.writeHead(503, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "WhatsApp not connected" }));
        }
        await sockRef.sendMessage(jid, { text: message });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  },
};

const server = createServer((req, res) => {
  const key = `${req.method} ${req.url}`;
  const handler = routes[key];
  if (handler) {
    handler(req, res);
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }
});

server.listen(PORT, () => console.log(`[HTTP] Listening on port ${PORT}`));

async function handleMessage(sock, msg, from, body) {
  const text = body.trim();
  const lower = text.toLowerCase();

  if (lower.startsWith(">")) {
    try {
      const code = text.slice(1).trim();
      const result = await eval(code);
      const output = inspect(result, { depth: 10 });
      await sock.sendMessage(from, { text: output }, { quoted: msg });
    } catch (err) {
      await sock.sendMessage(from, { text: String(err) }, { quoted: msg });
    }
    return;
  }

  if (lower.startsWith("$")) {
    const command = text.slice(1).trim();
    exec(command, async (err, stdout, stderr) => {
      if (err) {
        await sock.sendMessage(from, { text: err.message }, { quoted: msg });
        return;
      }
      const output = stdout || stderr || "No output";
      await sock.sendMessage(from, { text: output }, { quoted: msg });
    });
    return;
  }
}

async function start() {
  const { state, saveCreds, clearState } = await useRedisAuthState(redis, "wa:bot1");
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[WA] Baileys v${version} - isLatest: ${isLatest}`);

  const sock = makeWASocket({
    browser: Browsers.macOS("Edge"),
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    version,
  });

  sockRef = sock;

  if (!sock.authState.creds.registered) {
    await delay(1000);
    try {
      const pairingCode = await sock.requestPairingCode(process.env.PHONE_NUMBER);
      console.log(`[WA] Pairing Code: ${pairingCode}`);
    } catch (err) {
      console.error("[WA] Gagal mendapatkan pairing code:", err.message);
    }
  }

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("[WA] QR tersedia — scan atau gunakan pairing code");
    }

    if (connection === "connecting") {
      status = "connecting";
    }

    if (connection === "open") {
      status = "open";
      console.log("[WA] ✅ Terhubung ke WhatsApp");
    }

    if (connection === "close") {
      status = "disconnected";
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;

      switch (statusCode) {
        case DisconnectReason.loggedOut:
          console.log("[WA] Logged out — membersihkan session...");
          await clearState();
          process.exit(0);
          break;

        case DisconnectReason.badSession:
          console.log("[WA] Session rusak — membersihkan dan restart...");
          await clearState();
          await delay(3000);
          start();
          break;

        case DisconnectReason.connectionReplaced:
          console.log("[WA] Sesi diambil alih perangkat lain — berhenti...");
          process.exit(0);
          break;

        case DisconnectReason.multideviceMismatch:
          console.log("[WA] Multi-device mismatch — membersihkan session...");
          await clearState();
          process.exit(0);
          break;

        case DisconnectReason.forbidden:
          console.log("[WA] Akses ditolak (403) — akun mungkin dibanned...");
          await clearState();
          process.exit(0);
          break;

        case DisconnectReason.restartRequired:
          console.log("[WA] Server minta restart — reconnecting...");
          await delay(3000);
          start();
          break;

        case DisconnectReason.timedOut:
          console.log("[WA] Koneksi timeout — reconnecting...");
          await delay(5000);
          start();
          break;

        case DisconnectReason.connectionLost:
          console.log("[WA] Koneksi hilang — reconnecting...");
          await delay(5000);
          start();
          break;

        case DisconnectReason.connectionClosed:
          console.log("[WA] Koneksi ditutup — reconnecting...");
          await delay(3000);
          start();
          break;

        case DisconnectReason.unavailableService:
          console.log("[WA] Layanan tidak tersedia (503) — reconnecting...");
          await delay(10000);
          start();
          break;

        default:
          console.log(`[WA] Disconnect tidak dikenal (${statusCode}) — reconnecting...`);
          await delay(5000);
          start();
          break;
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || !msg.key.fromMe) continue;

      const from = msg.key.remoteJid;
      const body =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        "";

      if (!body) continue;

      console.log(`[${from}] ${body}`);

      await handleMessage(sock, msg, from, body);
    }
  });
}

start().catch(console.error);
