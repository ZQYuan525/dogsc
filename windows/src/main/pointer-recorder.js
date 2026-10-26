'use strict';
// 录制期间记录指针：位置、左右键点击、当时的光标形状。
// macOS 版监听 CGEvent；Windows 上改为通过 user32 轮询，只在位置变化或按键按下时落一条事件，
// 产出的事件流形状与原版一致（稀疏的 move + click），后期的弹簧平滑才能沿用同一套静止判定。

const { screen } = require('electron');

const VK_LBUTTON = 0x01;
const VK_RBUTTON = 0x02;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const IDC = { arrow: 32512, ibeam: 32513, hand: 32649 };

let native = null;
let nativeError = null;

function loadNative() {
  if (native || nativeError) return native;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const dwmapi = koffi.load('dwmapi.dll');
    const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
    const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
    const CURSORINFO = koffi.struct('CURSORINFO', { cbSize: 'uint32', flags: 'uint32', hCursor: 'uintptr_t', ptScreenPos: POINT });
    const LoadCursorW = user32.func('uintptr_t __stdcall LoadCursorW(uintptr_t instance, uintptr_t name)');
    native = {
      GetCursorPos: user32.func('bool __stdcall GetCursorPos(_Out_ POINT *point)'),
      GetAsyncKeyState: user32.func('short __stdcall GetAsyncKeyState(int key)'),
      GetCursorInfo: user32.func('bool __stdcall GetCursorInfo(_Inout_ CURSORINFO *info)'),
      GetClientRect: user32.func('bool __stdcall GetClientRect(uintptr_t window, _Out_ RECT *rect)'),
      ClientToScreen: user32.func('bool __stdcall ClientToScreen(uintptr_t window, _Inout_ POINT *point)'),
      IsWindow: user32.func('bool __stdcall IsWindow(uintptr_t window)'),
      IsIconic: user32.func('bool __stdcall IsIconic(uintptr_t window)'),
      ShowWindow: user32.func('bool __stdcall ShowWindow(uintptr_t window, int command)'),
      SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(uintptr_t window)'),
      DwmGetWindowAttribute: dwmapi.func('long __stdcall DwmGetWindowAttribute(uintptr_t window, uint32 attribute, _Out_ RECT *value, uint32 size)'),
      cursorInfoSize: koffi.sizeof(CURSORINFO),
      rectSize: koffi.sizeof(RECT),
      cursors: new Map(Object.entries(IDC).map(([name, id]) => [String(LoadCursorW(0, id)), name])),
    };
  } catch (error) {
    nativeError = error;
  }
  return native;
}

/// 窗口在屏幕上的物理像素矩形。frame 含标题栏与边框（不含不可见的缩放边），client 只有内容区。
function windowRects(hwnd) {
  const api = loadNative();
  if (!api || !api.IsWindow(hwnd)) return null;
  const frame = {};
  if (api.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, frame, api.rectSize) !== 0) return null;
  const clientSize = {};
  const origin = { x: 0, y: 0 };
  if (!api.GetClientRect(hwnd, clientSize) || !api.ClientToScreen(hwnd, origin)) return null;
  return {
    frame: { x: frame.left, y: frame.top, width: frame.right - frame.left, height: frame.bottom - frame.top },
    client: { x: origin.x, y: origin.y, width: clientSize.right, height: clientSize.bottom },
  };
}

/// 录制窗口前把它还原并切到前台，保证采集区域里看到的就是它。
function bringToFront(hwnd) {
  const api = loadNative();
  if (!api || !api.IsWindow(hwnd)) return false;
  if (api.IsIconic(hwnd)) api.ShowWindow(hwnd, 9); // SW_RESTORE
  api.SetForegroundWindow(hwnd);
  return true;
}

class PointerRecorder {
  /// getRect 返回当前采集区域的物理像素矩形（窗口录制时会随窗口移动）。
  constructor(getRect) {
    this.getRect = getRect;
    this.events = [];
    this.timer = null;
    this.last = null;
    this.buttons = { left: false, right: false };
    this.api = loadNative();
  }

  get hasClickSupport() { return Boolean(this.api); }

  // 与 ffmpeg 打印首帧时间用的是同一个系统时钟。
  now() { return Date.now() / 1000; }

  read() {
    if (this.api) {
      const point = {};
      if (!this.api.GetCursorPos(point)) return null;
      const info = { cbSize: this.api.cursorInfoSize, flags: 0, hCursor: 0, ptScreenPos: { x: 0, y: 0 } };
      const cursor = this.api.GetCursorInfo(info) ? (this.api.cursors.get(String(info.hCursor)) || 'arrow') : 'arrow';
      return {
        x: point.x,
        y: point.y,
        cursor,
        left: (this.api.GetAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0,
        right: (this.api.GetAsyncKeyState(VK_RBUTTON) & 0x8000) !== 0,
      };
    }
    // 没有 user32 绑定时退回 Electron 接口：只有位置，没有点击。
    const point = screen.dipToScreenPoint(screen.getCursorScreenPoint());
    return { x: point.x, y: point.y, cursor: 'arrow', left: false, right: false };
  }

  tick() {
    const state = this.read();
    const rect = this.getRect();
    if (!state || !rect || rect.width <= 0 || rect.height <= 0) return;
    const time = this.now();
    const x = (state.x - rect.x) / rect.width;
    const y = (state.y - rect.y) / rect.height;
    const push = (kind) => this.events.push({ time, x, y, kind, cursor: state.cursor });
    if (!this.last || this.last.x !== x || this.last.y !== y) push('move');
    if (state.left && !this.buttons.left) push('leftClick');
    if (state.right && !this.buttons.right) push('rightClick');
    this.last = { x, y };
    this.buttons = { left: state.left, right: state.right };
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 8);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    return this.events;
  }
}

/// 把系统时钟事件换算成素材时间（以屏幕首帧为 0），并在 0 时刻补一个种子点，
/// 保证画面一开始光标就在正确位置。采集区域外的移动夹到边缘并在渲染时隐藏。
function toSourceTimeline(events, firstFrameTime, duration) {
  const result = [];
  let seed = null;
  for (const event of events) {
    const time = event.time - firstFrameTime;
    if (time < 0) {
      if (event.kind === 'move') seed = event;
      continue;
    }
    if (time > duration) break;
    if (!result.length && seed) result.push({ ...seed, time: 0, kind: 'move' });
    result.push({ ...event, time });
  }
  if (!result.length && seed) result.push({ ...seed, time: 0, kind: 'move' });
  const round = (value) => Math.round(value * 1e5) / 1e5;
  return result.map((event) => ({ time: Math.round(event.time * 1e4) / 1e4, x: round(event.x), y: round(event.y), kind: event.kind, cursor: event.cursor }));
}

module.exports = { PointerRecorder, toSourceTimeline, windowRects, bringToFront, loadNative };
