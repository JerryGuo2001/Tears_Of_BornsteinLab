// server.js (ESM) — rooms + roles + convert/allocate + tile resources + gating + edge transfer + per-tile visibility
import express from "express";
import http from "node:http";
import { Server } from "socket.io";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.set("trust proxy", 1);

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
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(publicDir, "index.html"));
});
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// Instruction images endpoint
app.get("/api/instructions", (_req, res) => {
  const instDir = path.join(publicDir, "instructions");
  let images = [];
  try {
    images = fs.readdirSync(instDir)
      .filter(f => f.toLowerCase().endsWith(".png"))
      .sort()
      .map(f => `/instructions/${f}`);
  } catch {}
  res.json({ images });
});

// ---------- Game config ----------
const GAME = {
  MAP_SIZE: 800,
  PLAYER_RADIUS: 16,
  DEFAULT_SPEED: 360,
  TICK_HZ: 60,
  START_GOLD: 100,
  FARMER: { x: 400, y: 400, r: 80 },
};
const COST = { MOVE: 10, SCAN: 5, FORAGE: 5 };

const colors = ["#3b82f6", "#10b981", "#f59e0b"];
const SAY_ALLOWED = new Set(["Hi", "Jerry is the best"]);

// Rooms
const ROOMS = new Map(); // code -> room

function genCode() {
  const ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += ABC[Math.floor(Math.random() * ABC.length)];
  return out;
}

function rand(min, max) { return Math.random() * (max - min) + min; }
function randint(min, max) { return Math.floor(rand(min, max + 1)); }

function randResourcePoints() {
  const n = randint(1, 3);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const x = randint(120, 680);
    const y = randint(120, 680);
    const richness = randint(1, 5);
    pts.push({ x, y, richness, remaining: richness * 10, revealed: false });
  }
  return pts;
}

function genGrid() {
  const W = 5, H = 5, start = { x: 2, y: 2 };
  const tiles = Array.from({ length: H }, () => Array.from({ length: W }, () => ({ points: [] })));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const isStart = (x === start.x && y === start.y);
    if (isStart) continue;
    if (Math.random() < 0.67) tiles[y][x].points = randResourcePoints();
  }
  return { W, H, start, tiles };
}

function makeRoom(code) {
  return {
    code,
    players: {},        // id -> { x,y,vx,vy,speed,color,name,role,roomCode }
    sockets: new Set(),
    dancers: new Set(),
    grid: genGrid(),
    visited: new Set([`2,2`]),
    stage: "lobby",
    roles: {},
    bank: { gold: GAME.START_GOLD },
    food: { leader: 0, explorer: 0, forager: 0 },
    carrying: { forager: 0 },
    labels: { explorer: {}, forager: {}, leader: {} }, // "x,y" -> 0..3
    foragerTarget: null, // {x,y}
    farmReady: new Set(),
    mapShared: false,
    tilePos: {},        // id -> {x,y}   <-- NEW
  };
}

function roomOf(socket) {
  const code = socket.data.roomCode;
  return code ? ROOMS.get(code) : null;
}

function tileKey(x,y){ return `${x},${y}`; }

function liteSnapshot(room) {
  const out = {};
  for (const id in room.players) {
    const p = room.players[id];
    const tp = room.tilePos[id] || { x: room.grid.start.x, y: room.grid.start.y };
    out[id] = { x: p.x, y: p.y, color: p.color, name: p.name, role: p.role || null, tile: tp };
  }
  return out;
}

function resourcesBundle(room) {
  return {
    leader:   { gold: room.bank.gold, food: room.food.leader, foragerCarrying: room.carrying.forager },
    explorer: { explorerFood: room.food.explorer },
    forager:  { foragerFood: room.food.forager, foragerCarrying: room.carrying.forager },
  };
}

function inFarmer(p) {
  const dx = p.x - GAME.FARMER.x, dy = p.y - GAME.FARMER.y;
  return (dx*dx + dy*dy) <= (GAME.FARMER.r * GAME.FARMER.r);
}

function startMatch(room) {
  room.stage = "starting";
  const ids = Object.keys(room.players);
  const roles = ["leader", "explorer", "forager"].sort(() => Math.random() - 0.5);
  for (let i = 0; i < 3; i++) {
    const id = ids[i];
    const role = roles[i];
    room.players[id].role = role;
    room.roles[id] = role;
  }
  io.to(room.code).emit("matchStarted", {
    roles: room.roles,
    grid: { W: room.grid.W, H: room.grid.H, start: room.grid.start },
    resources: resourcesBundle(room),
  });
}

