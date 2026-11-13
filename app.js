'use strict';

const $ = (id) => document.getElementById(id);
const stage = $('stage'), video = $('video'), photo = $('photo'), photoWrap = $('photoWrap');
const marker = $('marker'), loupe = $('loupe'), message = $('message');
const cameraBtn = $('cameraBtn'), flipBtn = $('flipBtn'), fileInput = $('fileInput');
const result = $('result'), chip = $('chip'), palettes = $('palettes'), toast = $('toast'), paint = $('paint');

const ctx = photo.getContext('2d', { willReadFrequently: true });
const loupeCtx = loupe.getContext('2d');
const MAX_SIDE = 1600;
const hasCamera = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

let stream = null;
let facing = 'environment';

/* ---------- color math ---------- */

const toHex = ({ r, g, b }) =>
  '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s, l };
}

function hslToRgb({ h, s, l }) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const ch = (v) => Math.min(255, Math.max(0, Math.round((v + m) * 255)));
  return { r: ch(r), g: ch(g), b: ch(b) };
}

const rotate = (hsl, deg) => ({ ...hsl, h: (hsl.h + deg + 360) % 360 });
const withL = (hsl, l) => ({ ...hsl, l: Math.min(0.95, Math.max(0.06, l)) });

// Black or white text, whichever contrasts better (WCAG relative luminance).
function inkFor({ r, g, b }) {
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.179 ? '#111111' : '#ffffff';
}

function buildPalettes(hsl) {
  return [
    { name: 'Complementary', note: 'The opposite color on the wheel — maximum contrast.',
      colors: [hsl, rotate(hsl, 180)] },
    { name: 'Split complementary', note: 'The two neighbors of the opposite color — contrast, but softer.',
      colors: [rotate(hsl, 150), hsl, rotate(hsl, 210)] },
    { name: 'Analogous', note: 'Next-door colors that sit together calmly.',
      colors: [rotate(hsl, -30), hsl, rotate(hsl, 30)] },
    { name: 'Triadic', note: 'Three colors evenly spaced around the wheel.',
      colors: [hsl, rotate(hsl, 120), rotate(hsl, 240)] },
    { name: 'Tetradic', note: 'Four colors forming a square on the wheel.',
      colors: [hsl, rotate(hsl, 90), rotate(hsl, 180), rotate(hsl, 270)] },
    { name: 'Tints & shades', note: 'The same color, lighter and darker.',
      colors: [withL(hsl, hsl.l + 0.3), withL(hsl, hsl.l + 0.15), hsl, withL(hsl, hsl.l - 0.15), withL(hsl, hsl.l - 0.3)] },
  ];
}

/* ---------- paint mixing ---------- */

// Typical colors of common artist tube paints, straight from the tube.
const PAINTS = [
  { name: 'Titanium White', hex: '#F7F7F2' },
  { name: 'Ivory Black', hex: '#1C1C1E' },
  { name: 'Cadmium Yellow', hex: '#FFD300' },
  { name: 'Yellow Ochre', hex: '#C8912D' },
  { name: 'Cadmium Red', hex: '#D9232B' },
  { name: 'Quinacridone Magenta', hex: '#B0175A' },
  { name: 'Ultramarine Blue', hex: '#1F2F9E' },
  { name: 'Phthalo Blue', hex: '#0B4F9C' },
  { name: 'Phthalo Green', hex: '#0A6B52' },
  { name: 'Burnt Umber', hex: '#5B3A24' },
];

const srgbToLin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const linToSrgb = (v) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
const hexToRgb = (hex) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) });

// Paint mixes by absorbing light, not adding it (blue + yellow gives green, not grey).
// Kubelka-Munk models that: each paint gets an absorption/scatter ratio per color
// channel, and those ratios blend in proportion to the amount of each paint.
for (const p of PAINTS) {
  const { r, g, b } = hexToRgb(p.hex);
  p.ks = [r, g, b].map((v) => { const R = Math.max(0.004, srgbToLin(v)); return (1 - R) ** 2 / (2 * R); });
}

