/**
 * Visual effects for the home page:
 * - a soft spotlight and glowing rim that follow the mouse over the cards
 * - sections fading in as they scroll into view
 * - confetti when a QR code is ready
 * All of it is skipped when the person prefers reduced motion.
 */

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- Mouse spotlight on cards ----------
const panel = document.querySelector('.panel');
if (panel && matchMedia('(hover: hover)').matches) {
  panel.addEventListener('pointermove', (e) => {
    const card = e.target.closest('.card, .ticket');
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
  });
}

// ---------- Reveal on scroll ----------
const reveals = document.querySelectorAll('.reveal');
if (reduceMotion || !('IntersectionObserver' in window)) {
  reveals.forEach((el) => el.classList.add('in'));
} else {
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      }
    }
  }, { threshold: 0.12 });
  reveals.forEach((el) => io.observe(el));
}

// ---------- Confetti when a code is ready ----------
const themeCss = getComputedStyle(document.documentElement);
const COLORS = ['--c1', '--c2', '--c3', '--accent'].map((n) => themeCss.getPropertyValue(n).trim()).filter(Boolean).concat(['#fbbc04', '#ffffff']);

export function confetti(count = 90) {
  if (reduceMotion) return;
  const layer = document.createElement('div');
  layer.className = 'confetti';
  layer.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < count; i++) {
    const piece = document.createElement('i');
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = COLORS[i % COLORS.length];
    piece.style.setProperty('--dx', `${(Math.random() - 0.5) * 260}px`);
    piece.style.setProperty('--rot', `${(Math.random() - 0.5) * 1440}deg`);
    piece.style.setProperty('--dur', `${1.3 + Math.random() * 1.4}s`);
    piece.style.animationDelay = `${Math.random() * 0.35}s`;
    if (Math.random() < 0.3) { piece.style.width = '7px'; piece.style.height = '7px'; piece.style.borderRadius = '50%'; }
    layer.append(piece);
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 3400);
}

// Fire once each time the "ready to scan" ticket appears.
for (const id of ['done', 'direct']) {
  const el = document.getElementById(id);
  if (!el) continue;
  let wasHidden = el.classList.contains('hidden');
  new MutationObserver(() => {
    const hidden = el.classList.contains('hidden');
    if (wasHidden && !hidden && id === 'done') confetti();
    wasHidden = hidden;
  }).observe(el, { attributes: true, attributeFilter: ['class'] });
}

// Direct transfers celebrate when someone actually receives the file.
const count = document.getElementById('dCount');
if (count) {
  let last = count.textContent;
  new MutationObserver(() => {
    if (count.textContent !== last && !count.textContent.startsWith('0')) confetti(60);
    last = count.textContent;
  }).observe(count, { childList: true, characterData: true, subtree: true });
}

// ---------- Site navigation (home page) ----------
const nav = document.querySelector('header.nav');
const toggle = document.getElementById('navToggle');
if (nav && toggle) {
  const setOpen = (open) => {
    nav.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  };
  toggle.addEventListener('click', () => setOpen(!nav.classList.contains('open')));
  // Close the phone menu after picking a link, or when tapping elsewhere / pressing Escape.
  nav.querySelectorAll('.nav-links a').forEach((a) => a.addEventListener('click', () => setOpen(false)));
  document.addEventListener('click', (e) => { if (!nav.contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
}

// "Send a file" buttons: scroll to the card and put focus on the drop area.
document.querySelectorAll('a[href="#send"]').forEach((a) => {
  a.addEventListener('click', (e) => {
    const target = document.getElementById('send');
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    const drop = document.getElementById('dropzone');
    if (drop && drop.offsetParent) setTimeout(() => drop.focus({ preventScroll: true }), reduceMotion ? 0 : 450);
  });
});
