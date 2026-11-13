'use strict';

const $ = (id) => document.getElementById(id);
const stage = $('stage'), video = $('video'), photo = $('photo'), photoWrap = $('photoWrap');
const marker = $('marker'), loupe = $('loupe'), message = $('message');
const cameraBtn = $('cameraBtn'), flipBtn = $('flipBtn'), fileInput = $('fileInput');
const result = $('result'), chip = $('chip'), palettes = $('palettes'), toast = $('toast');

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
