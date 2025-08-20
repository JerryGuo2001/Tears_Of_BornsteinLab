// public/talk.js
// Self-registering Talk plugin: press Y to open, 1/2 to speak.
// Uses server "say" event; shows bubbles for all players.
  // Keyboard
(function waitForCore(){
  if (window.GameCore?.socket) { init(window.GameCore); }
  else setTimeout(waitForCore, 30);
})();

function init(core){
  // ---- UI panel (left side) ----
  let open = false, panel = null;
  function mountUI(){
    if (panel) return;
    const style = document.createElement("style");
    style.textContent = `
      .talk-panel {
        position: fixed; left: 16px; top: 16px; transform: none;
        width: 230px; background: rgba(10, 15, 25, 0.92); color: #e5e7eb;
        border: 1px solid #334155; border-radius: 12px; padding: 12px;
        font-family: system-ui, sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,.35);
        z-index: 3000; display: none;
      }
      .talk-title { font-weight: 600; margin-bottom: 8px; font-size: 14px; }
      .talk-item { padding: 8px; border-radius: 8px; border: 1px solid #374151; margin-bottom: 8px; }
      .talk-item kbd { background:#111827; border:1px solid #374151; padding:1px 6px; border-radius:6px; font-size: 12px; }
      .talk-hint { opacity: .75; font-size: 12px; margin-top: 4px; }
    `;
    document.head.appendChild(style);
    panel = document.createElement("div");
    panel.className = "talk-panel";
    panel.innerHTML = `
      <div class="talk-title">Say something</div>
      <div class="talk-item"><kbd>1</kbd> Hi</div>
      <div class="talk-item"><kbd>2</kbd> Jerry is the best</div>
      <div class="talk-hint">Press <kbd>1</kbd>/<kbd>2</kbd> to speak, <kbd>Y</kbd> to close</div>
    `;
    document.body.appendChild(panel);
  }
  mountUI();

  const bubbles = []; // { id, text, t, ttl }

  function toggle(){ open = !open; panel.style.display = open ? "block" : "none"; }
  function close(){ open = false; panel.style.display = "none"; }

  // Keyboard
  core.onKeyDown((e)=>{
    // NEW: only in celebration phase
    if (core.getPhase && core.getPhase() !== "celebration") return;

    if (e.key === "y" || e.key === "Y") { toggle(); e.preventDefault(); return true; }
    if (!open) return;
    if (e.key === "1") { core.say("Hi"); close(); e.preventDefault(); return true; }
    if (e.key === "2") { core.say("Jerry is the best"); close(); e.preventDefault(); return true; }
  });


  // Incoming from server
  core.socket.on("say", ({ id, text }) => { bubbles.push({ id, text, t:0, ttl:2.4 }); });

  // Update (fade + lifetime)
  core.onFrame((dt)=>{
    for (const b of bubbles) b.t += dt;
    for (let i=bubbles.length-1; i>=0; i--) if (bubbles[i].t >= bubbles[i].ttl) bubbles.splice(i,1);
  });

  // Draw bubbles on top
  core.onDraw((ctx, core)=>{
    const pos = core.positions;
    const { scale, dpr } = core.measure();
    const PR = core.playerRadius;

    for (const b of bubbles) {
      const p = pos[b.id]; if (!p) continue;

      const headY = p.y - PR - 8 / (scale * dpr);
      const padding = 8 / (scale * dpr);
      const corner  = 8 / (scale * dpr);
      const fontPx  = 14 / (scale * dpr);

      ctx.save();
      ctx.font = `${fontPx}px system-ui, sans-serif`;
      const textW = ctx.measureText(b.text).width;
      const boxW  = Math.max(textW + padding*2, 50 / (scale*dpr));
      const boxH  = (fontPx + padding*2);
      const x = p.x - boxW/2;
      const y = headY - boxH - 10 / (scale * dpr);

      let alpha = 1;
      const fadeStart = b.ttl - 0.5;
      if (b.t > fadeStart) alpha = Math.max(0, 1 - (b.t - fadeStart) / 0.5);
      ctx.globalAlpha = alpha;

      // Box
      roundRect(ctx, x, y, boxW, boxH, corner);
      ctx.fillStyle = "rgba(17,24,39,0.92)"; ctx.fill();
      ctx.lineWidth = 2 / (scale * dpr);
      ctx.strokeStyle = "rgba(51,65,85,1)"; ctx.stroke();

      // Tail
      const tailW = 12 / (scale*dpr);
      ctx.beginPath();
      ctx.moveTo(p.x, headY - 2/(scale*dpr));
      ctx.lineTo(p.x - tailW/2, y + boxH);
      ctx.lineTo(p.x + tailW/2, y + boxH);
      ctx.closePath();
      ctx.fill();

      // Text
      ctx.fillStyle = "#e5e7eb";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(b.text, p.x, y + boxH/2);
      ctx.restore();
    }
  }, 50); // z = 50 (front)

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w/2, h/2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
}