function mixPaints(indexes, parts) {
  const total = parts.reduce((a, b) => a + b, 0);
  const lin = [0, 1, 2].map((ch) => {
    let ks = 0;
    indexes.forEach((pi, i) => { ks += PAINTS[pi].ks[ch] * parts[i] / total; });
    return 1 + ks - Math.sqrt(ks * ks + 2 * ks);
  });
  return lin;
}

// CIE Lab, so "closest" means closest to the eye rather than closest in RGB numbers.
function linToLab([r, g, b]) {
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);
// Strong paints (black, phthalos) overpower others, so amounts must be able to differ a lot.
const AMOUNTS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48];

// Try every recipe of up to three paints and keep the closest, gently preferring simpler ones.
function findRecipe(rgb) {
  const target = linToLab([rgb.r, rgb.g, rgb.b].map(srgbToLin));
  let best = null;
  const consider = (indexes, parts) => {
    const lin = mixPaints(indexes, parts);
    const lab = linToLab(lin);
    const dE = Math.hypot(lab[0] - target[0], lab[1] - target[1], lab[2] - target[2]);
    const score = dE + 0.5 * indexes.length + 0.01 * parts.reduce((x, y) => x + y, 0);
    if (!best || score < best.score) best = { score, dE, indexes, parts, lin };
  };
  const n = PAINTS.length;
  for (let i = 0; i < n; i++) {
    consider([i], [1]);
    for (let j = i + 1; j < n; j++) {
      for (const a of AMOUNTS) {
        for (const b of AMOUNTS) {
          if (gcd(a, b) === 1) consider([i, j], [a, b]);
          for (let k = j + 1; k < n; k++) {
            for (const c of AMOUNTS) {
              if (gcd(gcd(a, b), c) === 1) consider([i, j, k], [a, b, c]);
            }
          }
        }
      }
    }
  }
  const mixRgb = { r: linToSrgb(best.lin[0]), g: linToSrgb(best.lin[1]), b: linToSrgb(best.lin[2]) };
  const items = best.indexes
    .map((pi, i) => ({ ...PAINTS[pi], parts: best.parts[i] }))
    .sort((x, y) => y.parts - x.parts);
  return { items, mixRgb, dE: best.dE };
}

let currentRgb = null;

function showRecipe() {
  if (!currentRgb || !paint.open) return;
  const { items, mixRgb, dE } = findRecipe(currentRgb);
  const set = (el, rgb) => { el.style.background = toHex(rgb); el.style.color = inkFor(rgb); };
  set($('paintTarget'), currentRgb);
  set($('paintMix'), mixRgb);
  $('paintQuality').textContent =
    dE < 4 ? 'Very close match.' :
    dE < 10 ? 'Close match — expect a slight difference.' :
    'Nearest these paints can get — this exact color is beyond what a simple mix can reach.';
  $('recipe').replaceChildren(...items.map((it) => {
    const li = document.createElement('li');
    const dot = Object.assign(document.createElement('span'), { className: 'dot' });
    dot.style.background = it.hex;
    const name = Object.assign(document.createElement('span'), { textContent: it.name });
    const parts = Object.assign(document.createElement('span'), {
      className: 'parts',
      textContent: items.length === 1 ? 'straight from the tube' : `${it.parts} ${it.parts === 1 ? 'part' : 'parts'}`,
    });
    li.append(dot, name, parts);
    return li;
  }));
}

/* ---------- store paint matching ---------- */

const store = $('store'), brand = $('brand');
const brandData = {}; // brand id -> promise of [{ name, code, hex, lab }]

function loadBrand(id) {
  if (!brandData[id]) {
    brandData[id] = fetch(`data/${id}.json`)
      .then((res) => { if (!res.ok) throw new Error(res.status); return res.json(); })
      .then((rows) => rows.map(([name, code, hex]) => {
        const { r, g, b } = hexToRgb('#' + hex);
        return { name, code, hex: '#' + hex, lab: linToLab([r, g, b].map(srgbToLin)) };
      }))
      .catch((err) => { delete brandData[id]; throw err; });
  }
  return brandData[id];
}

