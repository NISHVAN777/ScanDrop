/**
 * "Catch the drop": a small game at the bottom of the home page.
 *
 * Files fall from the top. Move your phone left and right to catch them.
 * - Blue file: +1
 * - Yellow QR tile: +5 (rare)
 * - Red broken file: lose a life if you catch it
 * - Missing a blue file also costs a life
 * It speeds up as your score grows. Best score is remembered on this device.
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

  let W = 0;
  let H = 0;
  let colors = {};
  let state = 'idle'; // idle | playing | paused | over
  let items = [];
  let popups = [];
  let score = 0;
  let lives = START_LIVES;
  let best = loadBest();
  let spawnIn = 0;
  let elapsed = 0;
  let last = 0;
  let flash = 0;
  const phone = { x: 0, w: 74, h: 100, target: 0 };
  const keys = { left: false, right: false };

  bestEl.textContent = best;

  // ---------- Setup ----------

  function readColors() {
    const s = getComputedStyle(document.documentElement);
    const v = (n) => s.getPropertyValue(n).trim();
    colors = {
      ink: v('--ink'), slate: v('--slate'), line: v('--line'), paper: v('--paper'),
      surface: v('--surface'), cobalt: v('--cobalt'), signal: v('--signal'), danger: v('--danger'),
    };
  }

  function resize() {
    const r = stage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width;
    H = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    phone.w = Math.max(60, Math.min(84, W * 0.12));
    phone.h = phone.w * 1.35;
    phone.x = clamp(phone.x || W / 2, phone.w / 2, W - phone.w / 2);
    phone.target = phone.x;
    if (state !== 'playing') draw();
  }

  readColors();
  resize();
  new ResizeObserver(resize).observe(stage);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readColors(); draw(); });

  // ---------- Game flow ----------

  function start() {
    items = [];
    popups = [];
    score = 0;
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
    msg.textContent = 'Paused.';
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
    msg.textContent = isBest && score > 0
      ? `New best! You caught ${score} ${score === 1 ? 'point' : 'points'} of files.`
      : `Game over. You scored ${score}.`;
    startBtn.textContent = 'Play again';
    overlay.classList.remove('hidden');
    startBtn.focus({ preventScroll: true });
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
    draw();
    requestAnimationFrame(loop);
  }

  // Difficulty grows with score: faster falls, more frequent drops, more broken files.
  const level = () => Math.min(score / 25, 1.6);

  function spawn() {
    const r = Math.random();
    const badChance = 0.18 + level() * 0.12;
    const kind = r < 0.05 ? 'bonus' : r < 0.05 + badChance ? 'bad' : 'file';
    const size = Math.max(38, Math.min(50, W * 0.07));
    items.push({
      kind,
      x: size / 2 + Math.random() * (W - size),
      y: -size,
      w: size,
      h: size * 1.18,
      vy: (110 + Math.random() * 50) * (1 + level() * 0.75),
      label: LABELS[Math.floor(Math.random() * LABELS.length)],
      spin: (Math.random() - 0.5) * 0.4,
    });
  }

  function update(dt) {
    elapsed += dt;

    // Movement: keyboard steers, pointer sets a target to glide toward.
    const speed = 620;
    if (keys.left) phone.target -= speed * dt;
    if (keys.right) phone.target += speed * dt;
    phone.target = clamp(phone.target, phone.w / 2, W - phone.w / 2);
    phone.x += (phone.target - phone.x) * Math.min(1, dt * 18);

    spawnIn -= dt;
    if (spawnIn <= 0) {
      spawn();
      spawnIn = Math.max(0.32, 0.95 - level() * 0.4) * (0.7 + Math.random() * 0.6);
    }

    const top = H - phone.h - 10;
    for (const it of items) {
      it.y += it.vy * dt;
      const bottom = it.y + it.h / 2;
      const overlaps = Math.abs(it.x - phone.x) < (phone.w + it.w) / 2 - 6;
      if (!it.done && bottom >= top && bottom <= top + 26 && overlaps) {
        it.done = true;
        catchItem(it);
      } else if (!it.done && it.y - it.h / 2 > H) {
        it.done = true;
        if (it.kind === 'file') loseLife(it.x, H - 30, 'Missed!');
      }
    }
    items = items.filter((it) => !it.done);

    for (const p of popups) { p.y -= 40 * dt; p.t -= dt; }
    popups = popups.filter((p) => p.t > 0);
    flash = Math.max(0, flash - dt * 2.5);
  }

  function catchItem(it) {
    if (it.kind === 'bad') return loseLife(it.x, it.y, 'Broken file!');
    const pts = it.kind === 'bonus' ? 5 : 1;
    score += pts;
    popups.push({ x: it.x, y: it.y, text: `+${pts}`, t: 0.8, color: it.kind === 'bonus' ? colors.ink : colors.cobalt });
    updateHud();
  }

  function loseLife(x, y, text) {
    lives -= 1;
    flash = 1;
    popups.push({ x, y, text, t: 1, color: colors.danger });
    updateHud();
    if (lives <= 0) {
      draw();
      gameOver();
    }
  }

  function updateHud() {
    scoreEl.textContent = score;
    livesEl.textContent = Math.max(0, lives);
    livesEl.setAttribute('aria-label', `${Math.max(0, lives)} lives`);
  }

  // ---------- Drawing ----------

  function draw() {
    ctx.clearRect(0, 0, W, H);

    // Faint module grid, like an enlarged QR code
    ctx.fillStyle = colors.line;
    const g = 28;
    for (let x = g; x < W; x += g) for (let y = g; y < H; y += g) ctx.fillRect(x - 1, y - 1, 2, 2);

    for (const it of items) drawItem(it);
    drawPhone();

    ctx.textAlign = 'center';
    ctx.font = '700 18px "Bricolage Grotesque Variable", system-ui, sans-serif';
    for (const p of popups) {
      ctx.globalAlpha = Math.min(1, p.t * 2);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;

    if (flash > 0) {
      ctx.fillStyle = colors.danger;
      ctx.globalAlpha = flash * 0.12;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  function drawItem(it) {
    const { w, h } = it;
    ctx.save();
    ctx.translate(it.x, it.y);
    ctx.rotate(Math.sin((it.y / 60) + it.spin * 10) * it.spin * 0.3);
    const x = -w / 2;
    const y = -h / 2;
    const fold = w * 0.3;

    // File sheet with a folded corner
    ctx.beginPath();
    ctx.moveTo(x + 6, y);
    ctx.lineTo(x + w - fold, y);
    ctx.lineTo(x + w, y + fold);
    ctx.lineTo(x + w, y + h - 6);
    ctx.quadraticCurveTo(x + w, y + h, x + w - 6, y + h);
    ctx.lineTo(x + 6, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - 6);
    ctx.lineTo(x, y + 6);
    ctx.quadraticCurveTo(x, y, x + 6, y);
    ctx.closePath();
    ctx.fillStyle = it.kind === 'bad' ? colors.danger : it.kind === 'bonus' ? colors.signal : colors.cobalt;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(x + w - fold, y);
    ctx.lineTo(x + w - fold, y + fold);
    ctx.lineTo(x + w, y + fold);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    ctx.fill();

    if (it.kind === 'bonus') {
      // Tiny QR finder squares
      ctx.fillStyle = '#101b2d';
      const s = w * 0.22;
      for (const [dx, dy] of [[0.16, 0.36], [0.56, 0.36], [0.16, 0.7]]) {
        ctx.fillRect(x + w * dx, y + h * dy - s / 2, s, s);
        ctx.fillStyle = colors.signal;
        ctx.fillRect(x + w * dx + s * 0.3, y + h * dy - s * 0.2, s * 0.4, s * 0.4);
        ctx.fillStyle = '#101b2d';
      }
      ctx.fillRect(x + w * 0.6, y + h * 0.66, s * 0.45, s * 0.45);
    } else if (it.kind === 'bad') {
      // Crack across the sheet
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x + w * 0.2, y + h * 0.3);
      ctx.lineTo(x + w * 0.45, y + h * 0.48);
      ctx.lineTo(x + w * 0.35, y + h * 0.58);
      ctx.lineTo(x + w * 0.62, y + h * 0.78);
      ctx.stroke();
      ctx.font = `700 ${Math.round(w * 0.32)}px system-ui, sans-serif`;
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText('!', x + w * 0.72, y + h * 0.5);
    } else {
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `700 ${Math.round(w * 0.27)}px "Atkinson Hyperlegible", system-ui, sans-serif`;
      ctx.fillText(it.label, x + w / 2, y + h * 0.62);
    }
    ctx.restore();
  }

  function drawPhone() {
    const { w, h } = phone;
    const x = phone.x - w / 2;
    const y = H - h - 10;
    roundRect(x, y, w, h + 30, 14); // runs off the bottom edge
    ctx.fillStyle = colors.ink;
    ctx.fill();
    roundRect(x + 5, y + 5, w - 10, h + 20, 10);
    ctx.fillStyle = colors.paper;
    ctx.fill();
    // Camera notch
    roundRect(phone.x - w * 0.14, y + 9, w * 0.28, 6, 3);
    ctx.fillStyle = colors.ink;
    ctx.fill();
    // Download arrow on screen
    ctx.strokeStyle = colors.cobalt;
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
  }

  // ---------- Controls ----------

  const toLocalX = (clientX) => clientX - stage.getBoundingClientRect().left;
  stage.addEventListener('pointermove', (e) => { if (state === 'playing') phone.target = toLocalX(e.clientX); });
  stage.addEventListener('pointerdown', (e) => { if (state === 'playing') phone.target = toLocalX(e.clientX); });

  const isTyping = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;

  window.addEventListener('keydown', (e) => {
    if (isTyping(e)) return;
    const active = state === 'playing' || state === 'paused';
    if (!active) return;
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

  // Pause automatically when you switch tabs or scroll the game away.
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
  new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) pause();
  }, { threshold: 0.3 }).observe(stage);

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
    get items() { return items; }, phone, start, pause,
    /** Advance the game by `seconds` without waiting for animation frames. */
    step(seconds, fps = 60) {
      for (let i = 0; i < seconds * fps && state === 'playing'; i++) update(1 / fps);
      draw();
    },
  };
}
