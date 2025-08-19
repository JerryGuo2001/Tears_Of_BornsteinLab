import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));

// ---------- Authoritative game config ----------
const GAME = {
  MAP_SIZE: 800,
  PLAYER_RADIUS: 16,
  DEFAULT_SPEED: 250,            // px/s, server authoritative
  TICK_HZ: 60,                   // 20 ticks/sec -> less bandwidth
  SPAWNS: [                      // fixed spawns by seat index
    { x: 400, y: 400 },
    { x: 400, y: 400 },
    { x: 400, y: 400 }
  ]
};

// ---------- World state ----------
const colors = ["#3b82f6", "#10b981", "#f59e0b"];
const players = {};  // id -> {x,y,vx,vy,speed,color,name}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Minimal snapshot to broadcast (smaller payload)
function liteSnapshot() {
  const out = {};
  for (const id in players) {
    const p = players[id];
    out[id] = { x: p.x, y: p.y, color: p.color, name: p.name };
  }
  return out;
}

io.on("connection", (socket) => {
  const existing = Object.keys(players).length;
  const isPlayer = existing < 3;

  if (isPlayer) {
    const seat = existing;  // 0..2
    const spawn = GAME.SPAWNS[seat] || { x: 100 + seat * 50, y: 100 + seat * 50 };
    players[socket.id] = {
      x: spawn.x, y: spawn.y,
      vx: 0, vy: 0,
      speed: GAME.DEFAULT_SPEED,
      color: colors[seat % colors.length],
      name: `P${seat + 1}`
    };
  }

  // Send hello with server-owned config + current players
  socket.emit("hello", {
    config: { MAP_SIZE: GAME.MAP_SIZE, PLAYER_RADIUS: GAME.PLAYER_RADIUS },
    youArePlayer: isPlayer,
    players: liteSnapshot()
  });

  if (isPlayer) io.emit("joined", { id: socket.id, state: liteSnapshot()[socket.id] });

  // Movement intent from client (booleans)
  socket.on("move", (keys) => {
    const p = players[socket.id]; if (!p) return;
    let vx = 0, vy = 0;
    if (keys.left)  vx -= 1;
    if (keys.right) vx += 1;
    if (keys.up)    vy -= 1;
    if (keys.down)  vy += 1;
    if (vx || vy) { const m = Math.hypot(vx, vy); vx /= m; vy /= m; }
    p.vx = vx; p.vy = vy;
  });

  // Client "start" now just acknowledges; server ignores client params
  socket.on("start", () => socket.emit("started", { ok: true }));

  socket.on("disconnect", () => {
    const wasPlayer = !!players[socket.id];
    delete players[socket.id];
    if (wasPlayer) io.emit("left", { id: socket.id });
  });
});

// ---------- Server tick ----------
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = (now - last) / 1000;
  last = now;

  for (const id in players) {
    const p = players[id];
    p.x = clamp(p.x + p.vx * p.speed * dt, GAME.PLAYER_RADIUS, GAME.MAP_SIZE - GAME.PLAYER_RADIUS);
    p.y = clamp(p.y + p.vy * p.speed * dt, GAME.PLAYER_RADIUS, GAME.MAP_SIZE - GAME.PLAYER_RADIUS);
  }

  // Volatile + no compression => lower latency, drops frames if congested
  io.volatile.compress(false).emit("state", liteSnapshot());
}, 1000 / GAME.TICK_HZ);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server at http://localhost:${PORT}`));
