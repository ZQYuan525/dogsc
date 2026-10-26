'use strict';
// 悬浮录制条。屏幕画面由主进程的 ffmpeg 采集；摄像头、麦克风、系统声音在这里用 MediaRecorder
// 各自写成文件，并记下开始时的系统时钟，结束后由主进程对齐到屏幕时间轴。

const fs = require('node:fs');
const path = require('node:path');
const { ipcRenderer } = require('electron');
const { icon, formatTime } = require('./common');

const $ = (id) => document.getElementById(id);
const settingsKey = 'dogsc.recorder';
const saved = JSON.parse(localStorage.getItem(settingsKey) || '{}');
const state = {
  environment: { ok: false, reason: '正在检查 ffmpeg…' },
  displays: [],
  selection: { kind: 'display', displayId: null },
  selectionLabel: '',
  mic: { on: saved.mic ?? true, deviceId: saved.micId || null },
  cam: { on: false, deviceId: saved.camId || null },
  sys: { on: saved.sys ?? true },
  session: null,
  result: null,
};
const persist = () => localStorage.setItem(settingsKey, JSON.stringify({ mic: state.mic.on, micId: state.mic.deviceId, camId: state.cam.deviceId, sys: state.sys.on }));

const SOURCE_LABELS = { display: '显示器', window: '窗口', area: '区域' };
document.querySelectorAll('.source').forEach((button) => {
  const kind = button.dataset.source;
  button.innerHTML = `${icon(kind)}<span>${SOURCE_LABELS[kind]}</span>`;
  button.addEventListener('click', () => chooseSource(kind));
});
$('mic').innerHTML = icon('mic');
$('cam').innerHTML = icon('camera');
$('sys').innerHTML = icon('speaker');
$('start').innerHTML = `${icon('record')}开始录制`;
$('stop').innerHTML = `${icon('stop')}结束`;
$('marker').innerHTML = `${icon('flag')}<span>标记</span>`;
$('memo2').innerHTML = icon('memo');
$('library').innerHTML = icon('folder');
$('memo').innerHTML = icon('memo');
$('quit').innerHTML = icon('close');

function show(panel) {
  for (const id of ['idle', 'live', 'busy', 'done']) $(id).hidden = id !== panel;
}

function render() {
  document.querySelectorAll('.source').forEach((button) => {
    const active = button.dataset.source === state.selection.kind;
    button.classList.toggle('active', active);
    button.querySelector('span').textContent = active && state.selectionLabel ? state.selectionLabel : SOURCE_LABELS[button.dataset.source];
    button.title = active && state.selectionLabel ? state.selectionLabel : '';
  });
  $('mic').classList.toggle('on', state.mic.on);
  $('cam').classList.toggle('on', state.cam.on);
  $('sys').classList.toggle('on', state.sys.on);
  const hint = $('hint');
  hint.classList.toggle('error', !state.environment.ok);
  if (!state.environment.ok) {
    hint.querySelector('b').textContent = '暂时不能录制';
    hint.querySelector('small').textContent = state.environment.reason;
    hint.title = state.environment.reason;
  } else {
    hint.querySelector('b').textContent = '保存到 项目';
    hint.querySelector('small').textContent = state.environment.encoder || '';
    hint.title = state.environment.projectsRoot || '';
  }
  $('start').disabled = !state.environment.ok;
}

async function chooseSource(kind) {
  if (kind === 'display') {
    let display = state.displays.find((item) => item.isPrimary) || state.displays[0];
    if (state.displays.length > 1) {
      const chosen = await ipcRenderer.invoke('recorder:menu', state.displays.map((item) => ({
        id: String(item.id), label: `${item.label}　${item.physical.width}×${item.physical.height}${item.isPrimary ? '（主屏）' : ''}`, checked: state.selection.displayId === item.id,
      })));
      if (!chosen) return;
      display = state.displays.find((item) => String(item.id) === chosen);
    }
    state.selection = { kind: 'display', displayId: display.id };
    state.selectionLabel = state.displays.length > 1 ? display.label : '';
  } else if (kind === 'window') {
    const choice = await ipcRenderer.invoke('recorder:pick-window');
    if (!choice) return;
    state.selection = { kind: 'window', hwnd: choice.hwnd, title: choice.title };
    state.selectionLabel = choice.title;
  } else {
    const area = await ipcRenderer.invoke('recorder:pick-area');
    if (!area) return;
    state.selection = { kind: 'area', displayId: area.displayId, rect: area.rect };
    state.selectionLabel = `${area.rect.width}×${area.rect.height}`;
  }
  render();
}

