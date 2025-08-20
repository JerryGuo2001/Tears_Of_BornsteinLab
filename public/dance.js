// public/dance.js
// Networked dance mode. Press M to toggle; sends/receives socket events.
// Music now plays for EVERYONE while ANY player is dancing.
// RGB aura renders around EACH dancing player.

export function createDanceSystem(getMusic) {
  const local  = { id: null, on: false, t: 0 };
  const remote = new Map();     // id -> { on:bool, t:number }
  const active = new Set();     // ids currently dancing
  let sendDance = (on)=>{};     // injected by game.js

  function setLocalId(id) { local.id = id; }
  function bindNetwork({ send }) { sendDance = send || sendDance; }

  // Call on Start button to satisfy autoplay policies
  async function primeAudio() {
    const mus = getMusic && getMusic();
    if (!mus?.el) return;
    try {
      mus.el.muted = true;
      await mus.el.play();
      mus.el.pause();
      mus.el.muted = false;
    } catch {}
  }

  function playIfAny() {
    const mus = getMusic && getMusic();
    if (!mus?.el) return;
    if (active.size > 0) mus.play?.(); else mus.pause?.();
  }

  function updateActiveFor(id, on) {
    if (on) active.add(id); else active.delete(id);
    playIfAny();
  }

  function toggle() {
    local.on = !local.on;
    if (local.on) local.t = 0;
    updateActiveFor(local.id, local.on);
    sendDance(local.on); // notify others
  }

  function onFrame(dt) {
    if (local.on) local.t += dt;
    for (const r of remote.values()) if (r.on) r.t = (r.t || 0) + dt;
  }

  // From server (and also used to seed from hello)
  function setRemote(id, on) {
    if (id === local.id) { // server echo; keep local state authoritative
      updateActiveFor(local.id, on);
      return;
    }
    const r = remote.get(id) || { on:false, t:0 };
    if (on && !r.on) r.t = 0;     // reset phase when newly toggled
    r.on = !!on;
    remote.set(id, r);
    updateActiveFor(id, r.on);
  }

  function isOnFor(id) {
    if (id === local.id) return local.on;
    const r = remote.get(id); return !!(r && r.on);
  }

  function timeFor(id) {
    return id === local.id ? local.t : (remote.get(id)?.t || 0);
  }

  function applyToAnim(id, anim) {
    if (!isOnFor(id)) { anim.danceScale = 1; anim.rateMul = 1; return; }
    const mus  = getMusic && getMusic();
    const bpm  = mus?.bpm ?? 120;
    const t    = timeFor(id);
    const beat = 0.5 + 0.5 * Math.sin((t * bpm / 60) * Math.PI * 2);
    anim.danceScale = 1 + 0.18 * beat;
    anim.rateMul    = 1 + 0.25 * beat;
  }

  // Draw aura for the specified player id at (x,y)
  function draw(ctx, id, x, y) {
    if (!isOnFor(id)) return;
    const mus  = getMusic && getMusic();
    const bpm  = mus?.bpm ?? 120;
    const t    = timeFor(id);
    const beat = 0.5 + 0.5 * Math.sin((t * bpm / 60) * Math.PI * 2);

    ctx.save();
    ctx.globalCompositeOperation = "screen";

    const radius = 260;
    const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
    glow.addColorStop(0, `rgba(255,255,255,${0.08 + 0.10*beat})`);
    glow.addColorStop(1, `rgba(255,255,255,0)`);
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();

    const ringR = radius * 0.85;
    const widths = [Math.PI/6, Math.PI/6, Math.PI/6];
    const speeds = [1.1, 0.9, 1.3];
    const colors = [
      (a)=>`rgba(255,80,80,${a})`,
      (a)=>`rgba(80,255,140,${a})`,
      (a)=>`rgba(120,160,255,${a})`
    ];
    const alpha = 0.40 + 0.25 * beat;

    for (let i = 0; i < 3; i++) {
      const a = t * speeds[i] + i * 2.0;
      const w = widths[i] * (0.8 + 0.3 * beat);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.arc(x, y, ringR, a - w/2, a + w/2);
      ctx.closePath();
      ctx.fillStyle = colors[i](alpha);
      ctx.fill();
    }

    ctx.restore();
  }

  // Helpful for debugging or UI hooks
  function anyActive() { return active.size > 0; }

  return {
    setLocalId, bindNetwork, primeAudio,
    toggle, onFrame, setRemote, isOnFor, applyToAnim, draw, anyActive
  };
}
