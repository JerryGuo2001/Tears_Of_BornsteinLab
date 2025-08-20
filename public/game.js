// public/game.js — same-tile visibility + farmer only at center + (everything else as before)
import { loadStyle, THEMES } from "./style.js";

let phase = "boot";                   // "boot" | "lobby" | "game" | "celebration"


const canvas   = document.getElementById("game");
const ctx      = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const overlay  = document.getElementById("overlay");
const startBtn = document.getElementById("startBtn");

const boot    = document.getElementById("boot");
const bootMsg = document.getElementById("bootMsg");

// Stage DOM
const instructionsPage = document.getElementById("instructionsPage");
const instWrap  = document.getElementById("instructions");
const instImg   = document.getElementById("instImg");
const instPrev  = document.getElementById("instPrev");
const instNext  = document.getElementById("instNext");
const instContinue = document.getElementById("instContinue");

const lobbyEl   = document.getElementById("lobby");
const createBtn = document.getElementById("createRoom");
const joinBtn   = document.getElementById("joinRoom");
const codeInput = document.getElementById("roomCode");
const codeShow  = document.getElementById("codeShow");

// Role-specific HUD
const hudLeader   = document.getElementById("hudLeader");
const hudExplorer = document.getElementById("hudExplorer");
const hudForager  = document.getElementById("hudForager");

const leaderGold  = document.getElementById("leaderGold");
const leaderFood  = document.getElementById("leaderFood");
const explorerFood= document.getElementById("explorerFood");
const foragerFood = document.getElementById("foragerFood");
const foragerCarry= document.getElementById("foragerCarry");

const giveFoodForm = document.getElementById("giveFoodForm");
const giveFoodExplorer = document.getElementById("giveFoodExplorer");
const giveFoodForager  = document.getElementById("giveFoodForager");
const giveFoodBtn      = document.getElementById("giveFoodBtn");

// Sidebar minimap
const minimap  = document.getElementById("minimap");
const mctx     = minimap.getContext("2d");

// Stage helpers
function show(el, displayValue = "block"){ if (el) el.style.display = displayValue; }
function hide(el){ if (el) el.style.display = "none"; }
function setStage(stage) {
  if (stage === "instructions") { show(instructionsPage, "flex"); hide(lobbyEl); hide(overlay); }
  else if (stage === "lobby")   { hide(instructionsPage); show(lobbyEl, "flex"); hide(overlay); }
  else if (stage === "game")    { hide(instructionsPage); hide(lobbyEl); }
}

let style = null;
let MAP_SIZE = 800, PLAYER_RADIUS = 16;
let youArePlayer = false;

const names = {};
let serverPos = {};
let renderPos = {};
const anim = {};

const frameCbs = [];
const drawCbs  = [];
const keyDownCbs = [];
const keyUpCbs   = [];
const startCbs   = [];
function addDraw(fn, z=0){ drawCbs.push({z,fn}); drawCbs.sort((a,b)=>a.z-b.z); }

let dpr = window.devicePixelRatio || 1;
let scale = 1, offsetX = 0, offsetY = 0;

let socket;

// Room/grid/role
let roomCode = null;
let myRole   = null;
let grid = { W:5, H:5, start:{x:2,y:2} };
let visited = new Set([`2,2`]);
let explorerTile = { x:2,y:2 };
let foragerTile  = { x:2,y:2 };
let mapShared    = false;
let foragerTarget = null;

// Tile resource cache
const tileCache = new Map();

// Instructions
let instList = [], instIdx  = 0;

// Labels (0 none, 1 poor, 2 medium, 3 rich)
let labels = { explorer:{}, forager:{}, leader:{} };
let mapEdit = false;

// Utility to get viewer tile
function currentViewerTile() {
  if (myRole === "explorer") return explorerTile;
  if (myRole === "forager")  return foragerTile;
  return grid.start;
}