function updateResources(room) { io.to(room.code).emit("resources", resourcesBundle(room)); }

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function emitTileDataTo(socket, room, x, y) {
  const t = room.grid.tiles[y][x];
  const points = (t.points || []).map(pt => ({
    x: pt.x, y: pt.y,
    revealed: !!pt.revealed,
    richness: pt.revealed ? pt.richness : null,
    remaining: pt.remaining,
  }));
  socket.emit("tileData", { x, y, points });
}

// ---------- Sockets ----------
io.on("connection", (socket) => {
  socket.data.lastSay = 0;

  socket.on("createRoom", (_payload, cb) => {
    const code = genCode();
    const room = makeRoom(code);
    ROOMS.set(code, room);
    cb?.({ ok: true, code });
  });

  socket.on("joinRoom", ({ code }, cb) => {
    code = (code || "").toUpperCase();
    const room = ROOMS.get(code);
    if (!room) return cb?.({ ok: false, error: "Room not found" });
    if (Object.keys(room.players).length >= 3) return cb?.({ ok: false, error: "Room full" });

    socket.join(code);
    socket.data.roomCode = code;

    const seat = Object.keys(room.players).length;
    const spawn = { x: 400, y: 400 };
    room.players[socket.id] = {
      x: spawn.x, y: spawn.y, vx: 0, vy: 0, speed: GAME.DEFAULT_SPEED,
      color: colors[seat % colors.length], name: `P${seat + 1}`, role: null, roomCode: code,
    };
    room.sockets.add(socket.id);

    // start tile
    socket.data.tilePos = { x: room.grid.start.x, y: room.grid.start.y };
    room.tilePos[socket.id] = { ...socket.data.tilePos };

    socket.emit("hello", {
      config: { MAP_SIZE: GAME.MAP_SIZE, PLAYER_RADIUS: GAME.PLAYER_RADIUS },
      youArePlayer: true,
      players: liteSnapshot(room),  // includes tile
      room: { code },
      grid: { W: room.grid.W, H: room.grid.H, start: room.grid.start },
      dancers: Array.from(room.dancers),
      mapShared: room.mapShared,
    });

    // send starting tile data
    emitTileDataTo(socket, room, room.grid.start.x, room.grid.start.y);

    io.to(room.code).emit("joined", { id: socket.id, state: liteSnapshot(room)[socket.id] });

    if (Object.keys(room.players).length === 3) startMatch(room);

    cb?.({ ok: true });
  });

  socket.on("move", (keys) => {
    const room = roomOf(socket);
    if (!room) return;
    const p = room.players[socket.id];
    if (!p) return;
    let vx = 0, vy = 0;
    if (keys?.left)  vx -= 1;
    if (keys?.right) vx += 1;
    if (keys?.up)    vy -= 1;
    if (keys?.down)  vy += 1;
    if (vx || vy) { const m = Math.hypot(vx, vy); vx /= m; vy /= m; }
    p.vx = vx; p.vy = vy;
  });

  socket.on("say", (payload) => {
    const room = roomOf(socket);
    if (!room) return;
    const now = Date.now();
    if (now - (socket.data.lastSay || 0) < 500) return;
    socket.data.lastSay = now;
    let text = (payload && typeof payload.text === "string") ? payload.text.trim() : "";
    if (!SAY_ALLOWED.has(text)) return;
    io.to(room.code).emit("say", { id: socket.id, text });
  });

  socket.on("dance", (payload) => {
    const room = roomOf(socket);
    if (!room) return;
    const on = !!(payload && payload.on);
    if (on) room.dancers.add(socket.id); else room.dancers.delete(socket.id);
    io.to(room.code).emit("dance", { id: socket.id, on });
  });

  // Convert: all three inside farmer circle and press F
  socket.on("farmConvert", () => {
    const room = roomOf(socket);
    if (!room) return;
    if (room.bank.gold <= 0) return;

    const p = room.players[socket.id];
    if (!p) return;
    const atBase = inFarmer(p);
    if (!atBase) return;

    room.farmReady.add(socket.id);
    if (room.farmReady.size === 3) {
      room.farmReady.clear();
      room.food.leader += room.bank.gold;
      room.bank.gold = 0;
      updateResources(room);
    }
  });

  // Leader allocates food to explorer & forager
  socket.on("allocateFood", (payload) => {
    const room = roomOf(socket);
    if (!room) return;
    if (room.players[socket.id]?.role !== "leader") return;
    const giveExp = Math.max(0, Math.floor(payload?.explorer ?? 0));
    const giveFor = Math.max(0, Math.floor(payload?.forager ?? 0));
    const total = giveExp + giveFor;
    if (total <= 0 || total > room.food.leader) return;
    room.food.leader -= total;
    room.food.explorer += giveExp;
    room.food.forager  += giveFor;
    updateResources(room);
  });

  // Enter neighbor tile (E) — with forager gating + reposition
  socket.on("enterNeighbor", ({ dir }) => {
    const room = roomOf(socket);
    if (!room) return;
    const me = room.players[socket.id];
    const role = me?.role;
    if (!role || (role !== "explorer" && role !== "forager")) return;

    if (role === "explorer" && room.food.explorer < COST.MOVE) return;
    if (role === "forager"  && room.food.forager  < COST.MOVE) return;

    // Forager gating: must have mapShared and a target, and must move closer to it
    if (role === "forager") {
      if (!room.mapShared) return;
      if (!room.foragerTarget) return;
    }

    const pos = socket.data.tilePos || { x: room.grid.start.x, y: room.grid.start.y };
    let nx = pos.x, ny = pos.y;
    if (dir === "up") ny--;
    else if (dir === "down") ny++;
    else if (dir === "left") nx--;
    else if (dir === "right") nx++;
    if (nx < 0 || ny < 0 || nx >= room.grid.W || ny >= room.grid.H) return;

    // Forager must move closer to target
    if (role === "forager") {
      const d0 = Math.abs(room.foragerTarget.x - pos.x) + Math.abs(room.foragerTarget.y - pos.y);
      const d1 = Math.abs(room.foragerTarget.x - nx) + Math.abs(room.foragerTarget.y - ny);
      if (!(d1 < d0)) return;
    }

    // apply
    socket.data.tilePos = { x: nx, y: ny };
    room.tilePos[socket.id] = { x: nx, y: ny };
    if (role === "explorer") room.food.explorer -= COST.MOVE; else room.food.forager -= COST.MOVE;
    room.visited.add(tileKey(nx, ny));

    // visually place on opposite edge
    const size = GAME.MAP_SIZE, r = GAME.PLAYER_RADIUS;
    if (dir === "right") me.x = r + 4;
    if (dir === "left")  me.x = size - r - 4;
    if (dir === "down")  me.y = r + 4;
    if (dir === "up")    me.y = size - r - 4;

    // send tile data to the mover
    emitTileDataTo(socket, room, nx, ny);

    io.to(room.code).emit("tileUpdate", {
      role,
      tile: { x: nx, y: ny },
      visited: Array.from(room.visited),
    });
    updateResources(room);

    // If explorer returned to base, mark mapShared and notify; share labels
    if (role === "explorer" && nx === room.grid.start.x && ny === room.grid.start.y) {
      room.mapShared = true;
      io.to(room.code).emit("mapShared", { ok: true });
      const leaderId = Object.keys(room.players).find(id => room.players[id].role === "leader");
      if (leaderId) io.to(leaderId).emit("labelsShared", { labels: room.labels.explorer });
    }
  });

  // Examine nearest resource (Q) — explorer only
  socket.on("scanTile", () => {
    const room = roomOf(socket);
    if (!room) return;
    const me = room.players[socket.id];
    if (me?.role !== "explorer") return;
    if (room.food.explorer < COST.SCAN) return;

    const pos = socket.data.tilePos || { x: room.grid.start.x, y: room.grid.start.y };
    const t = room.grid.tiles[pos.y][pos.x];
    if (!t?.points?.length) return;

    const R = 80;
    let best = -1, bestD = 1e9;
    for (let i=0;i<t.points.length;i++){
      const pt = t.points[i];
      if (pt.remaining <= 0) continue;
      const d = Math.hypot(pt.x - me.x, pt.y - me.y);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0 || bestD > R) return;

    room.food.explorer -= COST.SCAN;
    t.points[best].revealed = true;

    io.to(room.code).emit("tileDataUpdate", {
      x: pos.x, y: pos.y, index: best,
      point: { x: t.points[best].x, y: t.points[best].y, revealed: true, richness: t.points[best].richness, remaining: t.points[best].remaining }
    });
    updateResources(room);
  });

  // Label current tile (any role) — value 0..3
  socket.on("markTile", ({ x, y, label }) => {
    const room = roomOf(socket);
    if (!room) return;
    const role = room.players[socket.id]?.role || "leader";
    x = Math.max(0, Math.min(room.grid.W - 1, Math.floor(x)));
    y = Math.max(0, Math.min(room.grid.H - 1, Math.floor(y)));
    room.labels[role][`${x},${y}`] = Math.max(0, Math.min(3, Math.floor(label || 0)));
    io.to(room.code).emit("labelsUpdate", { labels: room.labels });
  });

  // Leader sets a forager target
  socket.on("assignForagerTarget", ({ x, y }) => {
    const room = roomOf(socket);
    if (!room) return;
    if (room.players[socket.id]?.role !== "leader") return;
    x = Math.max(0, Math.min(room.grid.W - 1, Math.floor(x)));
    y = Math.max(0, Math.min(room.grid.H - 1, Math.floor(y)));
    room.foragerTarget = { x, y };
    io.to(room.code).emit("foragerTarget", room.foragerTarget);
  });

  // Forager collects nearest resource (Space)
  socket.on("collectResource", () => {
    const room = roomOf(socket);
    if (!room) return;
    const me = room.players[socket.id];
    if (me?.role !== "forager") return;
    if (room.food.forager < COST.FORAGE) return;

    const pos = socket.data.tilePos || { x: room.grid.start.x, y: room.grid.start.y };
    const t = room.grid.tiles[pos.y][pos.x];
    if (!t?.points?.length) return;

    const R = 80;
    let best = -1, bestD = 1e9;
    for (let i=0;i<t.points.length;i++){
      const pt = t.points[i];
      if (pt.remaining <= 0) continue;
      const d = Math.hypot(pt.x - me.x, pt.y - me.y);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0 || bestD > R) return;

    room.food.forager -= COST.FORAGE;
    const pt = t.points[best];
    const take = Math.max(1, Math.min(pt.remaining, pt.richness));
    pt.remaining -= take;
    if (pt.remaining <= 0) { pt.remaining = 0; }
    room.carrying.forager += take;

    io.to(room.code).emit("tileDataUpdate", {
      x: pos.x, y: pos.y, index: best,
      point: { x: pt.x, y: pt.y, revealed: !!pt.revealed, richness: pt.revealed ? pt.richness : null, remaining: pt.remaining }
    });
    updateResources(room);
  });

  // Deliver carried gold back at base (V)
  socket.on("deliverToBase", () => {
    const room = roomOf(socket);
    if (!room) return;
    const me = room.players[socket.id];
    if (me?.role !== "forager") return;

    const pos = socket.data.tilePos || { x: room.grid.start.x, y: room.grid.start.y };
    if (pos.x !== room.grid.start.x || pos.y !== room.grid.start.y) return;
    if (room.carrying.forager <= 0) return;

    room.carrying.forager = 0;
    io.to(room.code).emit("matchEnded", { reason: "Forager delivered resources!" });
    updateResources(room);
  });

  socket.on("disconnect", () => {
    const room = roomOf(socket);
    if (!room) return;
    const wasPlayer = !!room.players[socket.id];
    delete room.players[socket.id];
    delete room.tilePos[socket.id];   // <-- remove tile position
    room.dancers.delete(socket.id);
    room.sockets.delete(socket.id);
    io.to(room.code).emit("left", { id: socket.id });
    if (Object.keys(room.players).length === 0) ROOMS.delete(room.code);
  });
});

// ---------- Tick ----------
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt  = Math.min(0.1, (now - last) / 1000);
  last = now;

  for (const [code, room] of ROOMS) {
    for (const id in room.players) {
      const p = room.players[id];
      p.x = Math.max(GAME.PLAYER_RADIUS, Math.min(GAME.MAP_SIZE - GAME.PLAYER_RADIUS, p.x + p.vx * p.speed * dt));
      p.y = Math.max(GAME.PLAYER_RADIUS, Math.min(GAME.MAP_SIZE - GAME.PLAYER_RADIUS, p.y + p.vy * p.speed * dt));
    }
    io.to(code).volatile.compress(false).emit("state", liteSnapshot(room)); // includes tile
  }
}, 1000 / GAME.TICK_HZ);

// Listen
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server at http://localhost:${PORT}`));
