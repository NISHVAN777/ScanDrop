/**
 * "Catch the drop": a small neon game at the bottom of the home page.
 *
 * Files fall from the top. Move your phone left and right to catch them.
 * - Blue file: +1 (more with a combo)
 * - Gold QR tile: +5 (rare)
 * - Red broken file: lose a life if you catch it
 * - Missing a blue file also costs a life and resets your combo
 * Catch 5 in a row for x2 points, 10 in a row for x3. It speeds up as you score.
 * Best score is remembered on this device.
 */

const stage = document.getElementById('gameStage');
const canvas = document.getElementById('gameCanvas');
const overlay = document.getElementById('gameOverlay');
const msg = document.getElementById('gameMsg');
const startBtn = document.getElementById('gameStart');
const scoreEl = document.getElementById('gScore');
const bestEl = document.getElementById('gBest');
const livesEl = document.getElementById('gLives');

if (canvas && stage) init();

function init() {
  const ctx = canvas.getContext('2d');
  const LABELS = ['PDF', 'JPG', 'MP4', 'ZIP', 'DOC', 'PNG', 'MP3', 'XLS'];
  const START_LIVES = 3;
  const C = {
    violet: '#a78bfa', indigo: '#6366f1', blue: '#3b82f6', cyan: '#22d3ee',
    pink: '#ec4899', gold: '#fbbf24', red: '#fb7185', white: '#f4f3ff',
  };

  let W = 0;
  let H = 0;
  let state = 'idle'; // idle | playing | paused | over
  let items = [];
  let particles = [];
  let popups = [];
  let stars = [];
  let score = 0;
  let lives = START_LIVES;
  let combo = 0;
  let best = loadBest();
  let spawnIn = 0;
  let elapsed = 0;
  let last = 0;
  let flash = 0;
  const phone = { x: 0, w: 74, h: 100, target: 0, glow: 0 };
  const keys = { left: false, right: false };

  bestEl.textContent = best;
  updateHud();

  // ---------- Setup ----------

  function resize() {
    const r = stage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width;
    H = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    phone.w = Math.max(62, Math.min(86, W * 0.12));
    phone.h = phone.w * 1.35;
    phone.x = clamp(phone.x || W / 2, phone.w / 2, W - phone.w / 2);
    phone.target = phone.x;
    stars = Array.from({ length: Math.round((W * H) / 5000) }, () => ({
      x: Math.random() * W, y: Math.random() * H, z: 0.3 + Math.random() * 0.7, tw: Math.random() * 6,
    }));
    if (state !== 'playing') draw();
  }

  resize();
  new ResizeObserver(resize).observe(stage);

  // Gentle idle animation of the stars behind the start screen.
  let idleRaf = 0;
  function idleLoop(now) {
    if (state === 'playing') return;
    for (const s of stars) { s.y += s.z * 0.25; if (s.y > H) s.y = 0; s.tw += 0.03; }
    draw(now);
    idleRaf = requestAnimationFrame(idleLoop);
  }
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) idleRaf = requestAnimationFrame(idleLoop);

  // ---------- Game flow ----------

  function start() {
    cancelAnimationFrame(idleRaf);
    items = [];
    particles = [];
    popups = [];
    score = 0;
    combo = 0;
    lives = START_LIVES;
    elapsed = 0;
    spawnIn = 0.4;
    flash = 0;
    updateHud();
    overlay.classList.add('hidden');
    state = 'playing';
    last = performance.now();
    requestAnimationFrame(loop);
  }

  function pause() {
    if (state !== 'playing') return;
    state = 'paused';
    msg.textContent = 'Paused';
    startBtn.textContent = 'Resume';
    overlay.classList.remove('hidden');
  }

  function resume() {
    if (state !== 'paused') return;
    overlay.classList.add('hidden');
    state = 'playing';
    last = performance.now();
    requestAnimationFrame(loop);
  }

  function gameOver() {
    state = 'over';
    const isBest = score > best;
    if (isBest) {
      best = score;
      saveBest(best);
      bestEl.textContent = best;
    }
    msg.textContent = isBest && score > 0 ? `New best: ${score} points!` : `Game over. You scored ${score}.`;
    startBtn.textContent = 'Play again';
    overlay.classList.remove('hidden');
    startBtn.focus({ preventScroll: true });
    idleRaf = requestAnimationFrame(idleLoop);
  }

  startBtn.addEventListener('click', () => {
    if (state === 'playing') return; // e.g. Space already resumed the game
    if (state === 'paused') resume();
    else start();
  });

  // ---------- Loop ----------

  function loop(now) {
    if (state !== 'playing') return;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    update(dt);
    draw(now);
    requestAnimationFrame(loop);
  }

  const level = () => Math.min(score / 30, 1.6);
  const multiplier = () => (combo >= 10 ? 3 : combo >= 5 ? 2 : 1);

  function spawn() {
    const r = Math.random();
    const badChance = 0.18 + level() * 0.12;
    const kind = r < 0.05 ? 'bonus' : r < 0.05 + badChance ? 'bad' : 'file';
    const size = Math.max(40, Math.min(52, W * 0.07));
    items.push({
      kind,
      x: size / 2 + Math.random() * (W - size),
      y: -size,
      w: size,
      h: size * 1.18,
      vy: (115 + Math.random() * 55) * (1 + level() * 0.75),
      label: LABELS[Math.floor(Math.random() * LABELS.length)],
      spin: (Math.random() - 0.5) * 0.5,
      age: 0,
    });
  }

  function update(dt) {
    elapsed += dt;

    const speed = 640;
    if (keys.left) phone.target -= speed * dt;
    if (keys.right) phone.target += speed * dt;
    phone.target = clamp(phone.target, phone.w / 2, W - phone.w / 2);
    phone.x += (phone.target - phone.x) * Math.min(1, dt * 18);
    phone.glow = Math.max(0, phone.glow - dt * 3);

    for (const s of stars) { s.y += s.z * (40 + level() * 60) * dt; if (s.y > H) { s.y = 0; s.x = Math.random() * W; } s.tw += dt * 3; }

    spawnIn -= dt;
    if (spawnIn <= 0) {
      spawn();
      spawnIn = Math.max(0.32, 0.95 - level() * 0.4) * (0.7 + Math.random() * 0.6);
    }

    const top = H - phone.h - 10;
    for (const it of items) {
      it.y += it.vy * dt;
      it.age += dt;
      const bottom = it.y + it.h / 2;
      const overlaps = Math.abs(it.x - phone.x) < (phone.w + it.w) / 2 - 6;
      if (!it.done && bottom >= top && bottom <= top + 28 && overlaps) {
        it.done = true;
        catchItem(it);
      } else if (!it.done && it.y - it.h / 2 > H) {
        it.done = true;
        if (it.kind === 'file') { combo = 0; loseLife(it.x, H - 40, 'Missed!'); }
      }
    }
    items = items.filter((it) => !it.done);

    for (const p of particles) {
      p.vy += 420 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    particles = particles.filter((p) => p.life > 0);

    for (const p of popups) { p.y -= 46 * dt; p.t -= dt; }
    popups = popups.filter((p) => p.t > 0);
    flash = Math.max(0, flash - dt * 2.5);
  }

  function burst(x, y, color, n = 18) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 90 + Math.random() * 220;
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 140, life: 0.5 + Math.random() * 0.5, color, size: 2 + Math.random() * 3 });
    }
  }

  function catchItem(it) {
    if (it.kind === 'bad') {
      combo = 0;
      burst(it.x, it.y, C.red, 26);
      return loseLife(it.x, it.y, 'Broken file!');
    }
    combo += 1;
    const pts = (it.kind === 'bonus' ? 5 : 1) * multiplier();
    score += pts;
    phone.glow = 1;
    burst(it.x, it.y, it.kind === 'bonus' ? C.gold : C.cyan, it.kind === 'bonus' ? 32 : 16);
    const comboText = combo === 5 ? '  Combo x2!' : combo === 10 ? '  Combo x3!' : '';
    popups.push({ x: it.x, y: it.y, text: `+${pts}${comboText}`, t: 0.9, color: it.kind === 'bonus' ? C.gold : C.cyan });
    updateHud();
  }

  function loseLife(x, y, text) {
    lives -= 1;
    flash = 1;
    popups.push({ x, y, text, t: 1, color: C.red });
    stage.classList.remove('shake');
    void stage.offsetWidth; // restart the shake animation
    stage.classList.add('shake');
    updateHud();
    if (lives <= 0) {
      draw();
      gameOver();
    }
  }

  function updateHud() {
    scoreEl.textContent = score;
    livesEl.textContent = '♥'.repeat(Math.max(0, lives)) || '0';
    livesEl.setAttribute('aria-label', `${Math.max(0, lives)} lives`);
  }

  // ---------- Drawing ----------

  function draw(now = performance.now()) {
    ctx.clearRect(0, 0, W, H);

    // Stars
    for (const s of stars) {
      ctx.globalAlpha = (0.35 + 0.45 * Math.abs(Math.sin(s.tw))) * s.z;
      ctx.fillStyle = s.z > 0.8 ? C.cyan : C.white;
      ctx.fillRect(s.x, s.y, s.z * 2, s.z * 2);
    }
    ctx.globalAlpha = 1;

    // Glowing floor line
    const floor = ctx.createLinearGradient(0, 0, W, 0);
    floor.addColorStop(0, 'rgba(99,102,241,0)');
    floor.addColorStop(0.5, 'rgba(139,92,246,.7)');
    floor.addColorStop(1, 'rgba(34,211,238,0)');
    ctx.fillStyle = floor;
    ctx.fillRect(0, H - 2, W, 2);

    for (const it of items) drawItem(it, now);
    drawPhone();

    // Particles
    for (const p of particles) {
      ctx.globalAlpha = Math.min(1, p.life * 2);
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    // Floating score text
    ctx.textAlign = 'center';
    ctx.font = '800 20px "Bricolage Grotesque Variable", system-ui, sans-serif';
    for (const p of popups) {
      ctx.globalAlpha = Math.min(1, p.t * 2);
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 14;
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    // Combo meter
    if (state === 'playing' && combo >= 2) {
      ctx.textAlign = 'left';
      ctx.font = '800 16px "Bricolage Grotesque Variable", system-ui, sans-serif';
      ctx.fillStyle = multiplier() > 1 ? C.gold : C.violet;
      ctx.fillText(`${combo} in a row${multiplier() > 1 ? `  x${multiplier()}` : ''}`, 18, 30);
    }

    if (flash > 0) {
      ctx.fillStyle = C.red;
      ctx.globalAlpha = flash * 0.18;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }

  function sheet(x, y, w, h, fold) {
    ctx.beginPath();
    ctx.moveTo(x + 7, y);
    ctx.lineTo(x + w - fold, y);
    ctx.lineTo(x + w, y + fold);
    ctx.lineTo(x + w, y + h - 7);
    ctx.quadraticCurveTo(x + w, y + h, x + w - 7, y + h);
    ctx.lineTo(x + 7, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - 7);
    ctx.lineTo(x, y + 7);
    ctx.quadraticCurveTo(x, y, x + 7, y);
    ctx.closePath();
  }

  function drawItem(it, now) {
    const { w, h } = it;
    ctx.save();
    ctx.translate(it.x, it.y);
    ctx.rotate(Math.sin(it.age * 3 + it.spin * 10) * it.spin * 0.35);
    const x = -w / 2;
    const y = -h / 2;
    const fold = w * 0.3;

    const [c1, c2, glow] = it.kind === 'bad'
      ? ['#fb7185', '#e11d48', C.red]
      : it.kind === 'bonus'
        ? ['#fde68a', '#f59e0b', C.gold]
        : ['#a78bfa', '#3b82f6', C.indigo];
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, c1);
    g.addColorStop(1, c2);

    ctx.shadowColor = glow;
    ctx.shadowBlur = it.kind === 'bonus' ? 26 + Math.sin(now / 120) * 8 : 18;
    sheet(x, y, w, h, fold);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x + w - fold, y);
    ctx.lineTo(x + w - fold, y + fold);
    ctx.lineTo(x + w, y + fold);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,.4)';
    ctx.fill();

    if (it.kind === 'bonus') {
      const s = w * 0.22;
      for (const [dx, dy] of [[0.16, 0.36], [0.56, 0.36], [0.16, 0.7]]) {
        ctx.fillStyle = '#1c1300';
        ctx.fillRect(x + w * dx, y + h * dy - s / 2, s, s);
        ctx.fillStyle = '#fde68a';
        ctx.fillRect(x + w * dx + s * 0.3, y + h * dy - s * 0.2, s * 0.4, s * 0.4);
      }
      ctx.fillStyle = '#1c1300';
      ctx.fillRect(x + w * 0.6, y + h * 0.66, s * 0.45, s * 0.45);
    } else if (it.kind === 'bad') {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x + w * 0.2, y + h * 0.3);
      ctx.lineTo(x + w * 0.45, y + h * 0.48);
      ctx.lineTo(x + w * 0.35, y + h * 0.58);
      ctx.lineTo(x + w * 0.62, y + h * 0.78);
      ctx.stroke();
      ctx.font = `800 ${Math.round(w * 0.34)}px system-ui, sans-serif`;
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText('!', x + w * 0.74, y + h * 0.52);
    } else {
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `700 ${Math.round(w * 0.27)}px "Atkinson Hyperlegible", system-ui, sans-serif`;
      ctx.fillText(it.label, x + w / 2, y + h * 0.62);
      ctx.textBaseline = 'alphabetic';
    }
    ctx.restore();
  }

  function drawPhone() {
    const { w, h } = phone;
    const x = phone.x - w / 2;
    const y = H - h - 10;

    // Body with a gradient neon rim
    const rim = ctx.createLinearGradient(x, y, x + w, y + h);
    rim.addColorStop(0, C.violet);
    rim.addColorStop(0.5, C.indigo);
    rim.addColorStop(1, C.cyan);
    ctx.shadowColor = phone.glow > 0 ? C.cyan : C.indigo;
    ctx.shadowBlur = 18 + phone.glow * 30;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h + 30, 16);
    ctx.fillStyle = rim;
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.beginPath();
    ctx.roundRect(x + 4, y + 4, w - 8, h + 22, 12);
    ctx.fillStyle = '#0c0a1f';
    ctx.fill();

    // Screen glow when catching
    if (phone.glow > 0) {
      ctx.globalAlpha = phone.glow * 0.5;
      ctx.fillStyle = C.cyan;
      ctx.beginPath();
      ctx.roundRect(x + 4, y + 4, w - 8, h + 22, 12);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.beginPath();
    ctx.roundRect(phone.x - w * 0.14, y + 10, w * 0.28, 6, 3);
    ctx.fillStyle = 'rgba(255,255,255,.25)';
    ctx.fill();

    // Download arrow on screen
    ctx.strokeStyle = C.cyan;
    ctx.shadowColor = C.cyan;
    ctx.shadowBlur = 10;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const cy = y + h * 0.5;
    ctx.beginPath();
    ctx.moveTo(phone.x, cy - 14);
    ctx.lineTo(phone.x, cy + 10);
    ctx.moveTo(phone.x - 10, cy);
    ctx.lineTo(phone.x, cy + 10);
    ctx.lineTo(phone.x + 10, cy);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // ---------- Controls ----------

  const toLocalX = (clientX) => clientX - stage.getBoundingClientRect().left;
  stage.addEventListener('pointermove', (e) => { if (state === 'playing') phone.target = toLocalX(e.clientX); });
  stage.addEventListener('pointerdown', (e) => { if (state === 'playing') phone.target = toLocalX(e.clientX); });

  const isTyping = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;

  window.addEventListener('keydown', (e) => {
    if (isTyping(e)) return;
    if (state !== 'playing' && state !== 'paused') return;
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') { keys.left = true; e.preventDefault(); }
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') { keys.right = true; e.preventDefault(); }
    if (e.key === ' ' || e.key === 'p' || e.key === 'P' || e.key === 'Escape') {
      e.preventDefault();
      if (state === 'playing') pause();
      else if (e.key !== 'Escape') resume();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') keys.left = false;
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') keys.right = false;
  });

  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
  new IntersectionObserver(([entry]) => { if (!entry.isIntersecting) pause(); }, { threshold: 0.3 }).observe(stage);

  // ---------- Helpers ----------

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function loadBest() {
    try { return Number(localStorage.getItem('scandrop:game-best')) || 0; } catch { return 0; }
  }
  function saveBest(v) {
    try { localStorage.setItem('scandrop:game-best', String(v)); } catch { /* private mode */ }
  }

  // Exposed for automated checks only.
  window.__scandropGame = {
    get state() { return state; }, get score() { return score; }, get lives() { return lives; },
    get combo() { return combo; }, get items() { return items; }, phone, start, pause,
    /** Advance the game by `seconds` without waiting for animation frames. */
    step(seconds, fps = 60) {
      for (let i = 0; i < seconds * fps && state === 'playing'; i++) update(1 / fps);
      draw();
    },
  };
}
