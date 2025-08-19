// public/game.js

// Elements
const canvas   = document.getElementById("game");
const ctx      = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const overlay  = document.getElementById("overlay");
const startBtn = document.getElementById("startBtn");

// Boot/wait overlay (for Render Free cold starts)
const boot    = document.getElementById("boot");
const bootMsg = document.getElementById("bootMsg");

// Make canvas focusable for key events
canvas.tabIndex = 0;

// ----- State -----
let MAP_SIZE = 800, PLAYER_RADIUS = 16;
let youArePlayer = false;
const keys = { up:false, down:false, left:false, right:false };
const names = {};
let serverPos = {};  // authoritative snapshot from server
let renderPos = {};  // smoothed positions for rendering

// HiDPI scaling
let dpr = window.devicePixelRatio || 1;
let scale = 1, offsetX = 0, offsetY = 0;

// ==============================
// Cold-start helper: wake server
// ==============================
async function wakeServer(maxSeconds = 120) {
  let delay = 800; // ms
  let waited = 0;
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
// Socket connection with retries
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
    MAP_SIZE = cfg.MAP_SIZE ?? MAP_SIZE;
    PLAYER_RADIUS = cfg.PLAYER_RADIUS ?? PLAYER_RADIUS;
    youArePlayer = !!data.youArePlayer;

    serverPos = data.players || {};
    renderPos = {};
    for (const id in serverPos) {
      const p = serverPos[id];
      renderPos[id] = { x: p.x, y: p.y, color: p.color, name: p.name };
      names[id] = p.name || "P?";
    }
    statusEl.textContent = youArePlayer ? "You are a player." : "Spectating (max 3 players).";
    resizeCanvas();
  });

  socket.on("joined", ({ id, state }) => {
    serverPos[id] = { ...state };
    renderPos[id] = { ...state };
    names[id] = state.name || "P?";
  });

  socket.on("left", ({ id }) => {
    delete serverPos[id];
    delete renderPos[id];
    delete names[id];
  });

  socket.on("state", (players) => {
    serverPos = players;
    for (const id in serverPos) if (!names[id]) names[id] = serverPos[id].name || "P?";
  });
}

// ==============================
// Input (prevent page scrolling)
// ==============================
function handleKey(e, isDown) {
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
window.addEventListener("keydown", (e) => handleKey(e, true),  { passive:false });
window.addEventListener("keyup",   (e) => handleKey(e, false), { passive:false });

// ==============================
// Start overlay / fullscreen
// ==============================
async function goFullscreen() {
  if (!document.fullscreenElement) {
    try { await document.documentElement.requestFullscreen(); } catch {}
  }
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
  if (socket) socket.emit("start"); // server owns params
  overlay.style.display = "none";
  resizeCanvas();
});

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
  canvas.width = Math.floor(vw * dpr);
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
    ctx.beginPath();
    ctx.arc(p.x, p.y, PLAYER_RADIUS, 0, Math.PI*2);
    ctx.fillStyle = p.color || "#aaa";
    ctx.fill();

    const px = 14 / (scale * dpr);
    ctx.font = `${px}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText(names[id] || "P?", p.x, p.y + PLAYER_RADIUS + (4 / (scale * dpr)));
  }
  ctx.restore();
}

// ==============================
// 60 FPS render with snappy smoothing
// ==============================
let lastTs = performance.now();
function animate(ts) {
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;

  const lambda = 20; // higher => snappier toward server
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

  clearScreen();
  drawGrid();
  drawPlayers();
  requestAnimationFrame(animate);
}
resizeCanvas();
requestAnimationFrame(animate);

// ==============================
// Boot: wake then connect, then hide loader
// ==============================
(async () => {
  boot.classList.remove("hidden");
  bootMsg.textContent = "Waking server…";

  await wakeServer(120).catch(()=>{});

  try {
    await connectSocketWithRetry(5);
    bindSocketHandlers();
    boot.classList.add("hidden");
  } catch {
    bootMsg.textContent = "Failed to connect. Please refresh in a moment.";
  }
})();
