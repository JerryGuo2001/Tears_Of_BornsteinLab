// public/style.js
// Style + animation with optional sprite sheet.
// Adds theme.animSpeed and uses continuous phase (no frame resets).

class AssetLoader {
  constructor() { this.cache = new Map(); }
  loadImage(src) {
    if (this.cache.has(src)) return this.cache.get(src);
    const p = new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => (img.decode?.() ?? Promise.resolve()).finally(() => resolve(img));
      img.onerror = reject;
      const bust = window.__BUILD_ID__ || String(Date.now()).slice(-6);
      img.src = src.includes("?") ? `${src}&v=${bust}` : `${src}?v=${bust}`;
    });
    this.cache.set(src, p);
    return p;
  }
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

class AnimatedSheetSprite {
  constructor(img, cfg) {
    this.img = img;
    this.cfg = Object.assign({
      frames: 4,
      fps: 8,
      rows: { down: 0, left: 1, right: 2, up: 3 },
      frameW: img.width,
      frameH: img.height,
      anchor: "center",
      speedMul: 1
    }, cfg || {});
    const a = this.cfg.anchor;
    this.ax = a === "center" ? 0.5 : Array.isArray(a) ? a[0] : 0;
    this.ay = a === "center" ? 0.5 : Array.isArray(a) ? a[1] : 0;
  }

  facingFromAngle(rad) {
    const d = (rad + Math.PI * 2) % (Math.PI * 2);
    if (d >= Math.PI * 3/4 && d < Math.PI * 5/4) return "left";
    if (d >= Math.PI / 4 && d < Math.PI * 3/4)   return "down";
    if (d >= Math.PI * 5/4 && d < Math.PI * 7/4) return "up";
    return "right";
  }

  draw(ctx, x, y, worldW, state = {}) {
    // state: { t, moving, speed, angle, phase }
    const { frameW, frameH, frames, fps, rows, speedMul } = this.cfg;

    // Frame index from a continuous phase that the game updates: phase += rate*dt
    const framePhase = (state.phase ?? 0) * speedMul; // <-- never resets
    const frame = Math.floor(framePhase) % frames;

    // Bob/squash use a gentle time-based phase (not framePhase)
    const spd = clamp((state.speed || 0) / 360, 0.6, 1.2);
    const phaseBob = (state.t || 0) * (state.moving ? 4.0 * spd : 1.6) * speedMul;
    const squash   = state.moving ? 1 + 0.03 * Math.sin(phaseBob) : 1 + 0.015 * Math.sin(phaseBob);
    const stretch  = state.moving ? 1 - 0.03 * Math.sin(phaseBob) : 1 - 0.015 * Math.sin(phaseBob);

    const facing = state.angle != null ? this.facingFromAngle(state.angle) : "down";
    const rowIdx = rows[facing] ?? rows.down ?? 0;

    const dw = worldW;
    const dh = dw * (frameH / frameW);
    const sx = frame * frameW;
    const sy = rowIdx * frameH;

    ctx.save();
    ctx.translate(x, y + (state.moving ? 0 : Math.sin(phaseBob) * 1));
    ctx.scale(squash, stretch);
    ctx.drawImage(this.img, sx, sy, frameW, frameH, -dw * this.ax, -dh * this.ay, dw, dh);
    ctx.restore();
  }
}

class BlobDude {
  constructor({ color = "#3b82f6", radius = 16, speedMul = 1 } = {}) {
    this.color = color;
    this.radius = radius;
    this.speedMul = speedMul;
  }
  draw(ctx, x, y, worldW, state = {}) {
    const R = worldW / 2;
    const t = state.t || 0;
    const spd = clamp((state.speed || 0) / 360, 0, 1.2);

    // Eyes-only blob. Animation phase is continuous and provided by the game.
    const phaseBob = t * (state.moving ? 3.8 * (1 + spd * 0.5) : 1.6) * this.speedMul;
    const sx = 1 + 0.035 * Math.sin(phaseBob);
    const sy = 1 - 0.035 * Math.sin(phaseBob);

    ctx.save();
    ctx.translate(x, y + (state.moving ? 0 : Math.sin(phaseBob) * 1));
    ctx.scale(sx, sy);

    // Body
    ctx.beginPath();
    ctx.fillStyle = this.color;
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.fill();

    // Eyes only
    ctx.fillStyle = "#111827";
    const eyeOffsetX = R * 0.34;
    const eyeOffsetY = -R * 0.1;
    const eyeR = R * 0.13;
    ctx.beginPath(); ctx.arc(-eyeOffsetX, eyeOffsetY, eyeR, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc( eyeOffsetX, eyeOffsetY, eyeR, 0, Math.PI*2); ctx.fill();

    ctx.restore();
  }
}

export async function loadStyle(theme) {
  const loader   = new AssetLoader();
  const speedMul = theme?.animSpeed ?? 2;

  // Background
  let bgImg = null;
  if (theme?.background?.src) {
    try { bgImg = await loader.loadImage(theme.background.src); } catch {}
  }
  const drawBackground = (ctx, mapSize) => {
    if (bgImg) ctx.drawImage(bgImg, 0, 0, mapSize, mapSize);
  };

  // Player art (cache per seat for stability & perf)
  let sheetImg = null;
  let sheetCfg = null;
  if (theme?.player?.sheet?.src) {
    try {
      sheetImg = await loader.loadImage(theme.player.sheet.src);
      sheetCfg = Object.assign({}, theme.player.sheet, { speedMul });
    } catch {/* fall back */}
  }
  const playerCache = new Map(); // seatIndex -> sprite instance

  const getPlayerSprite = (seatIndex = 0, color = "#3b82f6", radius = 16) => {
    if (playerCache.has(seatIndex)) return playerCache.get(seatIndex);

    let sprite;
    if (sheetImg && sheetCfg) {
      sprite = new AnimatedSheetSprite(sheetImg, sheetCfg);
    } else {
      const palette = [color, "#10b981", "#f59e0b", "#e879f9"];
      sprite = new BlobDude({ color: palette[seatIndex % palette.length], radius, speedMul });
    }
    playerCache.set(seatIndex, sprite);
    return sprite;
  };

  // Expose speedMul so the game can advance a continuous phase
  return { drawBackground, getPlayerSprite, speedMul };
}

// Default themes
export const THEMES = {
  cuteBlob: {
    animSpeed: 3, // <1 slower, >1 faster
    player: { fallbackColor: "#60a5fa" }
  },
  isaacish: {
    animSpeed: 3,
    background: { src: "assets/grass.png" }, // optional
    player: {
      sheet: {
        src: "assets/isaac_sheet.png",
        frameW: 32, frameH: 32,
        frames: 4,
        rows: { down:0, left:1, right:2, up:3 },
        fps: 8,
        anchor: "center"
      }
    }
  }
};
