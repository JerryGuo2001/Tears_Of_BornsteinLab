// public/talk.js
export function createTalkSystem() {
  const state = {
    open: false,
    localId: null,
    bubbles: [],             // { id, text, t, ttl }
    sendSay: (text)=>{},     // injected by game.js
  };

  // ---------- UI ----------
  let panel;
  function mountUI() {
    if (panel) return;
    const style = document.createElement("style");
    style.textContent = `
      .talk-panel {
        position: fixed; left: 16px; top: 50%; transform: translateY(-50%);
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
  const showPanel = () => { if (panel) panel.style.display = "block"; };
  const hidePanel = () => { if (panel) panel.style.display = "none"; };

  // ---------- API ----------
  function setLocalId(id) { state.localId = id; }
  function bindNetwork({ sendSay }) { state.sendSay = sendSay || state.sendSay; }

  function toggle() { state.open = !state.open; state.open ? showPanel() : hidePanel(); }
  function close()  { state.open = false; hidePanel(); }

  function handleKeyDown(e) {
    if (e.key === "y" || e.key === "Y") { toggle(); e.preventDefault(); return true; }
    if (!state.open) return false;
    if (e.key === "1") { state.sendSay("Hi"); close(); e.preventDefault(); return true; }
    if (e.key === "2") { state.sendSay("Jerry is the best"); close(); e.preventDefault(); return true; }
    return false;
  }

  // When the server broadcasts a say
  function receiveSay(id, text) {
    state.bubbles.push({ id, text, t: 0, ttl: 2.4 });
  }

  function update(dt) {
    for (const b of state.bubbles) b.t += dt;
    state.bubbles = state.bubbles.filter(b => b.t < b.ttl);
  }

  function clearBubblesFor(id) {
    state.bubbles = state.bubbles.filter(b => b.id !== id);
  }

  function drawBubbles(ctx, positions, playerRadius, scale, dpr) {
    for (const b of state.bubbles) {
      const pos = positions[b.id]; if (!pos) continue;

      const headY = pos.y - playerRadius - 8 / (scale * dpr);
      const padding = 8 / (scale * dpr);
      const corner  = 8 / (scale * dpr);
      const fontPx  = 14 / (scale * dpr);

      ctx.save();
      ctx.font = `${fontPx}px system-ui, sans-serif`;
      const textW   = ctx.measureText(b.text).width;
      const boxW    = Math.max(textW + padding * 2, 50 / (scale * dpr));
      const boxH    = (fontPx + padding * 2);
      const x = pos.x - boxW / 2;
      const y = headY - boxH - 10 / (scale * dpr);

      let alpha = 1.0;
      const fadeStart = b.ttl - 0.5;
      if (b.t > fadeStart) alpha = Math.max(0, 1 - (b.t - fadeStart) / 0.5);

      ctx.globalAlpha = alpha;
      ctx.fillStyle = "rgba(17,24,39,0.92)";
      roundRect(ctx, x, y, boxW, boxH, corner); ctx.fill();
      ctx.strokeStyle = "rgba(51,65,85,1)";
      ctx.lineWidth = 2 / (scale * dpr);
      roundRect(ctx, x, y, boxW, boxH, corner); ctx.stroke();

      const tailW = 12 / (scale * dpr), tailH = 10 / (scale * dpr);
      ctx.beginPath();
      ctx.moveTo(pos.x, headY - 2 / (scale * dpr));
      ctx.lineTo(pos.x - tailW / 2, y + boxH);
      ctx.lineTo(pos.x + tailW / 2, y + boxH);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = "#e5e7eb";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(b.text, pos.x, y + boxH / 2);

      ctx.restore();
    }
  }

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

  return {
    mountUI, setLocalId, bindNetwork,
    handleKeyDown, update, drawBubbles, clearBubblesFor,
    receiveSay
  };
}