// GameCore (for plugins)
const GameCore = {
  onFrame(cb){ frameCbs.push(cb); },
  onDraw(cb, z=0){ addDraw(cb, z); },
  onKeyDown(cb){ keyDownCbs.push(cb); },
  onKeyUp(cb){ keyUpCbs.push(cb); },
  onStart(cb){ startCbs.push(cb); },

  get socket(){ return socket; },
  emit(event, payload){ socket?.emit(event, payload); },

  get localId(){ return socket?.id ?? null; },
  get youArePlayer(){ return youArePlayer; },
  get mapSize(){ return MAP_SIZE; },
  get playerRadius(){ return PLAYER_RADIUS; },
  get style(){ return style; },
  get names(){ return names; },
  get positions(){ return renderPos; },
  get anim(){ return anim; },

  measure(){ return { scale, dpr, MAP_SIZE, PLAYER_RADIUS }; },
  say(text){ socket?.emit("say", { text }); },
  toggleDance(on){ socket?.emit("dance", { on }); },

  _hello: null,
  getHello(){ return this._hello; },

    // NEW: phase accessors
  getPhase(){ return phase; },
  _setPhase(p){ phase = p; },
};
window.GameCore = GameCore;

// Cold start
async function wakeServer(maxSeconds = 120) {
  let delay = 800, waited = 0;
  while (waited < maxSeconds * 1000) {
    try { const res = await fetch(`/healthz?ts=${Date.now()}`, { cache: "no-store" });
      if (res.ok) { bootMsg.textContent = "Server is awake."; return; }
    } catch {}
    bootMsg.textContent = `Waking server… retry in ${Math.round(delay/1000)}s`;
    await new Promise(r => setTimeout(r, delay));
    waited += delay; delay = Math.min(Math.floor(delay*1.5), 2000);
  }
  bootMsg.textContent = "Still waking… please refresh.";
}
function connectSocketOnce() {
  return new Promise((resolve, reject) => {
    const s = io(window.location.origin, { transports: ["websocket","polling"], timeout: 60000, reconnection: false });
    s.on("connect", () => { socket = s; resolve(); });
    s.on("connect_error", (e) => { try { s.close(); } catch {} reject(e); });
  });
}
async function connectSocketWithRetry(attempts = 5) {
  for (let i=1;i<=attempts;i++){
    bootMsg.textContent = i===1 ? "Connecting…" : `Connecting… (retry ${i}/${attempts})`;
    try { await connectSocketOnce(); return; }
    catch { await new Promise(r=>setTimeout(r,1200)); }
  }
  throw new Error("Unable to connect.");
}