async function deviceMenu(kind, target) {
  // 设备名称要先拿到一次授权才会给出。
  await navigator.mediaDevices.getUserMedia(kind === 'audioinput' ? { audio: true } : { video: true }).then((stream) => stream.getTracks().forEach((track) => track.stop())).catch(() => {});
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === kind && device.deviceId !== 'communications');
  if (!devices.length) {
    await ipcRenderer.invoke('recorder:menu', [{ id: 'none', label: kind === 'audioinput' ? '没有找到麦克风' : '没有找到摄像头', enabled: false }]);
    return;
  }
  const chosen = await ipcRenderer.invoke('recorder:menu', devices.map((device) => ({
    id: device.deviceId, label: device.label || '未命名设备', checked: target.deviceId ? target.deviceId === device.deviceId : device.deviceId === 'default',
  })));
  if (!chosen) return;
  target.deviceId = chosen;
  target.on = true;
  persist();
  if (target === state.cam) ipcRenderer.send('recorder:camera-preview', { visible: true, deviceId: chosen });
  render();
}

$('mic').addEventListener('click', () => { state.mic.on = !state.mic.on; persist(); render(); });
$('mic').addEventListener('contextmenu', () => deviceMenu('audioinput', state.mic));
$('cam').addEventListener('click', () => {
  state.cam.on = !state.cam.on;
  ipcRenderer.send('recorder:camera-preview', { visible: state.cam.on, deviceId: state.cam.deviceId });
  render();
});
$('cam').addEventListener('contextmenu', () => deviceMenu('videoinput', state.cam));
$('sys').addEventListener('click', () => { state.sys.on = !state.sys.on; persist(); render(); });
$('library').addEventListener('click', () => ipcRenderer.send('recorder:library'));
$('memo').addEventListener('click', () => ipcRenderer.send('recorder:memo'));
$('memo2').addEventListener('click', () => ipcRenderer.send('recorder:memo'));
$('quit').addEventListener('click', () => ipcRenderer.send('window:close'));

// ------------------------------------------------------------------ 附加轨

const device = (id) => (id && id !== 'default' ? { deviceId: { exact: id } } : {});

