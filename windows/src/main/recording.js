'use strict';
// 一次录制的生命周期：开始采集 → 记录指针与标记 → 结束后整理成 .dogscproject 项目包。

const fs = require('node:fs');
const path = require('node:path');
const { screen } = require('electron');
const media = require('./ffmpeg');
const { PointerRecorder, toSourceTimeline, windowRects, bringToFront } = require('./pointer-recorder');
const { makeProject, uid } = require('../core/model');
const { planAutoZoom } = require('../core/zoom');
const { isInside } = require('../core/pointer');

const PROJECT_EXTENSION = '.dogscproject';

/// ddagrab 按 DXGI 输出序号选屏：主屏在前，其余按桌面坐标从左到右。
function listDisplays() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays()
    .sort((a, b) => (b.id === primaryId) - (a.id === primaryId) || a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
    .map((display, outputIndex) => ({
      id: display.id,
      outputIndex,
      label: display.label || `显示器 ${outputIndex + 1}`,
      isPrimary: display.id === primaryId,
      scaleFactor: display.scaleFactor,
      bounds: display.bounds,
      physical: screen.dipToScreenRect(null, display.bounds),
    }));
}

function uniqueProjectDirectory(root, name) {
  const safe = name.replace(/[\\/:*?"<>|]/g, ' ').trim() || '未命名录制';
  let candidate = path.join(root, safe + PROJECT_EXTENSION);
  for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(root, `${safe} ${n}${PROJECT_EXTENSION}`);
  return candidate;
}

function defaultProjectName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `录屏 ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
}

/// 把界面上的来源选择换成采集参数与"当前采集矩形"（物理像素，供指针归一化）。
function resolveSource(selection) {
  const displays = listDisplays();
  /// 显示器内的一块区域。requested 为相对该显示器左上角的物理像素矩形。
  const areaSource = (display, requested, description) => {
    // H.264 4:2:0 需要偶数宽高。
    const floorEven = (value) => Math.max(Math.floor(value / 2) * 2, 64);
    const left = Math.min(Math.max(Math.round(requested.x), 0), Math.max(display.physical.width - 64, 0));
    const top = Math.min(Math.max(Math.round(requested.y), 0), Math.max(display.physical.height - 64, 0));
    const width = floorEven(Math.min(requested.x + requested.width, display.physical.width) - left);
    const height = floorEven(Math.min(requested.y + requested.height, display.physical.height) - top);
    const rect = { x: left, y: top, width, height };
    const absolute = { x: display.physical.x + left, y: display.physical.y + top, width, height };
    return {
      capture: { kind: 'area', outputIndex: display.outputIndex, rect },
      width,
      height,
      getRect: () => absolute,
      description: { ...description, display: display.label, rect },
    };
  };
  if (selection.kind === 'window') {
    bringToFront(selection.hwnd);
    const rects = windowRects(selection.hwnd);
    if (!rects) throw new Error('这个窗口已经关闭或无法访问，请重新选择。');
    // 取窗口可见边界（含标题栏）所在的显示器，超出屏幕的部分裁掉。
    const frame = rects.frame;
    const center = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
    const display = displays.find((item) => center.x >= item.physical.x && center.x < item.physical.x + item.physical.width
      && center.y >= item.physical.y && center.y < item.physical.y + item.physical.height) || displays[0];
    return areaSource(display, { x: frame.x - display.physical.x, y: frame.y - display.physical.y, width: frame.width, height: frame.height },
      { source: 'window', title: selection.title || '' });
  }
  const display = displays.find((item) => item.id === selection.displayId) || displays[0];
  if (selection.kind === 'area') return areaSource(display, selection.rect, { source: 'area' });
  return {
    capture: { kind: 'display', outputIndex: display.outputIndex },
    width: display.physical.width,
    height: display.physical.height,
    getRect: () => display.physical,
    description: { source: 'display', display: display.label },
  };
}

class RecordingSession {
  constructor({ projectsRoot, selection, frameRate = 60, name }) {
    this.selection = selection;
    this.frameRate = frameRate;
    this.name = name || defaultProjectName();
    this.directory = uniqueProjectDirectory(projectsRoot, this.name);
    this.mediaDirectory = path.join(this.directory, 'media');
    this.markers = [];
    this.firstFrameTime = null;
  }

  async start() {
    fs.mkdirSync(this.mediaDirectory, { recursive: true });
    this.source = resolveSource(this.selection);
    this.pointer = new PointerRecorder(this.source.getRect);
    this.pointer.start();
    try {
      this.capture = await media.startCapture({
        source: this.source.capture,
        fps: this.frameRate,
        file: path.join(this.mediaDirectory, 'screen.mkv'),
        width: this.source.width,
        height: this.source.height,
      });
      this.firstFrameTime = await Promise.race([
        this.capture.firstFrame,
        new Promise((_, reject) => setTimeout(() => reject(new Error('屏幕采集启动超时')), 10000)),
      ]);
    } catch (error) {
      await this.discard();
      throw error;
    }
    return { directory: this.directory, mediaDirectory: this.mediaDirectory, firstFrameTime: this.firstFrameTime, encoder: this.capture.encoder.label };
  }

  addMarker() {
    if (this.firstFrameTime === null) return null;
    const marker = { id: uid(), time: Date.now() / 1000 - this.firstFrameTime };
    this.markers.push(marker);
    return marker;
  }

  async discard() {
    if (this.pointer) this.pointer.stop();
    if (this.capture) await this.capture.stop();
    fs.rmSync(this.directory, { recursive: true, force: true });
  }

  /// tracks：录制条窗口用 MediaRecorder 写下的附加轨，
  /// [{ kind: 'camera' | 'microphone' | 'system', file, startedAt（系统时钟秒）, hasAudio }]
  async finish(tracks, onStage = () => {}) {
    onStage('正在结束采集');
    const pointerEvents = this.pointer.stop();
    await this.capture.stop();
    const inMedia = (name) => path.join(this.mediaDirectory, name);
    const raw = inMedia('screen.mkv');

    onStage('正在整理屏幕画面');
    let screenInfo = null;
    try {
      await media.remuxToMp4(raw, inMedia('screen.mp4'));
      screenInfo = await media.probe(inMedia('screen.mp4'));
    } catch { /* 下面统一报错 */ }
    if (!screenInfo || !screenInfo.video) {
      throw new Error(`没有录到画面：${this.capture.stderr.trim().split(/\r?\n/).slice(-8).join(' / ')}`);
    }
    const duration = screenInfo.duration;
    const projectMedia = {
      screen: { file: 'media/screen.mp4', index: 'media/screen.index.json', width: screenInfo.video.width, height: screenInfo.video.height, duration, frameRate: this.frameRate },
      camera: null,
      microphone: null,
      systemAudio: null,
    };

    for (const track of tracks || []) {
      if (!fs.existsSync(track.file) || fs.statSync(track.file).size < 512) continue;
      const offset = track.startedAt - this.firstFrameTime;
      try {
        if (track.kind === 'camera') {
          onStage('正在整理摄像头画面');
          const info = await media.finalizeCamera(track.file, inMedia('camera.mp4'));
          if (info && info.video) {
            fs.writeFileSync(inMedia('camera.index.json'), JSON.stringify(await media.buildVideoIndex(inMedia('camera.mp4'))));
            projectMedia.camera = { file: 'media/camera.mp4', index: 'media/camera.index.json', width: info.video.width, height: info.video.height, duration: info.duration, offset };
          }
          if (track.hasAudio) {
            const audio = await media.finalizeAudio(track.file, inMedia('microphone.m4a'));
            if (audio) projectMedia.microphone = { file: 'media/microphone.m4a', duration: audio.duration, offset };
          }
        } else {
          onStage(track.kind === 'system' ? '正在整理系统声音' : '正在整理麦克风');
          const name = track.kind === 'system' ? 'system.m4a' : 'microphone.m4a';
          const audio = await media.finalizeAudio(track.file, inMedia(name));
          if (audio) projectMedia[track.kind === 'system' ? 'systemAudio' : 'microphone'] = { file: `media/${name}`, duration: audio.duration, offset };
        }
      } catch (error) {
        // 附加轨整理失败不应丢掉整段录屏：保留原始文件，项目里不引用。
        console.error(`[DogSC] ${track.kind} 轨整理失败`, error);
        continue;
      }
      fs.rmSync(track.file, { force: true });
    }

    onStage('正在生成索引与缩略图');
    fs.writeFileSync(inMedia('screen.index.json'), JSON.stringify(await media.buildVideoIndex(inMedia('screen.mp4'))));
    projectMedia.thumbnails = await media.makeThumbnails(inMedia('screen.mp4'), inMedia('thumbnails.jpg'), duration)
      .then((thumbnails) => ({ ...thumbnails, file: `media/${thumbnails.file}` }))
      .catch(() => null);

    const events = toSourceTimeline(pointerEvents, this.firstFrameTime, duration);
    fs.writeFileSync(inMedia('pointer.json'), JSON.stringify({ hasClicks: this.pointer.hasClickSupport, events }));
    projectMedia.pointer = 'media/pointer.json';

    const project = makeProject({ name: path.basename(this.directory, PROJECT_EXTENSION), media: projectMedia, capture: this.source.description });
    project.zoomAnimations = planAutoZoom(events.filter(isInside), {
      zoomScale: project.motion.defaultZoomScale,
      easing: project.motion.defaultZoomEasing,
      transitionDuration: project.motion.defaultZoomTransitionDuration,
      duration,
    });
    project.markers = this.markers.filter((marker) => marker.time >= 0 && marker.time <= duration);
    project.export.frameRate = this.frameRate >= 60 ? 60 : 30;
    fs.writeFileSync(path.join(this.directory, 'project.json'), JSON.stringify(project, null, 2));
    fs.rmSync(raw, { force: true });
    return { directory: this.directory, project };
  }
}

module.exports = { RecordingSession, listDisplays, defaultProjectName, PROJECT_EXTENSION };
