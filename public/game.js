import { loadStyle, THEMES } from "./style.js";

// Elements
const canvas   = document.getElementById("game");
const ctx      = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const overlay  = document.getElementById("overlay");
const startBtn = document.getElementById("startBtn");

// Boot/wait overlay
const boot    = document.getElementById("boot");
const bootMsg = document.getElementById("bootMsg");

// Chat choice menu (left of screen)
const choiceEl = document.getElementById("choice");
const OPT1_TEXT = document.getElementById("opt1")?.textContent || "Hi";
const OPT2_TEXT = document.getElementById("opt2")?.textContent || "Jerry is the best";

// Focusable canvas
canvas.tabIndex = 0;

// ----- State -----
let style = null; // { drawBackground, getPlayerSprite, speedMul }
let MAP_SIZE = 800, PLAYER_RADIUS = 16;
let youArePlayer = false;
const keys = { up:false, down:false, left:false, right:false };
const names = {};
let serverPos = {};  // authoritative snapshot from server
let renderPos = {};  // smoothed positions for rendering

// Per-player animation state (continuous phase)
/// anim[id] = { t, lastX, lastY, speed, angle, moving, phase }
const anim = {};
// Speech bubbles: id -> { text, t0, dur }
const bubbles = {};
// Chat menu state
let chatOpen = false;

// HiDPI scaling
let dpr = window.devicePixelRatio || 1;
let scale = 1, offsetX = 0, offsetY = 0;

// ==============================
// Cold-start helper
// ==============================
async function wakeServer(maxSeconds = 120) {
  let delay = 800; let waited = 0;
  while (waited < maxSeconds * 1000) {
    try {
      const res = await fetch(`/healthz?ts=${Date.now()}`, { cache: "no-store" });
      if (res.ok) { bootMsg.textContent = "Server is awake."; return; }
    } catch {}
    bootMsg.textContent = `Waking server… retry in ${Math.round(delay/1000)}s`;
    await new Promise(r => setTimeout(r, delay));
    waited += delay;
    delay = Math.min(Math.floor(delay * 1.5), 2000);
  }
  bootMsg.textContent = "Still waking… please wait or refresh.";
}

// ==============================
// Socket connection
// ==============================
let socket;

function connectSocketOnce() {
  return new Promise((resolve, reject) => {
    const s = io(window.location.origin, {
      transports: ["websocket", "polling"],
      timeout: 60000,
      reconnection: false
    });
    s.on("connect", () => { socket = s; resolve(); });
    s.on("connect_error", (e) => { try { s.close(); } catch {} reject(e); });
  });
}

async function connectSocketWithRetry(attempts = 5) {
  for (let i = 1; i <= attempts; i++) {
    bootMsg.textContent = i === 1 ? "Connecting…" : `Connecting… (retry ${i}/${attempts})`;
    try { await connectSocketOnce(); return; }
    catch { await new Promise(r => setTimeout(r, 1200)); }
  }
  throw new Error("Unable to connect to server.");
}

function bindSocketHandlers() {
  socket.on("connect", () => statusEl.textContent = "Connected. Waiting for players…");
  socket.on("connect_error", (err) => statusEl.textContent = "Connect error: " + err.message);
  socket.on("disconnect", (reason) => statusEl.textContent = "Disconnected: " + reason);

  socket.on("hello", (data) => {
    const cfg = data.config || {};
    MAP_SIZE      = cfg.MAP_SIZE ?? MAP_SIZE;
    PLAYER_RADIUS = cfg.PLAYER_RADIUS ?? PLAYER_RADIUS;
    youArePlayer  = !!data.youArePlayer;

    serverPos = data.players || {};
    renderPos = {};
    for (const id in serverPos) {
      const p = serverPos[id];
      renderPos[id] = { x: p.x, y: p.y, color: p.color, name: p.name };
      names[id] = p.name || "P?";
      anim[id]  = { t: 0, lastX: p.x, lastY: p.y, speed: 0, angle: 0, moving: false, phase: 0 };
    }
    statusEl.textContent = youArePlayer ? "You are a player." : "Spectating (max 3 players).";
    resizeCanvas();
  });

  socket.on("joined", ({ id, state }) => {
    serverPos[id] = { ...state };
    renderPos[id] = { ...state };
    names[id]     = state.name || "P?";
    anim[id]      = { t: 0, lastX: state.x, lastY: state.y, speed: 0, angle: 0, moving: false, phase: 0 };
  });

  socket.on("left", ({ id }) => {
    delete serverPos[id];
    delete renderPos[id];
    delete names[id];
    delete anim[id];
    delete bubbles[id];
  });

  // Receive chat bubble
  socket.on("say", ({ id, text }) => {
    addSpeechBubble(id, text);
  });

  socket.on("state", (players) => {
    serverPos = players;
    for (const id in serverPos) if (!names[id]) names[id] = serverPos[id].name || "P?";
  });
}

