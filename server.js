// server.js (ESM, chat + movement)
import express from "express";
import http from "node:http";
import { Server } from "socket.io";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.set("trust proxy", 1); // Render/Heroku proxies

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] },
  pingInterval: 20000,
  pingTimeout: 15000,
});

// Static + routes
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir, { extensions: ["html"] }));
app.get("/", (_req, res) => {
  res.set("Cache-Control", "no-store"); // avoid stale HTML after deploy
  res.sendFile(path.join(publicDir, "index.html"));
});
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// Game config/state
const GAME = {
  MAP_SIZE: 800,
  PLAYER_RADIUS: 16,
  DEFAULT_SPEED: 360,  // px/s
  TICK_HZ: 60,         // server tick rate
  SPAWNS: [{ x: 400, y: 400 }, { x: 400, y: 400 }, { x: 400, y: 400 }]
};

const colors  = ["#3b82f6", "#10b981", "#f59e0b"];
const players = {}; // id -> {x,y,vx,vy,speed,color,name}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function liteSnapshot() {
  const out = {};
  for (const id in players) {
    const p = players[id];
    out[id] = { x: p.x, y: p.y, color: p.color, name: p.name };
  }
  return out;
}

const SAY_ALLOWED = new Set(["Hi", "Jerry is the best"]);

// Sockets
io.on("connection", (socket) => {
  const count    = Object.keys(players).length;
  const isPlayer = count < 3;

  if (isPlayer) {
    const seat  = count;
    const spawn = GAME.SPAWNS[seat] || { x: 100 + seat * 50, y: 100 + seat * 50 };
    players[socket.id] = {
      x: spawn.x, y: spawn.y,
      vx: 0, vy: 0,
      speed: GAME.DEFAULT_SPEED,
      color: colors[seat % colors.length],
      name: `P${seat + 1}`
    };
  }

  socket.emit("hello", {
    config: { MAP_SIZE: GAME.MAP_SIZE, PLAYER_RADIUS: GAME.PLAYER_RADIUS },
    youArePlayer: isPlayer,
    players: liteSnapshot()
  });

  if (isPlayer) io.emit("joined", { id: socket.id, state: liteSnapshot()[socket.id] });

  socket.on("move", (keys) => {
    const p = players[socket.id];
    if (!p) return;
    let vx = 0, vy = 0;
    if (keys?.left)  vx -= 1;
    if (keys?.right) vx += 1;
    if (keys?.up)    vy -= 1;
    if (keys?.down)  vy += 1;
    if (vx || vy) { const m = Math.hypot(vx, vy); vx /= m; vy /= m; }
    p.vx = vx; p.vy = vy;
  });

  // Simple chat: throttle and whitelist
  socket.data.lastSay = 0;
  socket.on("say", (payload) => {
    const now = Date.now();
    if (now - (socket.data.lastSay || 0) < 500) return; // 0.5s throttle
    socket.data.lastSay = now;

    let text = (payload && typeof payload.text === "string") ? payload.text.trim() : "";
    if (!SAY_ALLOWED.has(text)) return;

    io.emit("say", { id: socket.id, text }); // broadcast to all (including sender)
  });

  socket.on("start", () => socket.emit("started", { ok: true }));

  socket.on("disconnect", () => {
    const wasPlayer = !!players[socket.id];
    delete players[socket.id];
    if (wasPlayer) io.emit("left", { id: socket.id });
  });
});

// Tick (authoritative integration)
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt  = Math.min(0.1, (now - last) / 1000); // clamp dt to avoid giant jumps after stall
  last = now;

  for (const id in players) {
    const p = players[id];
    p.x = clamp(p.x + p.vx * p.speed * dt, GAME.PLAYER_RADIUS, GAME.MAP_SIZE - GAME.PLAYER_RADIUS);
    p.y = clamp(p.y + p.vy * p.speed * dt, GAME.PLAYER_RADIUS, GAME.MAP_SIZE - GAME.PLAYER_RADIUS);
  }

  io.volatile.compress(false).emit("state", liteSnapshot());
}, 1000 / GAME.TICK_HZ);

// Listen
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server at http://localhost:${PORT}`));
