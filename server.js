// server.js (ESM)
import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1) App/server/socket
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] }
});

// 2) Static + routes
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// 3) Game config (server-owned)
const GAME = {
  MAP_SIZE: 800,
  PLAYER_RADIUS: 16,
  DEFAULT_SPEED: 360,   // px/s
  TICK_HZ: 60,          // server tick rate
  SPAWNS: [
    { x: 400, y: 400 },
    { x: 400, y: 400 },
    { x: 400, y: 400 }
  ]
};

// 4) World state
const colors = ["#3b82f6", "#10b981", "#f59e0b"];
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

// 5) Socket handlers
io.on("connection", (socket) => {
  const count = Object.keys(players).length;
  const isPlayer = count < 3;

  if (isPlayer) {
    const seat = count;
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
    const p = players[socket.id]; if (!p) return;
    let vx = 0, vy = 0;
    if (keys.left)  vx -= 1;
    if (keys.right) vx += 1;
    if (keys.up)    vy -= 1;
    if (keys.down)  vy += 1;
    if (vx || vy) { const m = Math.hypot(vx, vy); vx /= m; vy /= m; }
    p.vx = vx; p.vy = vy;
  });

  // Client can't set speed/spawn; this is just an acknowledge for UI flow
  socket.on("start", () => socket.emit("started", { ok: true }));

  socket.on("disconnect", () => {
    const wasPlayer = !!players[socket.id];
    delete players[socket.id];
    if (wasPlayer) io.emit("left", { id: socket.id });
  });
});

// 6) Server tick (authoritative integration)
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

  io.volatile.compress(false).emit("state", liteSnapshot());
}, 1000 / GAME.TICK_HZ);

// 7) Listen
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server at http://localhost:${PORT}`));
