'use strict';
// 各窗口共用：字体、图标、小工具。

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const query = new URLSearchParams(location.search);
const resourcesDirectory = query.get('resources');

/// 界面字体沿用仓库自带的阿里巴巴普惠体（Resources/Fonts），缺失时退回系统雅黑。
function loadFonts() {
  if (!resourcesDirectory) return;
  for (const [file, weight] of [['AlibabaPuHuiTi-3-55-Regular.otf', '400'], ['AlibabaPuHuiTi-3-65-Medium.otf', '500 600'], ['AlibabaPuHuiTi-3-75-SemiBold.otf', '700']]) {
    const face = new FontFace('DogSC PuHui', `url("${pathToFileURL(path.join(resourcesDirectory, 'Fonts', file)).href}")`, { weight });
    face.load().then((loaded) => document.fonts.add(loaded)).catch(() => {});
  }
}

const ICONS = {
  display: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  window: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3 9.5h18"/><circle cx="6.3" cy="7.3" r=".4"/><circle cx="8.6" cy="7.3" r=".4"/>',
  area: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" stroke-dasharray="0"/><path d="M11 4h2M11 20h2M4 11v2M20 11v2"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  camera: '<rect x="3" y="7" width="13" height="10" rx="2.5"/><path d="m16 11 5-3v8l-5-3z"/>',
  speaker: '<path d="M4 10v4h3l5 4V6L7 10z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10"/>',
  folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  memo: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M4 8.5h16M8 12.5h8M8 16h5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  flag: '<path d="M6 21V4M6 5h11l-2 3.5 2 3.5H6"/>',
  scissors: '<circle cx="6" cy="7" r="2.5"/><circle cx="6" cy="17" r="2.5"/><path d="M8 8.5 20 17M8 15.5 20 7"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5"/>',
  undo: '<path d="M8 6 4 10l4 4"/><path d="M4 10h10a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="m16 6 4 4-4 4"/><path d="M20 10H10a5 5 0 0 0 0 10h3"/>',
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor"/>',
  pause: '<path d="M8 5.5v13M16 5.5v13" stroke-width="3"/>',
  previous: '<path d="M18 6v12l-9-6z" fill="currentColor"/><path d="M7 6v12"/>',
  next: '<path d="M6 6v12l9-6z" fill="currentColor"/><path d="M17 6v12"/>',
  export: '<path d="M12 15V4M8 8l4-4 4 4M5 13v5.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V13"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  canvas: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3 15 4.5-4 4 3.5 3-2.5L21 16"/>',
  motion: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>',
  cursor: '<path d="M6 4v14l4-3.5 2.5 5.5 2.3-1-2.5-5.5H18z"/>',
  speed: '<path d="M4.5 16a8 8 0 1 1 15 0"/><path d="m12 14 4-5"/>',
  wand: '<path d="m5 19 10-10M14 5l.7 1.8L16.5 7.5l-1.8.7L14 10l-.7-1.8L11.5 7.5l1.8-.7zM18.5 12l.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5z"/>',
  reveal: '<path d="M14 4h6v6M20 4l-8 8M10 5H6.5A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19h11a1.5 1.5 0 0 0 1.5-1.5V14"/>',
  record: '<circle cx="12" cy="12" r="6.5" fill="currentColor" stroke="none"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  magnet: '<path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4zM6 8h4M14 8h4"/>',
};

const icon = (name) => `<svg class="icon" viewBox="0 0 24 24">${ICONS[name] || ''}</svg>`;

function formatTime(seconds, withFraction = true) {
  const value = Math.max(Number(seconds) || 0, 0);
  const minutes = Math.floor(value / 60);
  const rest = value - minutes * 60;
  const whole = String(Math.floor(rest)).padStart(2, '0');
  const pad = String(minutes).padStart(2, '0');
  return withFraction ? `${pad}:${whole}.${String(Math.floor((rest % 1) * 100)).padStart(2, '0')}` : `${pad}:${whole}`;
}

function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style') node.style.cssText = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== false && value !== null && value !== undefined) node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

loadFonts();

module.exports = { query, resourcesDirectory, icon, formatTime, element, fileUrl: (file) => pathToFileURL(file).href };