async function openStreams() {
  const streams = {};
  const problems = [];
  // 被 Windows 隐私设置拦下时给出开启位置，其余情况（被占用、已拔出）只报设备名。
  const describe = (name, error) => (error && error.name === 'NotAllowedError'
    ? `${name}（请在 Windows 设置 → 隐私和安全性 → ${name} 里允许桌面应用访问）`
    : name);
  if (state.cam.on) {
    try {
      streams.camera = await navigator.mediaDevices.getUserMedia({ video: { ...device(state.cam.deviceId), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
    } catch (error) { problems.push(describe('摄像头', error)); }
  }
  if (state.mic.on) {
    try {
      // 口播原声：不做回声消除与自动增益，后期再处理。
      streams.microphone = await navigator.mediaDevices.getUserMedia({ audio: { ...device(state.mic.deviceId), echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } });
    } catch (error) { problems.push(describe('麦克风', error)); }
  }
  if (state.sys.on) {
    try {
      // 主进程把这次请求答复为"整屏 + 系统回环声音"，这里只留声音轨。
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      display.getVideoTracks().forEach((track) => track.stop());
      if (display.getAudioTracks().length) streams.system = new MediaStream(display.getAudioTracks());
      else problems.push('系统声音');
    } catch { problems.push('系统声音'); }
  }
  return { streams, problems };
}

function pickMimeType(candidates) {
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

/// 一条 MediaRecorder 轨：数据块按到达顺序追加到文件。
function startTrack(kind, stream, directory, hasAudio) {
  const isVideo = kind === 'camera';
  const mimeType = isVideo
    ? pickMimeType(['video/x-matroska;codecs=avc1,opus', 'video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'])
    : pickMimeType(['audio/webm;codecs=opus', 'audio/webm']);
  const file = path.join(directory, `${kind}-raw.${mimeType.includes('matroska') ? 'mkv' : 'webm'}`);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 });
  const track = { kind, file, startedAt: null, hasAudio: Boolean(hasAudio), recorder, stream };
  let writing = Promise.resolve();
  track.started = new Promise((resolve) => {
    recorder.onstart = () => { track.startedAt = Date.now() / 1000; resolve(); };
    setTimeout(resolve, 2500); // 设备迟迟不出数据时不卡住整个录制
  });
  recorder.ondataavailable = (event) => {
    if (!event.data.size) return;
    writing = writing.then(async () => fs.promises.appendFile(file, Buffer.from(await event.data.arrayBuffer())));
  };
  track.finished = new Promise((resolve) => { recorder.onstop = () => writing.then(resolve, resolve); });
  recorder.start(1000);
  return track;
}

async function stopTracks(tracks) {
  for (const track of tracks) if (track.recorder.state !== 'inactive') track.recorder.stop();
  await Promise.all(tracks.map((track) => track.finished));
  for (const track of tracks) track.stream.getTracks().forEach((item) => item.stop());
  return tracks.filter((track) => track.startedAt !== null).map(({ kind, file, startedAt, hasAudio }) => ({ kind, file, startedAt, hasAudio }));
}

// ------------------------------------------------------------------ 录制流程

let timer = null;

async function start() {
  $('start').disabled = true;
  const { streams, problems } = await openStreams();
  const tracks = [];
  const fail = async (error) => {
    await stopTracks(tracks);
    Object.values(streams).forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    state.environment = { ...state.environment, ok: false, reason: String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
    render();
    setTimeout(() => { state.environment.ok = true; render(); }, 6000);
  };
  try {
    const prepared = await ipcRenderer.invoke('recorder:prepare', { selection: state.selection, frameRate: 60 });
    if (streams.camera) {
      // 摄像头与麦克风同录一个文件，口型与声音天然对齐。
      const combined = new MediaStream([...streams.camera.getVideoTracks(), ...(streams.microphone ? streams.microphone.getAudioTracks() : [])]);
      tracks.push(startTrack('camera', combined, prepared.mediaDirectory, Boolean(streams.microphone)));
    } else if (streams.microphone) {
      tracks.push(startTrack('microphone', streams.microphone, prepared.mediaDirectory));
    }
    if (streams.system) tracks.push(startTrack('system', streams.system, prepared.mediaDirectory));
    // 附加轨都录起来之后再开始屏幕采集，保证它们覆盖屏幕画面的第一帧。
    await Promise.all(tracks.map((track) => track.started));
    await ipcRenderer.invoke('recorder:start');
  } catch (error) {
    await fail(error);
    return;
  }
  state.session = { tracks, beganAt: performance.now(), markers: 0, wanted: { camera: state.cam.on, microphone: state.mic.on, system: state.sys.on } };

  const inputs = [streams.microphone && '麦克风', streams.camera && '摄像头', streams.system && '系统声音'].filter(Boolean);
  $('liveTitle').textContent = inputs.length ? `正在录制 · ${inputs.join(' + ')}` : '正在录制 · 仅画面';
  $('liveDetail').textContent = problems.length ? `未能打开：${problems.join('、')}` : '录制条与备忘录不会被录进去';
  $('liveDetail').title = problems.join('\n');
  $('liveDetail').classList.toggle('error', problems.length > 0);
  state.session.problems = problems;
  $('marker').querySelector('span').textContent = '标记';
  show('live');
  timer = setInterval(() => { $('timer').textContent = formatTime((performance.now() - state.session.beganAt) / 1000, false); }, 250);
  $('timer').textContent = '00:00';
}

async function stop(discard) {
  clearInterval(timer);
  const session = state.session;
  state.session = null;
  $('busyTitle').textContent = discard ? '正在放弃这次录制…' : '正在整理素材…';
  show('busy');
  const tracks = await stopTracks(session.tracks);
  if (discard) {
    await ipcRenderer.invoke('recorder:cancel');
    show('idle');
    render();
    return;
  }
  try {
    state.result = await ipcRenderer.invoke('recorder:stop', tracks);
    $('doneTitle').textContent = `已保存：${state.result.name}`;
    // 打开了却没录上的输入要明说，免得进了编辑器才发现没有声音或画中画。
    const names = { camera: '摄像头', microphone: '麦克风', system: '系统声音' };
    const missing = Object.keys(names).filter((key) => session.wanted[key] && !state.result.recorded[key]).map((key) => names[key]);
    $('doneDetail').textContent = missing.length
      ? `没有录到：${session.problems && session.problems.length ? session.problems.join('、') : `${missing.join('、')}（右键对应按钮可换设备）`}`
      : `时长 ${formatTime(state.result.duration, false)} · 已按点击生成自动缩放`;
    $('doneDetail').title = $('doneDetail').textContent;
    $('doneDetail').classList.toggle('error', missing.length > 0);
    $('edit').hidden = false;
    $('reveal').hidden = false;
  } catch (error) {
    state.result = null;
    $('doneTitle').textContent = '这次录制没有保存成功';
    $('doneDetail').textContent = String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    $('doneDetail').classList.add('error');
    $('edit').hidden = true;
    $('reveal').hidden = true;
  }
  show('done');
}

$('start').addEventListener('click', start);
$('stop').addEventListener('click', () => stop(false));
$('discard').addEventListener('click', () => stop(true));
$('marker').addEventListener('click', async () => {
  const count = await ipcRenderer.invoke('recorder:marker');
  if (count) $('marker').querySelector('span').textContent = `标记 ${count}`;
});
$('edit').addEventListener('click', () => { ipcRenderer.invoke('project:open', state.result.directory); show('idle'); render(); });
$('reveal').addEventListener('click', () => ipcRenderer.send('project:reveal', path.join(state.result.directory, 'project.json')));
$('again').addEventListener('click', () => { show('idle'); render(); });

ipcRenderer.on('recorder:stage', (event, stage) => { $('busyTitle').textContent = `${stage}…`; });
ipcRenderer.on('recorder:marker-added', (event, count) => { $('marker').querySelector('span').textContent = `标记 ${count}`; });
ipcRenderer.on('app:environment', (event, environment) => { state.environment = environment; render(); });

(async () => {
  state.displays = await ipcRenderer.invoke('recorder:displays');
  const primary = state.displays.find((item) => item.isPrimary) || state.displays[0];
  state.selection = { kind: 'display', displayId: primary ? primary.id : null };
  state.environment = await ipcRenderer.invoke('app:environment');
  render();
})();
