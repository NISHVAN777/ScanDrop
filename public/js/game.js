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
  // Google's colors, plus theme colors read from the page so dark mode works.
  // Same warm gradient family as the page.
  const css = getComputedStyle(document.documentElement);
  const tv = (n, d) => css.getPropertyValue(n).trim() || d;
  const C = { orange: tv('--c1', '#fa7e1e'), pink: tv('--accent', '#d62976'), purple: tv('--c3', '#962fbf'), gold: '#fbbc04', bad: '#2b2b33', red: '#e53935' };
  const PARTY = [C.orange, C.pink, C.purple, C.gold];
  const FILE_COLORS = [C.orange, C.pink, C.purple];
  let T = {};
  function readTheme() {
    const st = getComputedStyle(document.documentElement);
    const v = (n) => st.getPropertyValue(n).trim();
    T = { ink: v('--ink'), dots: v('--line-dash'), surface: v('--surface') };
  }
  readTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readTheme(); draw(); });

  let W = 0;
  let H = 0;
  let state = 'idle'; // idle | playing | paused | over
  let items = [];
  let particles = [];
  let popups = [];
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
    if (state !== 'playing') draw();
  }

  resize();
  new ResizeObserver(resize).observe(stage);

  let idleRaf = 0;
  function idleLoop() {} // calm start screen: no background animation while idle

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
      color: FILE_COLORS[Math.floor(Math.random() * FILE_COLORS.length)],
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
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 140, life: 0.5 + Math.random() * 0.5, color: color || PARTY[i % 4], size: 2 + Math.random() * 3 });
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
    burst(it.x, it.y, it.kind === 'bonus' ? null : it.color, it.kind === 'bonus' ? 32 : 16);
    const comboText = combo === 5 ? '  Combo x2!' : combo === 10 ? '  Combo x3!' : '';
    popups.push({ x: it.x, y: it.y, text: `+${pts}${comboText}`, t: 0.9, color: it.kind === 'bonus' ? '#b06000' : it.color });
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

    // Soft dot grid, gently drifting down
    ctx.fillStyle = T.dots;
    const gap = 28;
    const shift = (elapsed * 18) % gap;
    for (let x = gap / 2; x < W; x += gap) {
      for (let y = -gap + shift; y < H; y += gap) ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    }

    for (const it of items) drawItem(it, now);
    drawPhone();

    // Particles in Google colors
    for (const p of particles) {
      ctx.globalAlpha = Math.min(1, p.life * 2);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Floating score text
    ctx.textAlign = 'center';
    ctx.font = '500 18px Roboto, system-ui, sans-serif';
    for (const p of popups) {
      ctx.globalAlpha = Math.min(1, p.t * 2);
      ctx.fillStyle = p.color;
      // Keep the text fully inside the game area, even for catches at the edges.
      const half = ctx.measureText(p.text).width / 2 + 8;
      ctx.fillText(p.text, clamp(p.x, half, W - half), p.y);
    }
    ctx.globalAlpha = 1;

    // Combo chip in the corner
    if (state === 'playing' && combo >= 2) {
      const label = `${combo} in a row${multiplier() > 1 ? `  x${multiplier()}` : ''}`;
      ctx.font = '500 14px Roboto, system-ui, sans-serif';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = multiplier() > 1 ? C.gold : T.surface;
      ctx.beginPath();
      ctx.roundRect(14, 14, tw + 24, 30, 15);
      ctx.fill();
      ctx.fillStyle = multiplier() > 1 ? '#3c2a00' : T.ink;
      ctx.textAlign = 'left';
      ctx.fillText(label, 26, 34);
    }

    if (flash > 0) {
      ctx.fillStyle = C.red;
      ctx.globalAlpha = flash * 0.12;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }

  function sheet(x, y, w, h, fold) {
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
  }

  function drawItem(it) {
    const { w, h } = it;
    ctx.save();
    ctx.translate(it.x, it.y);
    ctx.rotate(Math.sin(it.age * 3 + it.spin * 10) * it.spin * 0.3);
    const x = -w / 2;
    const y = -h / 2;
    const fold = w * 0.3;
    const color = it.kind === 'bad' ? C.bad : it.kind === 'bonus' ? C.gold : it.color;

    // Soft paper shadow, like a Material card
    ctx.shadowColor = 'rgba(60,64,67,.3)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    sheet(x, y, w, h, fold);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.shadowColor = 'transparent';

    ctx.beginPath();
    ctx.moveTo(x + w - fold, y);
    ctx.lineTo(x + w - fold, y + fold);
    ctx.lineTo(x + w, y + fold);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,.45)';
    ctx.fill();

    if (it.kind === 'bonus') {
      const s = w * 0.22;
      for (const [dx, dy] of [[0.16, 0.36], [0.56, 0.36], [0.16, 0.7]]) {
        ctx.fillStyle = '#3c2a00';
        ctx.fillRect(x + w * dx, y + h * dy - s / 2, s, s);
        ctx.fillStyle = C.gold;
        ctx.fillRect(x + w * dx + s * 0.3, y + h * dy - s * 0.2, s * 0.4, s * 0.4);
      }
      ctx.fillStyle = '#3c2a00';
      ctx.fillRect(x + w * 0.6, y + h * 0.66, s * 0.45, s * 0.45);
    } else if (it.kind === 'bad') {
      ctx.strokeStyle = C.red;
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x + w * 0.2, y + h * 0.3);
      ctx.lineTo(x + w * 0.45, y + h * 0.48);
      ctx.lineTo(x + w * 0.35, y + h * 0.58);
      ctx.lineTo(x + w * 0.62, y + h * 0.78);
      ctx.stroke();
      ctx.font = `700 ${Math.round(w * 0.34)}px Roboto, system-ui, sans-serif`;
      ctx.fillStyle = C.red;
      ctx.textAlign = 'center';
      ctx.fillText('!', x + w * 0.74, y + h * 0.52);
    } else {
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `500 ${Math.round(w * 0.27)}px Roboto, system-ui, sans-serif`;
      ctx.fillText(it.label, x + w / 2, y + h * 0.62);
      ctx.textBaseline = 'alphabetic';
    }
    ctx.restore();
  }

  function drawPhone() {
    const { w, h } = phone;
    const x = phone.x - w / 2;
    const y = H - h - 10;

    // Pixel-style phone: dark frame, light screen
    ctx.shadowColor = 'rgba(60,64,67,.35)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 3;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h + 30, 16);
    ctx.fillStyle = '#3c4043';
    ctx.fill();
    ctx.shadowColor = 'transparent';

    ctx.beginPath();
    ctx.roundRect(x + 4, y + 4, w - 8, h + 22, 12);
    ctx.fillStyle = phone.glow > 0 ? '#ffe8f2' : '#ffffff';
    ctx.fill();

    // Camera dot
    ctx.beginPath();
    ctx.arc(phone.x, y + 12, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#3c4043';
    ctx.fill();

    // Download icon in a blue circle; turns green on a catch
    const cy = y + h * 0.52;
    ctx.beginPath();
    ctx.arc(phone.x, cy, w * 0.26, 0, Math.PI * 2);
    ctx.fillStyle = phone.glow > 0 ? C.orange : C.pink;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const a = w * 0.12;
    ctx.beginPath();
    ctx.moveTo(phone.x, cy - a);
    ctx.lineTo(phone.x, cy + a * 0.8);
    ctx.moveTo(phone.x - a * 0.75, cy + a * 0.05);
    ctx.lineTo(phone.x, cy + a * 0.8);
    ctx.lineTo(phone.x + a * 0.75, cy + a * 0.05);
    ctx.stroke();
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