async function showStoreMatches() {
  if (!currentRgb || !store.open) return;
  const id = brand.value, rgb = currentRgb;
  const status = $('storeStatus'), list = $('storeList');
  let colors;
  try {
    colors = await loadBrand(id);
  } catch {
    if (id === brand.value) {
      status.textContent = 'Could not load this brand\u2019s colors. Check your connection and try again.';
      list.replaceChildren();
    }
    return;
  }
  if (id !== brand.value || rgb !== currentRgb) return; // a newer request superseded this one
  const t = linToLab([rgb.r, rgb.g, rgb.b].map(srgbToLin));
  const top = colors
    .map((c) => ({ c, d: Math.hypot(c.lab[0] - t[0], c.lab[1] - t[1], c.lab[2] - t[2]) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, 3);
  status.textContent = `Closest 3 of ${colors.length.toLocaleString()} colors`;
  list.replaceChildren(...top.map(({ c, d }) => {
    const li = document.createElement('li');
    const dot = Object.assign(document.createElement('span'), { className: 'dot big' });
    dot.style.background = c.hex;
    const who = Object.assign(document.createElement('span'), { className: 'who' });
    who.append(
      Object.assign(document.createElement('span'), { textContent: c.name }),
      Object.assign(document.createElement('small'), { textContent: `${c.code} \u00b7 ${c.hex}` })
    );
    const fit = Object.assign(document.createElement('span'), { className: 'parts' });
    fit.textContent = d < 2 ? 'Near exact' : d < 5 ? 'Very close' : d < 10 ? 'Close' : 'Loose';
    li.append(dot, who, fit);
    return li;
  }));
}

store.addEventListener('toggle', showStoreMatches);
brand.addEventListener('change', showStoreMatches);

/* ---------- UI ---------- */

function say(text, isError = false) {
  message.textContent = text;
  message.classList.toggle('error', isError);
}

let toastTimer;
function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1500);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) return showToast(text);
  }
  showToast(`Copied ${text}`);
}

function showColor(rgb) {
  const hex = toHex(rgb);
  const hsl = rgbToHsl(rgb);
  chip.style.background = hex;
  chip.style.color = inkFor(rgb);
  chip.dataset.hex = hex;
  $('hex').textContent = hex;
  $('rgb').textContent = `${rgb.r}, ${rgb.g}, ${rgb.b}`;
  $('hsl').textContent = `${Math.round(hsl.h)}°, ${Math.round(hsl.s * 100)}%, ${Math.round(hsl.l * 100)}%`;
  result.hidden = false;

  palettes.replaceChildren(...buildPalettes(hsl).map((p) => {
    const section = document.createElement('section');
    section.className = 'palette';
    const h2 = Object.assign(document.createElement('h2'), { textContent: p.name });
    const note = Object.assign(document.createElement('p'), { textContent: p.note });
    const row = document.createElement('div');
    row.className = 'swatches';
    for (const c of p.colors) {
      const cRgb = hslToRgb(c), cHex = toHex(cRgb);
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'swatch', textContent: cHex });
      b.style.background = cHex;
      b.style.color = inkFor(cRgb);
      b.dataset.hex = cHex;
      b.setAttribute('aria-label', `Copy ${cHex}`);
      row.append(b);
    }
    section.append(h2, note, row);
    return section;
  }));
  palettes.hidden = false;

  currentRgb = rgb;
  paint.hidden = false;
  showRecipe();
  store.hidden = false;
  showStoreMatches();
}

/* ---------- camera ---------- */

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
}

