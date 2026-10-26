'use strict';
// 预览播放：一个以输出时间为准的主时钟，屏幕、摄像头与两条音轨的媒体元素都跟随它。
// 画面由与导出相同的 Compositor 绘制。

const path = require('node:path');
const { fileUrl } = require('../common');
const { canvasDimensions, clamp } = require('../../core/model');
const { evaluateScene } = require('../../core/scene');
const timeline = require('../../core/timeline');
const { Compositor } = require('./render');

const DRIFT_TOLERANCE = 0.14;
const MAX_PREVIEW_PIXELS = 2560;

class Preview {
  constructor(store, canvas, wrap) {
    this.store = store;
    this.canvas = canvas;
    this.wrap = wrap;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.compositor = new Compositor(store.directory);
    this.time = 0; // 输出时间
    this.playing = false;
    this.lastTick = 0;
    this.dirty = true;
    this.onTime = () => {};
    this.onState = () => {};

    const { media } = store.project;
    const make = (tag, track, muted) => {
      if (!track) return null;
      const node = document.createElement(tag);
      node.src = fileUrl(path.join(store.directory, track.file));
      node.preload = 'auto';
      node.muted = muted;
      node.addEventListener('seeked', () => this.invalidate());
      node.addEventListener('loadeddata', () => this.invalidate());
      return { node, offset: track.offset || 0, duration: track.duration };
    };
    this.screen = make('video', media.screen, true);
    this.camera = make('video', media.camera, true);
    this.microphone = make('audio', media.microphone, false);
    this.system = make('audio', media.systemAudio, false);

    new ResizeObserver(() => this.layout()).observe(wrap);
    store.subscribe((reason) => {
      if (reason === 'project') {
        this.time = clamp(this.time, 0, this.duration);
        this.compositor.prepare(store.project).then(() => this.invalidate());
        this.layout();
        this.syncMedia(true);
      }
      this.invalidate();
    });
    this.compositor.prepare(store.project).then(() => this.invalidate());
    this.layout();
    this.syncMedia(true);
    requestAnimationFrame((now) => this.frame(now));
  }

  get segments() { return this.store.project.timeline.segments; }

  get duration() { return timeline.outputDuration(this.segments); }

  get sourceTime() { return timeline.locate(this.segments, this.time).sourceTime; }

  invalidate() { this.dirty = true; }

  /// 预览画布按导出画布的比例铺满可用区域。
  layout() {
    const { media, canvas } = this.store.project;
    const output = canvasDimensions(canvas, 'source', media.screen);
    const bounds = this.wrap.getBoundingClientRect();
    if (bounds.width < 10 || bounds.height < 10) return;
    const scale = Math.min(bounds.width / output.width, bounds.height / output.height);
    const cssWidth = Math.floor(output.width * scale);
    const cssHeight = Math.floor(output.height * scale);
    const pixelScale = Math.min(devicePixelRatio, MAX_PREVIEW_PIXELS / Math.max(cssWidth, cssHeight));
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    const width = Math.max(Math.round(cssWidth * pixelScale), 2);
    const height = Math.max(Math.round(cssHeight * pixelScale), 2);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.invalidate();
  }

  play() {
    if (this.playing) return;
    if (this.time >= this.duration - 0.02) this.time = 0;
    this.playing = true;
    this.lastTick = performance.now();
    this.syncMedia(true);
    this.onState();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.syncMedia(true);
    this.onState();
  }

  toggle() { if (this.playing) this.pause(); else this.play(); }

  seek(time) {
    this.time = clamp(time, 0, this.duration);
    this.syncMedia(true);
    this.invalidate();
    this.onTime(this.time);
  }

  /// 把各媒体元素对到主时钟上。播放中只在漂移超过容差时才重新定位，避免频繁 seek 造成卡顿。
  syncMedia(force) {
    const hit = timeline.locate(this.segments, this.time);
    if (!hit) return;
    const { audio } = this.store.project;
    const volumes = {
      microphone: audio.isMicrophoneMuted ? 0 : audio.microphoneVolume,
      system: audio.isSystemMuted ? 0 : audio.systemVolume,
    };
    for (const [name, track] of [['screen', this.screen], ['camera', this.camera], ['microphone', this.microphone], ['system', this.system]]) {
      if (!track) continue;
      const { node } = track;
      const limit = (Number.isFinite(node.duration) ? node.duration : track.duration) - 0.03;
      const wanted = hit.sourceTime - track.offset;
      const inRange = wanted >= 0 && wanted <= limit;
      track.inRange = inRange;
      if (volumes[name] !== undefined) node.volume = clamp(volumes[name], 0, 1);
      if (!inRange) {
        if (!node.paused) node.pause();
        // 屏幕画面超出范围时停在最近的一帧上。
        if (name === 'screen' && (force || node.paused)) {
          const edge = clamp(wanted, 0, Math.max(limit, 0));
          if (Math.abs(node.currentTime - edge) > 0.01) node.currentTime = edge;
        }
        continue;
      }
      if (this.playing) {
        if (node.playbackRate !== hit.segment.speed) node.playbackRate = hit.segment.speed;
        if (node.paused || Math.abs(node.currentTime - wanted) > DRIFT_TOLERANCE * Math.max(hit.segment.speed, 1)) {
          node.currentTime = wanted;
          if (node.paused) node.play().catch(() => {});
        }
      } else {
        if (!node.paused) node.pause();
        if (force || Math.abs(node.currentTime - wanted) > 0.005) node.currentTime = wanted;
      }
    }
  }

  frame(now) {
    if (this.playing) {
      const previousIndex = timeline.locate(this.segments, this.time).index;
      this.time += (now - this.lastTick) / 1000;
      this.lastTick = now;
      if (this.time >= this.duration) {
        this.time = this.duration;
        this.pause();
      } else {
        // 跨过剪辑点时素材时间跳变，需要立即重新定位而不是等漂移超限。
        this.syncMedia(timeline.locate(this.segments, this.time).index !== previousIndex);
      }
      this.onTime(this.time);
      this.dirty = true;
    }
    if (this.dirty) {
      this.dirty = false;
      this.draw();
    }
    requestAnimationFrame((next) => this.frame(next));
  }

  draw() {
    const { project, zoomClips, pointerTrack } = this.store;
    const { media } = project;
    const ready = (track) => (track && track.node.readyState >= 2 ? track.node : null);
    const cameraVisible = this.camera && this.camera.inRange && !project.camera.isHidden;
    const scene = evaluateScene(project, {
      time: this.sourceTime,
      width: this.canvas.width,
      height: this.canvas.height,
      sourceAspect: media.screen.width / media.screen.height,
      cameraAspect: cameraVisible ? media.camera.width / media.camera.height : null,
      zoomClips,
      pointerTrack,
    });
    this.scene = scene;
    this.compositor.draw(this.ctx, project, scene, { screen: ready(this.screen), camera: cameraVisible ? ready(this.camera) : null });
  }
}

module.exports = { Preview };
