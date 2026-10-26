'use strict';
// 光标贴图：直接读取 Windows 自带的 .cur（含 128px 的 32 位图与热点），
// 相当于 macOS 版 CursorAssetLibrary 取系统光标。读不到时退回矢量箭头。

const fs = require('node:fs');
const path = require('node:path');

const SYSTEM_CURSORS = { arrow: 'aero_arrow_xl.cur', hand: 'aero_link_xl.cur' };

/// 取 .cur 里最大的 32 位位图，裁掉透明边，返回画布与（相对裁切后画布的）热点。
function decodeCursorFile(file) {
  const data = fs.readFileSync(file);
  if (data.readUInt16LE(2) !== 2) return null;
  let best = null;
  for (let i = 0; i < data.readUInt16LE(4); i++) {
    const entry = 6 + i * 16;
    const offset = data.readUInt32LE(entry + 12);
    if (data.readUInt32LE(offset) !== 40 || data.readUInt16LE(offset + 14) !== 32) continue;
    const width = data.readInt32LE(offset + 4);
    if (!best || width > best.width) {
      best = { width, height: data.readInt32LE(offset + 8) / 2, hotspotX: data.readUInt16LE(entry + 4), hotspotY: data.readUInt16LE(entry + 6), pixels: offset + 40 };
    }
  }
  if (!best) return null;
  const { width, height } = best;
  const image = new ImageData(width, height);
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    const row = best.pixels + (height - 1 - y) * width * 4; // DIB 行序自下而上，像素为 BGRA
    for (let x = 0; x < width; x++) {
      const source = row + x * 4;
      const target = (y * width + x) * 4;
      const alpha = data[source + 3];
      image.data[target] = data[source + 2];
      image.data[target + 1] = data[source + 1];
      image.data[target + 2] = data[source];
      image.data[target + 3] = alpha;
      if (alpha > 8) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) return null;
  const full = new OffscreenCanvas(width, height);
  full.getContext('2d').putImageData(image, 0, 0);
  const canvas = new OffscreenCanvas(right - left + 1, bottom - top + 1);
  canvas.getContext('2d').drawImage(full, -left, -top);
  return { canvas, width: canvas.width, height: canvas.height, hotspotX: best.hotspotX - left, hotspotY: best.hotspotY - top };
}

function vectorArrow() {
  const size = 128;
  const canvas = new OffscreenCanvas(size * 0.62, size);
  const ctx = canvas.getContext('2d');
  const points = [[0.04, 0.03], [0.04, 0.80], [0.22, 0.63], [0.34, 0.93], [0.45, 0.88], [0.33, 0.59], [0.57, 0.59]];
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x * size, y * size) : ctx.moveTo(x * size, y * size)));
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.lineWidth = size * 0.05;
  ctx.strokeStyle = '#111';
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.stroke();
  return { canvas, width: canvas.width, height: canvas.height, hotspotX: 0.04 * size, hotspotY: 0.03 * size };
}

function vectorBeam(height) {
  const width = Math.round(height * 0.44);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const inset = height * 0.08;
  const draw = (lineWidth, color) => {
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const y of [inset, height - inset]) {
      ctx.moveTo(width * 0.2, y); ctx.lineTo(width * 0.42, y);
      ctx.moveTo(width * 0.58, y); ctx.lineTo(width * 0.8, y);
    }
    ctx.moveTo(width / 2, inset * 1.4); ctx.lineTo(width / 2, height - inset * 1.4);
    ctx.stroke();
  };
  draw(height * 0.085, '#fff');
  draw(height * 0.04, '#111');
  return { canvas, width, height, hotspotX: width / 2, hotspotY: height / 2 };
}

let library = null;

/// 所有光标按"箭头高度 = 参考高度"的同一比例缩放，手型等保持与箭头的原生大小关系。
function cursorLibrary() {
  if (library) return library;
  const directory = path.join(process.env.SystemRoot || 'C:\\Windows', 'Cursors');
  const load = (name) => {
    try { return decodeCursorFile(path.join(directory, SYSTEM_CURSORS[name])); } catch { return null; }
  };
  const arrow = load('arrow') || vectorArrow();
  const hand = load('hand') || arrow;
  const ibeam = vectorBeam(Math.round(arrow.height * 0.9));
  library = { referenceHeight: arrow.height, arrow, hand, pointingHand: hand, ibeam };
  return library;
}

module.exports = { cursorLibrary };
