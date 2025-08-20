// public/dance.js
// Self-registering Dance plugin: press M to toggle.
// RGB aura for ANY dancer; music plays for ALL while anyone is dancing.

(function waitForCore(){
  if (window.GameCore?.socket) { init(window.GameCore); }
  else setTimeout(waitForCore, 30);
})();

function init(core){
  const localId = () => core.localId;
  const dancers = new Set();           // ids currently dancing
  const remoteT = new Map();           // id -> time accumulator
  let localOn = false;
  let localT  = 0;

  // Prime audio on Start (required by autoplay policies)
  core.onStart(async ()=>{
    const mus = core.style?.music?.el;
    if (!mus) return;
    try {
      mus.muted = true;
      await mus.play();
      mus.pause();
      mus.muted = false;
    } catch {}
  });

  function playIfAny(){
    const m = core.style?.music;
    if (!m?.el) return;
    if (dancers.size > 0) m.play?.(); else m.pause?.();
  }

  // Toggle local
  core.onKeyDown((e)=>{
    if (e.key === "m" || e.key === "M") {
      localOn = !localOn;
      if (localOn) {
        localT = 0;
        dancers.add(localId());
      } else {
        dancers.delete(localId());
      }
      core.emit("dance", { on: localOn });
      playIfAny();
      e.preventDefault();
      return true;
    }
  });

  // Seed from hello if server includes 'dancers'
  const hello = core.getHello();
  if (hello?.dancers) {
    for (const id of hello.dancers) dancers.add(id);
    playIfAny();
  }

  // Server broadcasts
  core.socket.on("dance", ({ id, on })=>{
    if (id === localId()) { // echo; reflect
      if (on) dancers.add(id); else dancers.delete(id);
    } else {
      if (on) { dancers.add(id); remoteT.set(id, 0); }
      else    { dancers.delete(id); remoteT.delete(id); }
    }
    playIfAny();
  });

  // Step time
  core.onFrame((dt)=>{
    if (localOn) localT += dt;
    for (const id of remoteT.keys()) remoteT.set(id, (remoteT.get(id) || 0) + dt);

    // Apply pulsing to anim
    const bpm = core.style?.music?.bpm ?? 120;
    for (const id in core.positions) {
      const a = core.anim[id]; if (!a) continue;
      if (!dancers.has(id)) { a.danceScale = 1; a.rateMul = 1; continue; }
      const t = (id === localId()) ? localT : (remoteT.get(id) || 0);
      const beat = 0.5 + 0.5 * Math.sin((t * bpm / 60) * Math.PI * 2);
      a.danceScale = 1 + 0.18 * beat;
      a.rateMul    = 1 + 0.25 * beat;
    }
  });

  // Draw aura around every dancing player (above background, below players)
  core.onDraw((ctx, core)=>{
    if (dancers.size === 0) return;
    const bpm = core.style?.music?.bpm ?? 120;

    ctx.save();
    ctx.globalCompositeOperation = "screen";
    for (const id of dancers) {
      const p = core.positions[id]; if (!p) continue;
      const t = (id === localId()) ? localT : (remoteT.get(id) || 0);
      const beat = 0.5 + 0.5 * Math.sin((t * bpm / 60) * Math.PI * 2);

      const radius = 260;
      const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
      glow.addColorStop(0, `rgba(255,255,255,${0.08 + 0.10*beat})`);
      glow.addColorStop(1, `rgba(255,255,255,0)`);
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2); ctx.fill();

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
        ctx.moveTo(p.x, p.y);
        ctx.arc(p.x, p.y, ringR, a - w/2, a + w/2);
        ctx.closePath();
        ctx.fillStyle = colors[i](alpha);
        ctx.fill();
      }
    }
    ctx.restore();
  }, -10); // z = -10 (behind players)
}