// ==============================
// Input
// ==============================

// Movement keys
function handleMoveKey(e, isDown) {
  let handled = true;
  switch (e.key) {
    case "ArrowUp": case "w": case "W": keys.up = isDown; break;
    case "ArrowDown": case "s": case "S": keys.down = isDown; break;
    case "ArrowLeft": case "a": case "A": keys.left = isDown; break;
    case "ArrowRight": case "d": case "D": keys.right = isDown; break;
    default: handled = false;
  }
  if (handled) {
    e.preventDefault();
    if (youArePlayer && socket) socket.emit("move", keys);
  }
}
window.addEventListener("keydown", (e) => handleMoveKey(e, true),  { passive:false });
window.addEventListener("keyup",   (e) => handleMoveKey(e, false), { passive:false });

// Chat hotkeys
function toggleChat(show) {
  chatOpen = show;
  choiceEl.style.display = chatOpen ? "block" : "none";
}
function say(text) {
  if (!socket) return;
  socket.emit("say", { text });
  // optimistic bubble for local user
  if (socket.id) addSpeechBubble(socket.id, text);
}
function addSpeechBubble(id, text) {
  bubbles[id] = { text, t0: performance.now(), dur: 2600 };
}

window.addEventListener("keydown", (e) => {
  const k = e.key;
  // Toggle menu
  if (k === "y" || k === "Y") {
    toggleChat(!chatOpen);
    e.preventDefault();
    return;
  }
  if (!chatOpen) return;
  // Choose option
  if (k === "1") {
    say(OPT1_TEXT);
    toggleChat(false);
    e.preventDefault();
  } else if (k === "2") {
    say(OPT2_TEXT);
    toggleChat(false);
    e.preventDefault();
  } else if (k === "Escape") {
    toggleChat(false);
    e.preventDefault();
  }
}, { passive:false });

// ==============================
// Start overlay / fullscreen
// ==============================
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
  if (socket) socket.emit("start");
  overlay.style.display = "none";
  resizeCanvas();
});
document.addEventListener("fullscreenchange", () => lockScroll(!!document.fullscreenElement));
document.addEventListener("webkitfullscreenchange", () => lockScroll(!!document.webkitFullscreenElement));

// ==============================
// Sizing / HiDPI
// ==============================
window.addEventListener("resize", resizeCanvas);
document.addEventListener("fullscreenchange", resizeCanvas);

function resizeCanvas() {
  const vw = window.innerWidth, vh = window.innerHeight;
  dpr = window.devicePixelRatio || 1;

  canvas.style.width = `${vw}px`;
  canvas.style.height = `${vh}px`;
  canvas.width  = Math.floor(vw * dpr);
  canvas.height = Math.floor(vh * dpr);

  scale = Math.min(vw / MAP_SIZE, vh / MAP_SIZE);
  const drawW = MAP_SIZE * scale, drawH = MAP_SIZE * scale;
  offsetX = (vw - drawW) / 2;
  offsetY = (vh - drawH) / 2;

  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, offsetX * dpr, offsetY * dpr);
}

// ==============================
// Drawing
// ==============================
function clearScreen() {
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, offsetX * dpr, offsetY * dpr);
}

function drawGrid() {
  const step = 50;
  ctx.save();
  ctx.lineWidth = 1 / (scale * dpr);
  ctx.strokeStyle = "#1f2937";
  for (let x = step; x < MAP_SIZE; x += step) {
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,MAP_SIZE); ctx.stroke();
  }
  for (let y = step; y < MAP_SIZE; y += step) {
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(MAP_SIZE,y); ctx.stroke();
  }
  ctx.lineWidth = 3 / (scale * dpr);
  ctx.strokeStyle = "#334155";
  ctx.strokeRect(1.5,1.5,MAP_SIZE-3,MAP_SIZE-3);
  ctx.restore();
}