function bindSocketHandlers() {
  statusEl.textContent = "Connected.";

  socket.on("hello", (data) => {
    GameCore._hello = data;
    const cfg = data.config || {};
    MAP_SIZE      = cfg.MAP_SIZE ?? MAP_SIZE;
    PLAYER_RADIUS = cfg.PLAYER_RADIUS ?? PLAYER_RADIUS;
    youArePlayer  = !!data.youArePlayer;

    roomCode = data.room?.code ?? null;
    grid = data.grid || grid;
    visited = new Set([`${grid.start.x},${grid.start.y}`]);
    explorerTile = { ...grid.start };
    foragerTile  = { ...grid.start };
    mapShared = !!data.mapShared;

    serverPos = data.players || {};
    renderPos = {};
    for (const id in serverPos) {
      const p = serverPos[id];
      renderPos[id] = { x:p.x, y:p.y, color:p.color, name:p.name, role:p.role || null, tile: p.tile || { ...grid.start } };
      names[id] = p.name || "P?";
      anim[id]  = { t:0, lastX:p.x, lastY:p.y, speed:0, angle:0, moving:false, phase:0, danceScale:1, rateMul:1 };
    }
    statusEl.textContent = `Room ${roomCode || "?"} — waiting for 3 players to start`;
    resizeCanvas();
    drawMinimap();
  });

  socket.on("joined", ({ id, state }) => {
    serverPos[id] = { ...state };
    renderPos[id] = { ...state, tile: state.tile || { ...grid.start } };
    names[id]     = state.name || "P?";
    anim[id]      = { t:0, lastX:state.x, lastY:state.y, speed:0, angle:0, moving:false, phase:0, danceScale:1, rateMul:1 };
  });

  socket.on("left", ({ id }) => {
    delete serverPos[id];
    delete renderPos[id];
    delete names[id];
    delete anim[id];
  });

  socket.on("state", (players) => {
    serverPos = players;
    for (const id in serverPos) if (!names[id]) names[id] = serverPos[id].name || "P?";
  });

  socket.on("matchStarted", (payload) => {
    GameCore._setPhase("game"); 

    const roles = payload.roles || {};
    myRole = roles[socket.id] || null;
    grid = payload.grid || grid;

    hudLeader.classList.add("hidden");
    hudExplorer.classList.add("hidden");
    hudForager.classList.add("hidden");
    if (myRole === "leader")   hudLeader.classList.remove("hidden");
    if (myRole === "explorer") hudExplorer.classList.remove("hidden");
    if (myRole === "forager")  hudForager.classList.remove("hidden");

    setStage("game");
    applyResources(payload.resources);

    overlay.style.display = ""; startBtn.disabled = false;
  });

  // NEW: celebration mode (1x1 grid; enable talk/dance on client by phase)
  socket.on("celebrateStart", ({ grid: g, message }) => {
  alert(message || "You win!");

  GameCore._setPhase("celebration");
  grid = g || { W:1, H:1, start:{x:0,y:0} };
  visited = new Set([`${grid.start.x},${grid.start.y}`]);

// everyone’s viewer tile should be the new start so filtering doesn’t hide them
  explorerTile = { ...grid.start };
  foragerTile  = { ...grid.start };

  // hide role HUDs during party
  hudLeader.classList.add("hidden");
  hudExplorer.classList.add("hidden");
  hudForager.classList.add("hidden");

  tileCache.clear();
  drawMinimap();
  statusEl.textContent = "🎉 Celebration — press M to dance, Y to chat";
  });


  // NEW: loss flow — server will auto-reboot and then emit matchStarted again
  socket.on("lost", ({ role, message }) => {
    alert(message || `The ${role} is lost in the wild`);
    statusEl.textContent = "Rebooting match…";
    // We just wait; server immediately resets and calls startMatch again when ready.
  });

  socket.on("resources", (bundle) => { applyResources(bundle); });

  socket.on("tileUpdate", ({ role, tile, visited: vis }) => {
    if (role === "explorer") explorerTile = tile;
    if (role === "forager")  foragerTile  = tile;
    if (Array.isArray(vis)) visited = new Set(vis);
    drawMinimap();
  });

  socket.on("tileData", ({ x, y, points }) => { tileCache.set(`${x},${y}`, points || []); });
  socket.on("tileDataUpdate", ({ x, y, index, point }) => {
    const k = `${x},${y}`;
    const arr = tileCache.get(k) || [];
    if (index >= 0 && index < arr.length) { arr[index] = point; tileCache.set(k, arr); }
  });

  socket.on("labelsShared", ({ labels: fromExplorer }) => {
    if (myRole === "leader") { labels.explorer = { ...fromExplorer }; drawMinimap(); }
  });
  socket.on("labelsUpdate", ({ labels: newLabels }) => { labels = newLabels; drawMinimap(); });
  socket.on("foragerTarget", (target) => { foragerTarget = target; drawMinimap(); });
  socket.on("mapShared", () => { mapShared = true; });

  socket.on("matchEnded", ({ reason }) => { alert("Match ended: " + reason); });

  socket.on("disconnect", (reason) => statusEl.textContent = "Disconnected: " + reason);
  socket.on("connect_error", (err) => statusEl.textContent = "Connect error: " + err.message);
}

function applyResources(bundle) {
  if (!bundle) return;
  leaderGold.textContent = `Gold: ${Math.round(bundle.leader?.gold || 0)}`;
  leaderFood.textContent = `Food: ${Math.round(bundle.leader?.food || 0)}`;
  explorerFood.textContent = `Food: ${Math.round(bundle.explorer?.explorerFood || 0)}`;
  foragerFood.textContent = `Food: ${Math.round(bundle.forager?.foragerFood || 0)}`;
  foragerCarry.textContent= `Carrying: ${Math.round(bundle.forager?.foragerCarrying || 0)}`;
}

