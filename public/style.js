// public/style.js
// Visuals: background draw modes, sprite/blob with gentle bob, ground shadow,
// animSpeed control, and optional music (for dance mode).

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

function drawGroundShadow(ctx, x, y, worldW, intensity = 1) {
  const rx = worldW * (0.55 + 0.10 * (intensity - 1));
  const ry = worldW * 0.25;
  const yOff = worldW * 0.45;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.32)";
  ctx.beginPath();
  if (ctx.ellipse) {
    ctx.ellipse(x, y + yOff, rx, ry, 0, 0, Math.PI * 2);
  } else {
    ctx.translate(x, y + yOff);
    ctx.scale(rx / (worldW * 0.5), ry / (worldW * 0.5));
    ctx.arc(0, 0, worldW * 0.5, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.restore();
}

class AnimatedSheetSprite {
  constructor(img, cfg) {
    this.img = img;
    this.cfg = Object.assign({
      frames: 4,
      fps: 8,
      rows: { down:0, left:1, right:2, up:3 },
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
    const { frameW, frameH, frames, rows, speedMul } = this.cfg;

    // Continuous frame index (phase advanced by game)
    const frame = Math.floor((state.phase ?? 0) * speedMul) % frames;

    // Gentle bob/squash/stretch
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

    const scalePulse = state.danceScale ?? 1;

    // Ground shadow first
    drawGroundShadow(ctx, x, y, worldW, scalePulse);

    // Sprite
    ctx.save();
    ctx.translate(x, y + (state.moving ? 0 : Math.sin(phaseBob) * 1));
    ctx.scale(scalePulse, scalePulse);
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

    const phaseBob = t * (state.moving ? 3.8 * (1 + spd * 0.5) : 1.6) * this.speedMul;
    const sx = 1 + 0.035 * Math.sin(phaseBob);
    const sy = 1 - 0.035 * Math.sin(phaseBob);

    const scalePulse = state.danceScale ?? 1;

    // Shadow
    drawGroundShadow(ctx, x, y, worldW, scalePulse);

    // Body
    ctx.save();
    ctx.translate(x, y + (state.moving ? 0 : Math.sin(phaseBob) * 1));
    ctx.scale(scalePulse, scalePulse);
    ctx.scale(sx, sy);

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
  const speedMul = theme?.animSpeed ?? 1;

  // Background
  let bgImg = null;
  if (theme?.background?.src) {
    try { bgImg = await loader.loadImage(theme.background.src); } catch {}
  }
  const drawBackground = (ctx, mapSize) => {
    if (!bgImg) return;
    const mode = theme?.background?.mode || "stretch";  // "stretch" | "cover" | "contain" | "tile"
    const pixelated = theme?.background?.pixelated ?? true;
    const tint = theme?.background?.tint;

    const prevSmooth = ctx.imageSmoothingEnabled;
    if (pixelated) ctx.imageSmoothingEnabled = false;
    ctx.save();

    if (mode === "tile") {
      const pat = ctx.createPattern(bgImg, "repeat");
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, mapSize, mapSize);
    } else {
      let dx = 0, dy = 0, dw = mapSize, dh = mapSize;
      if (mode === "cover" || mode === "contain") {
        const iw = bgImg.width, ih = bgImg.height;
        const s = mode === "cover"
          ? Math.max(mapSize / iw, mapSize / ih)
          : Math.min(mapSize / iw, mapSize / ih);
        dw = iw * s; dh = ih * s;
        dx = (mapSize - dw) / 2;
        dy = (mapSize - dh) / 2;
      }
      ctx.drawImage(bgImg, dx, dy, dw, dh);
    }
    if (tint) { ctx.fillStyle = tint; ctx.fillRect(0, 0, mapSize, mapSize); }

    ctx.restore();
    ctx.imageSmoothingEnabled = prevSmooth;
  };

  // Player sprite(s)
  let sheetImg = null;
  let sheetCfg = null;
  if (theme?.player?.sheet?.src) {
    try {
      sheetImg = await loader.loadImage(theme.player.sheet.src);
      sheetCfg = Object.assign({}, theme.player.sheet, { speedMul });
    } catch {}
  }
  const playerCache = new Map();
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

  // Optional music support for dance mode
  let music = null;
  if (theme?.music?.src) {
    const el = new Audio(theme.music.src);
    el.loop   = true;
    el.preload = "auto";
    el.volume = clamp(theme.music.volume ?? 0.6, 0, 1);
    const bpm = Math.max(40, Math.min(240, theme.music.bpm ?? 120));
    const play = async () => { try { await el.play(); } catch {} };
    const pause = () => { try { el.pause(); } catch {} };
    const setVolume = (v) => { el.volume = clamp(v, 0, 1); };
    music = { el, bpm, play, pause, setVolume };
  }

  return { drawBackground, getPlayerSprite, speedMul, music };
}

// Example themes
export const THEMES = {
  grass: {
    animSpeed: 0.8,
    background: { src: "assets/bg.png", mode: "cover", pixelated: true },
    music: { src: "assets/dance.mp3", bpm: 120, volume: 0.7 },
    player: { /* use blob fallback or provide a sheet */ }
  },
  isaacish: {
    animSpeed: 0.8,
    background: { src: "assets/bg.png" },
    music: { src: "assets/dance.mp3", bpm: 120, volume: 0.7 },
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
