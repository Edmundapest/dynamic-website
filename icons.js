// Server-side themed icon generator.
//
// Produces a PNG "brick wall" icon tinted with a caller-supplied theme, so the
// browser tab icon (and the icon captured on a fresh Add-to-Home-Screen) can
// match each visitor's chosen colors. No dependencies: we build the pixels and
// hand-encode a PNG.
//
// NOTE: this cannot restyle an icon that is *already* on a home screen — the OS
// launcher caches the installed icon and there is no web API to change it. It
// only affects a fresh install (and the live favicon).
const zlib = require("zlib");

const HEX = /^#?[0-9a-fA-F]{6}$/;

// Accepts "abc123", "#abc123" (and 3-digit shorthand); returns "#rrggbb".
function normHex(value, fallback) {
  if (typeof value !== "string") return fallback;
  let v = value.trim();
  if (/^#?[0-9a-fA-F]{3}$/.test(v)) {
    v = v.replace(/^#/, "").replace(/(.)/g, "$1$1");
  }
  if (!HEX.test(v)) return fallback;
  return "#" + v.replace(/^#/, "").toLowerCase();
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function clamp(v) { return Math.max(0, Math.min(255, Math.round(v))); }

// --- minimal PNG encoder (RGBA, no filtering) -----------------------------
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// --- drawing --------------------------------------------------------------
// A staggered brick pattern: mortar uses the theme background, bricks blend
// accent -> accent2. Full-bleed (opaque) so it's safe as a maskable icon.
function draw(size, colors) {
  const buf = Buffer.alloc(size * size * 4);
  const A = hexToRgb(colors.accent);
  const B = hexToRgb(colors.accent2);
  const BG = hexToRgb(colors.bg);

  const rows = 5;
  const rh = Math.round(size / rows);
  const bw = Math.round(size / 2.5);
  const g = Math.max(2, Math.round(size / 70)); // mortar thickness

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const row = Math.floor(y / rh);
      const off = row % 2 ? Math.round(bw / 2) : 0;
      const col = Math.floor((x + off) / bw);
      const lx = x + off - col * bw;
      const ly = y - row * rh;

      let r, gr, b;
      if (lx <= g || ly <= g) {
        r = BG[0]; gr = BG[1]; b = BG[2];
      } else {
        const t = (x + y) / (size * 2);
        const shade = 1 - (row % 2) * 0.06;
        r = clamp((A[0] + (B[0] - A[0]) * t) * shade);
        gr = clamp((A[1] + (B[1] - A[1]) * t) * shade);
        b = clamp((A[2] + (B[2] - A[2]) * t) * shade);
        if (ly <= g * 2) { r = clamp(r + 55); gr = clamp(gr + 55); b = clamp(b + 55); } // top edge highlight
      }
      const i = (y * size + x) * 4;
      buf[i] = r; buf[i + 1] = gr; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }
  return buf;
}

function render(size, colors) {
  return encodePNG(size, size, draw(size, colors));
}

module.exports = { render, normHex };