// Input
const keys = { up:false, down:false, left:false, right:false };
function handleMoveKey(e, isDown) {
  let handled = true;
  switch (e.key) {
    case "ArrowUp": case "w": case "W": keys.up = isDown; break;
    case "ArrowDown": case "s": case "S": keys.down = isDown; break;
    case "ArrowLeft": case "a": case "A": keys.left = isDown; break;
    case "ArrowRight": case "d": case "D": keys.right = isDown; break;
    default: handled = false;
  }
  if (handled) { e.preventDefault(); GameCore.emit("move", keys); }
}

function edgeDirForLocalPlayer() {
  const id = GameCore.localId; if (!id) return null;
  const p = renderPos[id]; if (!p) return null;
  const margin = 40;
  if (p.x <= PLAYER_RADIUS + margin) return "left";
  if (p.x >= MAP_SIZE - PLAYER_RADIUS - margin) return "right";
  if (p.y <= PLAYER_RADIUS + margin) return "up";
  if (p.y >= MAP_SIZE - PLAYER_RADIUS - margin) return "down";
  return null;
}

window.addEventListener("keydown", (e) => {
  for (const cb of keyDownCbs) { if (cb(e, GameCore) === true) return; }

  if (e.key === "e" || e.key === "E") { const dir = edgeDirForLocalPlayer(); if (dir) GameCore.emit("enterNeighbor", { dir }); return; }
  if (e.key === "q" || e.key === "Q") { if (myRole === "explorer") GameCore.emit("scanTile"); return; }
  if (e.key === "f" || e.key === "F") { GameCore.emit("farmConvert"); return; }
  if (e.key === " ") { if (myRole === "forager") GameCore.emit("collectResource"); return; }
  if (e.key === "v" || e.key === "V") { if (myRole === "forager") GameCore.emit("deliverToBase"); return; }
  if (e.key === "b" || e.key === "B") { mapEdit = !mapEdit; drawMinimap(); return; }

  handleMoveKey(e, true);
}, { passive:false });
window.addEventListener("keyup", (e) => { for (const cb of keyUpCbs) { if (cb(e, GameCore) === true) return; } handleMoveKey(e, false); }, { passive:false });

// Minimap drawing
function drawMinimap() {
  const sz = minimap.width;
  const cell = sz / grid.W;

  mctx.save();
  mctx.clearRect(0,0,sz,sz);
  mctx.fillStyle = "#0b1220"; mctx.fillRect(0,0,sz,sz);

  for (let y=0;y<grid.H;y++) for (let x=0;x<grid.W;x++){
    const k = `${x},${y}`;
    const v = visited.has(k);
    mctx.fillStyle = v ? "#334155" : "#111827";
    mctx.fillRect(x*cell, y*cell, cell-1, cell-1);

    const lab = labels.explorer[k] ?? labels.forager[k] ?? labels.leader[k] ?? 0;
    if (lab > 0) {
      mctx.globalAlpha = 0.6;
      mctx.fillStyle = lab === 1 ? "#ef4444" : lab === 2 ? "#f59e0b" : "#22c55e";
      mctx.fillRect(x*cell, y*cell, cell-1, cell-1);
      mctx.globalAlpha = 1;
    }
  }

  // start
  mctx.strokeStyle = "#f59e0b"; mctx.lineWidth = 2;
  mctx.strokeRect(grid.start.x*cell+1, grid.start.y*cell+1, cell-2, cell-2);

  // role markers
  mctx.fillStyle = "#60a5fa"; mctx.fillRect(explorerTile.x*cell+4, explorerTile.y*cell+4, cell-8, cell-8);
  mctx.fillStyle = "#f472b6"; mctx.fillRect(foragerTile.x*cell+6, foragerTile.y*cell+6, cell-12, cell-12);

  // forager target
  if (foragerTarget) { mctx.strokeStyle = "#a78bfa"; mctx.lineWidth = 2; mctx.strokeRect(foragerTarget.x*cell+2, foragerTarget.y*cell+2, cell-4, cell-4); }

  // edit badge
  mctx.font = "12px system-ui, sans-serif";
  mctx.fillStyle = mapEdit ? "#22c55e" : "#94a3b8";
  mctx.fillText(mapEdit ? "Map Edit: ON" : "Map Edit: OFF (B)", 6, sz - 8);

  mctx.restore();
}