function drawPlayers() {
  ctx.save();
  for (const id in renderPos) {
    const p = renderPos[id];
    const seatIdx = Math.max(0, (parseInt((p.name || "").replace(/\D/g, "") || "1", 10) - 1));
    const sprite  = style?.getPlayerSprite?.(seatIdx, p.color, PLAYER_RADIUS);
    const state   = anim[id] || { t: 0, moving: false, speed: 0, angle: 0, phase: 0 };

    const worldW = PLAYER_RADIUS * 2;
    if (sprite?.draw) {
      sprite.draw(ctx, p.x, p.y, worldW, state);
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, PLAYER_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = p.color || "#aaa";
      ctx.fill();
    }

    // Name label
    const px = 14 / (scale * dpr);
    ctx.font = `${px}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText(names[id] || "P?", p.x, p.y + PLAYER_RADIUS + (4 / (scale * dpr)));
  }
  ctx.restore();
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, h/2, w/2);
  ctx.beginPath();
  ctx.moveTo(x+rr, y);
  ctx.arcTo(x+w, y,   x+w, y+h, rr);
  ctx.arcTo(x+w, y+h, x,   y+h, rr);
  ctx.arcTo(x,   y+h, x,   y,   rr);
  ctx.arcTo(x,   y,   x+w, y,   rr);
  ctx.closePath();
}

function drawBubbles() {
  const now = performance.now();
  for (const id in bubbles) {
    const b = bubbles[id];
    if (!b) continue;
    const age = now - b.t0;
    if (age > b.dur) { delete bubbles[id]; continue; }
    const p = renderPos[id];
    if (!p) continue;

    // Text metrics in world units
    const px = 16 / (scale * dpr);
    ctx.font = `${px}px system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    const text = b.text;
    const m = ctx.measureText(text);
    const pad = 8 / (scale * dpr);
    const w = m.width + pad * 2;
    const h = px + pad * 2;

    const margin = 8 / (scale * dpr);
    const bx = p.x - w/2;
    const by = p.y - PLAYER_RADIUS - margin - h;

    // Bubble box
    ctx.save();
    ctx.lineWidth = 1 / (scale * dpr);
    roundRectPath(ctx, bx, by, w, h, 8 / (scale * dpr));
    ctx.fillStyle = "rgba(17,24,39,0.95)"; // #111827
    ctx.fill();
    ctx.strokeStyle = "#334155";
    ctx.stroke();

    // Tail
    const tailW = 10 / (scale * dpr);
    const tailH = 8 / (scale * dpr);
    ctx.beginPath();
    ctx.moveTo(p.x - tailW/2, by + h);
    ctx.lineTo(p.x + tailW/2, by + h);
    ctx.lineTo(p.x, by + h + tailH);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Text
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText(text, bx + pad, by + h/2);

    ctx.restore();
  }
}

// ==============================
// 60 FPS render with smoothing + continuous phase
// ==============================
let lastTs = performance.now();
function animate(ts) {
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;

  // --- Update animation state from authoritative positions ---
  for (const id in serverPos) {
    const s = serverPos[id];
    const a = anim[id] || (anim[id] = { t: 0, lastX: s.x, lastY: s.y, speed: 0, angle: 0, moving: false, phase: 0 });

    const dx = s.x - a.lastX;
    const dy = s.y - a.lastY;
    const dist = Math.hypot(dx, dy);
    const spd  = dt > 0 ? dist / dt : 0; // px/s
    a.speed  = spd;
    a.angle  = Math.atan2(dy, dx);
    a.moving = spd > 5;
    a.t     += dt;

    // Continuous frame phase (never resets)
    const speedMul = style?.speedMul ?? 1;
    const spdNorm  = Math.max(0.6, Math.min(1.2, spd / 360));
    const baseWalkFps = 8;
    const baseIdleFps = 2.5;
    const rate = (a.moving ? (baseWalkFps * spdNorm) : baseIdleFps) * speedMul;
    a.phase += rate * dt;

    a.lastX = s.x;
    a.lastY = s.y;
  }
  for (const id in anim) {
    if (!serverPos[id]) delete anim[id];
  }

  // --- Smooth render positions toward server ---
  const lambda = 20;
  const k = 1 - Math.exp(-lambda * dt);

  for (const id in serverPos) {
    const s = serverPos[id];
    if (!renderPos[id]) renderPos[id] = { x: s.x, y: s.y, color: s.color, name: s.name };
    const r = renderPos[id];
    r.x += (s.x - r.x) * k;
    r.y += (s.y - r.y) * k;
    r.color = s.color; r.name = s.name;
  }
  for (const id in renderPos) {
    if (!serverPos[id]) delete renderPos[id];
  }

  // --- Draw ---
  clearScreen();
  if (style?.drawBackground) style.drawBackground(ctx, MAP_SIZE);
  drawGrid();
  drawPlayers();
  drawBubbles(); // on top
  requestAnimationFrame(animate);
}
resizeCanvas();
requestAnimationFrame(animate);

// ==============================
// Boot
// ==============================
(async () => {
  boot.classList.remove("hidden");
  bootMsg.textContent = "Waking server…";

  const stylePromise = loadStyle(THEMES.isaacish).catch(() => loadStyle(THEMES.cuteBlob));

  await wakeServer(120).catch(()=>{});

  try {
    await connectSocketWithRetry(5);
    bindSocketHandlers();

    style = await stylePromise;  // includes speedMul

    boot.classList.add("hidden");
  } catch {
    bootMsg.textContent = "Failed to connect. Please refresh in a moment.";
  }
})();