async function startCamera() {
  stopCamera();
  if (!hasCamera) {
    // No live camera API (or insecure page): fall back to the system camera/picker.
    fileInput.setAttribute('capture', 'environment');
    fileInput.click();
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch (err) {
    const denied = err.name === 'NotAllowedError' || err.name === 'SecurityError';
    say(denied
      ? 'Camera access was blocked. Allow it in your browser settings, or choose a photo instead.'
      : 'No camera could be started. You can choose a photo instead.', true);
    return;
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  stage.dataset.mode = 'live';
  cameraBtn.textContent = 'Take picture';
  marker.hidden = true;
  say('Point at something colorful.');
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  flipBtn.hidden = devices.filter((d) => d.kind === 'videoinput').length < 2;
}

function showPhoto(source, w, h) {
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  photo.width = Math.round(w * scale);
  photo.height = Math.round(h * scale);
  ctx.drawImage(source, 0, 0, photo.width, photo.height);
  stage.dataset.mode = 'photo';
  cameraBtn.textContent = 'Retake';
  flipBtn.hidden = true;
  marker.hidden = true;
  say('Tap or drag on the picture to pick a color.');
}

function takePicture() {
  if (!video.videoWidth) return;
  showPhoto(video, video.videoWidth, video.videoHeight);
  stopCamera();
  pickAt(photo.width / 2, photo.height / 2); // start with the center color
}

cameraBtn.addEventListener('click', () => {
  if (stage.dataset.mode === 'live') takePicture();
  else startCamera();
});

flipBtn.addEventListener('click', () => {
  facing = facing === 'environment' ? 'user' : 'environment';
  startCamera();
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    stopCamera();
    showPhoto(bmp, bmp.width, bmp.height);
    bmp.close();
    pickAt(photo.width / 2, photo.height / 2);
  } catch {
    say('That file could not be opened as an image.', true);
  }
});

/* ---------- picking ---------- */

// Average a small square so sensor noise doesn't skew the result.
function sample(x, y, radius = 2) {
  const x0 = Math.max(0, x - radius), y0 = Math.max(0, y - radius);
  const w = Math.min(photo.width, x + radius + 1) - x0;
  const h = Math.min(photo.height, y + radius + 1) - y0;
  const d = ctx.getImageData(x0, y0, w, h).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const n = d.length / 4;
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

function pickAt(x, y) {
  x = Math.min(photo.width - 1, Math.max(0, Math.round(x)));
  y = Math.min(photo.height - 1, Math.max(0, Math.round(y)));
  const left = (x / photo.width) * 100 + '%', top = (y / photo.height) * 100 + '%';
  marker.style.left = loupe.style.left = left;
  marker.style.top = loupe.style.top = top;
  marker.hidden = false;
  showColor(sample(x, y));
  return { x, y };
}

function drawLoupe(x, y) {
  const span = 15, half = (span - 1) / 2, size = loupe.width;
  loupeCtx.imageSmoothingEnabled = false;
  loupeCtx.fillStyle = '#000';
  loupeCtx.fillRect(0, 0, size, size);
  loupeCtx.drawImage(photo, x - half, y - half, span, span, 0, 0, size, size);
  const cell = size / span;
  loupeCtx.lineWidth = 2;
  loupeCtx.strokeStyle = '#fff';
  loupeCtx.strokeRect(size / 2 - cell * 2.5, size / 2 - cell * 2.5, cell * 5, cell * 5);
}

// The loupe floats above the finger; near the top of the screen it moves to the side instead.
function placeLoupe(e) {
  const above = e.clientY > 160;
  const toRight = e.clientX < window.innerWidth / 2;
  loupe.style.marginTop = above ? '' : '-55px';
  loupe.style.marginLeft = above ? '' : toRight ? '45px' : '-155px';
}

function pointerPick(e) {
  const rect = photo.getBoundingClientRect();
  const p = pickAt(
    ((e.clientX - rect.left) / rect.width) * photo.width,
    ((e.clientY - rect.top) / rect.height) * photo.height
  );
  drawLoupe(p.x, p.y);
  placeLoupe(e);
}

photo.addEventListener('pointerdown', (e) => {
  photo.setPointerCapture(e.pointerId);
  loupe.hidden = false;
  pointerPick(e);
});
photo.addEventListener('pointermove', (e) => {
  if (photo.hasPointerCapture(e.pointerId)) pointerPick(e);
});
for (const type of ['pointerup', 'pointercancel']) {
  photo.addEventListener(type, () => { loupe.hidden = true; });
}

paint.addEventListener('toggle', showRecipe);

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-hex]');
  if (el) copy(el.dataset.hex);
});

document.addEventListener('visibilitychange', () => {
  // Release the camera when the app goes to the background.
  if (document.hidden && stage.dataset.mode === 'live') {
    stopCamera();
    stage.dataset.mode = 'idle';
    cameraBtn.textContent = 'Open camera';
    flipBtn.hidden = true;
  }
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