// Minimap interaction
minimap.addEventListener("click", (e) => {
  if (!mapEdit) return;
  const rect = minimap.getBoundingClientRect();
  const cx = (e.clientX - rect.left) * (minimap.width / rect.width);
  const cy = (e.clientY - rect.top)  * (minimap.height / rect.height);
  const cell = minimap.width / grid.W;
  const x = Math.floor(cx / cell), y = Math.floor(cy / cell);
  if (x < 0 || y < 0 || x >= grid.W || y >= grid.H) return;

  if ((e.ctrlKey || e.metaKey) && myRole === "leader") {
    socket.emit("assignForagerTarget", { x, y });
  } else {
    const k = `${x},${y}`;
    const mine = labels[myRole] || {};
    const next = ((mine[k] || 0) + 1) % 4;
    mine[k] = next;
    labels[myRole] = mine;
    socket.emit("markTile", { x, y, label: next });
  }
  drawMinimap();
});

// Start overlay & fullscreen
async function goFullscreen() {
  const el = document.documentElement;
  try {
    if (!document.fullscreenElement && el.requestFullscreen) await el.requestFullscreen();
    else if (!document.fullscreenElement && el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  } catch {}
}
function lockScroll(on) {
  document.documentElement.style.overflow = on ? "hidden" : "";
  document.body.style.overflow = on ? "hidden" : "";
  document.documentElement.style.overscrollBehavior = on ? "none" : "";
  document.body.style.overscrollBehavior = on ? "none" : "";
}
startBtn.addEventListener("click", async () => {
  await goFullscreen();
  lockScroll(true);
  canvas.focus();
  socket?.emit("start");
  for (const cb of startCbs) cb();
  overlay.style.display = "none";
  resizeCanvas();
});

// Sizing / draw
window.addEventListener("resize", resizeCanvas);
document.addEventListener("fullscreenchange", resizeCanvas);

function resizeCanvas() {
  const vw = window.innerWidth, vh = window.innerHeight;
  dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${vw - 220}px`; // reserve sidebar
  canvas.style.height = `${vh}px`;
  canvas.width  = Math.floor((vw - 220) * dpr);
  canvas.height = Math.floor(vh * dpr);

  scale = Math.min((vw - 220) / MAP_SIZE, vh / MAP_SIZE);
  const drawW = MAP_SIZE * scale, drawH = MAP_SIZE * scale;
  offsetX = ((vw - 220) - drawW) / 2;
  offsetY = (vh - drawH) / 2;
  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, offsetX * dpr, offsetY * dpr);
}

function clearScreen() {
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, offsetX * dpr, offsetY * dpr);
}

// Tile-specific fallback background
function drawFallbackBackground() {
  const tile = currentViewerTile();
  const seed = (tile.x * 73856093) ^ (tile.y * 19349663);
  const hue = (seed % 360 + 360) % 360;

  ctx.save();
  ctx.fillStyle = `hsl(${hue}, 25%, 12%)`;
  ctx.fillRect(0,0,MAP_SIZE,MAP_SIZE);

  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1 / (scale * dpr);
  const step = 40;
  for (let x = 0; x <= MAP_SIZE; x += step) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,MAP_SIZE); ctx.stroke(); }
  for (let y = 0; y <= MAP_SIZE; y += step) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(MAP_SIZE,y); ctx.stroke(); }

  ctx.globalAlpha = 0.25;
  ctx.fillStyle = "#e5e7eb";
  ctx.font = `${72/(scale*dpr)}px system-ui, sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(`Tile ${tile.x},${tile.y}`, MAP_SIZE/2, MAP_SIZE/2);
  ctx.restore();
}

// Farmer circle (draw only on center tile)
function drawFarmer(ctx2) {
  const r = 80;
  ctx2.save();
  ctx2.beginPath(); ctx2.arc(400,400,r,0,Math.PI*2);
  ctx2.strokeStyle = "#9ca3af";
  ctx2.lineWidth = 2 / (scale * dpr);
  ctx2.stroke();
  ctx2.font = `${14/(scale*dpr)}px system-ui,sans-serif`;
  ctx2.textAlign = "center"; ctx2.textBaseline = "middle";
  ctx2.fillStyle = "#d1d5db"; ctx2.fillText("Farmer", 400, 400);
  ctx2.restore();
}

// Draw resources for current tile
function drawResources() {
  if (phase !== "game") return;
  const tile = currentViewerTile();
  const k = `${tile.x},${tile.y}`;
  const points = tileCache.get(k) || [];
  const R = 16;

  ctx.save();
  for (const pt of points) {
    if (pt.remaining <= 0) continue;

    if (!pt.revealed) {
      ctx.beginPath(); ctx.arc(pt.x, pt.y, R, 0, Math.PI*2);
      ctx.fillStyle = "rgba(148,163,184,0.5)";
      ctx.fill();
      ctx.font = `${14/(scale*dpr)}px system-ui,sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = "#e5e7eb"; ctx.fillText("?", pt.x, pt.y);
    } else {
      const r = pt.richness;
      const color = r <= 2 ? "#ef4444" : (r === 3 ? "#f59e0b" : "#22c55e");
      ctx.beginPath(); ctx.arc(pt.x, pt.y, R, 0, Math.PI*2);
      ctx.fillStyle = color; ctx.globalAlpha = 0.7; ctx.fill(); ctx.globalAlpha = 1;
      ctx.strokeStyle = "#111827"; ctx.lineWidth = 2 / (scale * dpr); ctx.stroke();

      ctx.font = `${12/(scale*dpr)}px system-ui,sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.fillStyle = "#111827"; ctx.fillText(`${pt.remaining}`, pt.x, pt.y + R + 2/(scale*dpr));
    }
  }
  ctx.restore();
}

function drawPlayers() {
  const myTile = currentViewerTile();
  ctx.save();
  for (const id in renderPos) {
    const p = renderPos[id];
    const t = p.tile || grid.start;
    if (t.x !== myTile.x || t.y !== myTile.y) continue; // <-- show only same-tile players

    const seatIdx = Math.max(0, (parseInt((p.name || "").replace(/\D/g,"") || "1", 10)-1));
    const sprite  = style?.getPlayerSprite?.(seatIdx, p.color, PLAYER_RADIUS);
    const state   = anim[id] || { t:0, moving:false, speed:0, angle:0, phase:0, danceScale:1, rateMul:1 };

    const worldW = PLAYER_RADIUS*2;
    if (sprite?.draw) {
      sprite.draw(ctx, p.x, p.y, worldW, state);
    } else {
      ctx.beginPath(); ctx.arc(p.x, p.y, PLAYER_RADIUS, 0, Math.PI*2);
      ctx.fillStyle = p.color || "#94a3b8"; ctx.fill();
    }

    const px = 14/(scale*dpr);
    ctx.font = `${px}px system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillStyle = "#e5e7eb";
    const roleBadge = p.role ? ` (${p.role[0].toUpperCase()})` : "";
    ctx.fillText((names[id]||"P?") + roleBadge, p.x, p.y + PLAYER_RADIUS + (4/(scale*dpr)));
  }
  ctx.restore();
}

// Loop
let lastTs = performance.now();
function animate(ts) {
  const dt = Math.min(0.05, (ts - lastTs)/1000);
  lastTs = ts;

 // --- run per-frame plugin logic (dance timers, bubble lifetimes, etc.)
  for (const cb of frameCbs) { try { cb(dt, GameCore); } catch {} }
  for (const id in serverPos) {
    const s = serverPos[id];
    const a = anim[id] || (anim[id] = { t:0, lastX:s.x, lastY:s.y, speed:0, angle:0, moving:false, phase:0, danceScale:1, rateMul:1 });
    const dx = s.x - a.lastX, dy = s.y - a.lastY;
    const dist = Math.hypot(dx,dy), spd = dt>0 ? dist/dt : 0;
    a.speed = spd; a.angle = Math.atan2(dy,dx); a.moving = spd>5; a.t += dt;
    a.phase += (a.moving ? 8 : 2.5) * dt;
    a.lastX = s.x; a.lastY = s.y;
  }
  for (const id in anim) if (!serverPos[id]) delete anim[id];

  const k = 1 - Math.exp(-20 * dt);
  for (const id in serverPos) {
    const s = serverPos[id];
    const r = renderPos[id] || (renderPos[id] = { x:s.x, y:s.y, color:s.color, name:s.name, role:s.role, tile: s.tile || { ...grid.start } });
    r.x += (s.x - r.x)*k; r.y += (s.y - r.y)*k;
    r.color = s.color; r.name = s.name; r.role = s.role; r.tile = s.tile || r.tile;
  }
  for (const id in renderPos) if (!serverPos[id]) delete renderPos[id];

  clearScreen();
  if (style?.drawBackground) style.drawBackground(ctx, MAP_SIZE); else drawFallbackBackground();

  drawResources();

  // Draw farmer only on center tile
  const t = currentViewerTile();
  if (t.x === grid.start.x && t.y === grid.start.y) drawFarmer(ctx);

// --- draw plugins that want to be BEHIND players (e.g., dance aura z < 0)
  for (const layer of drawCbs) {
    if (layer.z < 0) { try { layer.fn(ctx, GameCore); } catch {} }
  }

  drawPlayers();

   // --- draw plugins that want to be ABOVE players (e.g., talk bubbles z >= 0)
  for (const layer of drawCbs) {
    if (layer.z >= 0) { try { layer.fn(ctx, GameCore); } catch {} }
  }

  requestAnimationFrame(animate);
}
resizeCanvas();
requestAnimationFrame(animate);

// Instructions slider
async function loadInstructions() {
  try {
    const res = await fetch("/api/instructions");
    const data = await res.json();
    instList = Array.isArray(data.images) ? data.images : [];
    instIdx = 0; renderInst();
  } catch { instList = []; renderInst(); }
}
function renderInst() {
  if (!instList.length) { instWrap && (instWrap.style.display = "none"); instImg?.removeAttribute("src"); return; }
  instWrap && (instWrap.style.display = ""); instImg.src = instList[instIdx];
}
instPrev.addEventListener("click", () => { if (!instList.length) return; instIdx = (instIdx - 1 + instList.length) % instList.length; renderInst(); });
instNext.addEventListener("click", () => { if (!instList.length) return; instIdx = (instIdx + 1) % instList.length; renderInst(); });
instContinue.addEventListener("click", () => setStage("lobby"));

// Create / Join
createBtn.addEventListener("click", () => {
  socket.emit("createRoom", null, (resp) => {
    if (!resp?.ok) { alert(resp?.error || "Failed to create"); return; }
    codeShow.textContent = resp.code; codeInput.value = resp.code;
  });
});
joinBtn.addEventListener("click", () => {
  const code = (codeInput.value || "").trim().toUpperCase();
  if (!code) return;
  socket.emit("joinRoom", { code }, (resp) => {
    if (!resp?.ok) { alert(resp?.error || "Join failed"); return; }
    codeShow.textContent = code;
  });
});

// Leader allocation form
giveFoodBtn.addEventListener("click", (e) => {
  e.preventDefault();
  const exp = parseInt(giveFoodExplorer.value || "0", 10);
  const forr = parseInt(giveFoodForager.value  || "0", 10);
  if ((exp > 0 || forr > 0)) socket.emit("allocateFood", { explorer: exp||0, forager: forr||0 });
  giveFoodExplorer.value = ""; giveFoodForager.value = "";
});

// Boot
(async () => {
  boot.classList.remove("hidden");
  bootMsg.textContent = "Waking server…";

  const stylePromise = loadStyle(THEMES.grass).catch(() => loadStyle(THEMES.isaacish));
  await wakeServer(120).catch(()=>{});
  try {
    await connectSocketWithRetry(5);
    bindSocketHandlers();
    style = await stylePromise;

    await loadInstructions();
    setStage("instructions");

    boot.classList.add("hidden");
  } catch {
    bootMsg.textContent = "Failed to connect. Please refresh.";
  }
})();
