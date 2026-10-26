'use strict';
// 时间线：标尺与标记、屏幕录制轨（缩略图片段，可分割 / 裁边）、缩放轨（可拖动 / 改长短）。
// 横轴是输出时间；缩放与标记以素材时间保存，绘制时经片段映射到输出时间。

const path = require('node:path');
const { element, icon, formatTime, fileUrl } = require('../common');
const { clamp } = require('../../core/model');
const zoomCore = require('../../core/zoom');
const timeline = require('../../core/timeline');

const PAD = 14;
const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const MIN_ZOOM_CLIP = 0.2;

class TimelineView {
  constructor(store, preview, nodes) {
    this.store = store;
    this.preview = preview;
    this.nodes = nodes; // { scroller, lanes, ruler, screen, zoom, playhead, slider }
    this.zoomLevel = 0;
    this.pps = 60;
    const thumbnails = store.project.media.thumbnails;
    this.sprite = thumbnails ? { ...thumbnails, url: fileUrl(path.join(store.directory, thumbnails.file)) } : null;

    new ResizeObserver(() => this.render()).observe(nodes.scroller);
    store.subscribe((reason) => { if (reason === 'project' || reason === 'selection') this.render(); });
    nodes.slider.addEventListener('input', () => this.setZoom(Number(nodes.slider.value)));
    nodes.scroller.addEventListener('wheel', (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      this.setZoom(clamp(this.zoomLevel - Math.sign(event.deltaY) * 0.06, 0, 1), event.clientX);
    }, { passive: false });

    nodes.ruler.addEventListener('pointerdown', (event) => this.scrub(event));
    for (const lane of [nodes.screen, nodes.zoom]) {
      lane.addEventListener('pointerdown', (event) => {
        if (event.target !== lane) return;
        store.select(null);
        this.scrub(event);
      });
    }
    nodes.zoom.addEventListener('dblclick', (event) => { if (event.target === nodes.zoom) this.addZoomAt(this.timeAt(event.clientX)); });
    this.render();
  }

  get segments() { return this.store.project.timeline.segments; }

  get duration() { return timeline.outputDuration(this.segments); }

  x(outputTime) { return PAD + outputTime * this.pps; }

  timeAt(clientX) {
    const bounds = this.nodes.lanes.getBoundingClientRect();
    return clamp((clientX - bounds.left - PAD) / this.pps, 0, this.duration);
  }

  setZoom(level, anchorClientX) {
    const anchorTime = anchorClientX === undefined ? this.preview.time : this.timeAt(anchorClientX);
    const anchorOffset = this.x(anchorTime) - this.nodes.scroller.scrollLeft;
    this.zoomLevel = level;
    this.nodes.slider.value = level;
    this.render();
    this.nodes.scroller.scrollLeft = this.x(anchorTime) - anchorOffset;
  }

  /// 拖动通用逻辑：move(dx 像素, 事件)。整个拖动只记一步撤销。
  drag(event, { move, end, gesture = true }) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    if (gesture) this.store.beginGesture();
    const onMove = (moveEvent) => move(moveEvent.clientX - startX, moveEvent);
    const onUp = (upEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (gesture) this.store.endGesture();
      if (end) end(upEvent.clientX - startX);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  scrub(event) {
    this.preview.pause();
    this.preview.seek(this.timeAt(event.clientX));
    this.drag(event, { gesture: false, move: (dx, moveEvent) => this.preview.seek(this.timeAt(moveEvent.clientX)) });
  }

  render() {
    const { scroller, lanes, slider } = this.nodes;
    const duration = Math.max(this.duration, 0.1);
    const available = Math.max(scroller.clientWidth - PAD * 2, 100);
    // 0 档正好铺满可视宽度，1 档放大到约 40 倍。
    this.pps = (available / duration) * (1 + this.zoomLevel * this.zoomLevel * 39);
    lanes.style.width = `${Math.max(duration * this.pps + PAD * 2, scroller.clientWidth)}px`;
    slider.value = this.zoomLevel;
    this.renderRuler(duration);
    this.renderSegments();
    this.renderZoomClips();
    this.updatePlayhead();
  }

  renderRuler(duration) {
    const step = TICK_STEPS.find((value) => value * this.pps >= 72) || TICK_STEPS[TICK_STEPS.length - 1];
    const nodes = [];
    for (let n = 0; n * step <= duration + 1e-6; n++) {
      const time = n * step;
      nodes.push(element('div', { class: 'tick', style: `left:${this.x(time)}px` }, step < 1 ? formatTime(time).slice(1) : formatTime(time, false)));
      const half = time + step / 2;
      if (half < duration && step * this.pps >= 110) nodes.push(element('div', { class: 'tick minor', style: `left:${this.x(half)}px` }));
    }
    for (const marker of this.store.project.markers) {
      if (!timeline.isRetained(this.segments, marker.time)) continue;
      const outputTime = timeline.sourceToOutput(this.segments, marker.time);
      nodes.push(element('div', {
        class: 'marker', style: `left:${this.x(outputTime)}px`, html: icon('flag'), title: `录制标记 ${formatTime(outputTime)} · 右键删除`,
        onpointerdown: (event) => { event.stopPropagation(); this.preview.seek(outputTime); },
        oncontextmenu: () => this.store.mutate((project) => { project.markers = project.markers.filter((item) => item.id !== marker.id); }),
      }));
    }
    this.nodes.ruler.replaceChildren(...nodes);
  }

  filmstrip(segment, width, height) {
    if (!this.sprite) return null;
    const { media } = this.store.project;
    const tileWidth = height * media.screen.width / media.screen.height;
    const tiles = [];
    for (let left = 0; left < width; left += tileWidth) {
      const sourceTime = segment.sourceStart + ((left + tileWidth / 2) / this.pps) * segment.speed;
      const index = clamp(Math.floor(sourceTime / this.sprite.interval), 0, this.sprite.count - 1);
      tiles.push(element('i', { style: `width:${tileWidth}px;background-image:url("${this.sprite.url}");background-size:${tileWidth * this.sprite.count}px ${height}px;background-position:${-index * tileWidth}px 0` }));
    }
    return element('div', { class: 'film' }, tiles);
  }

  renderSegments() {
    const lane = this.nodes.screen;
    const height = lane.clientHeight - 20;
    const mediaDuration = this.store.project.media.screen.duration;
    let start = 0;
    const nodes = this.segments.map((segment) => {
      const duration = timeline.segmentOutputDuration(segment);
      const width = Math.max(duration * this.pps - 2, 6);
      const selected = this.store.selection && this.store.selection.type === 'segment' && this.store.selection.id === segment.id;
      const trim = (edge) => (event) => {
        const original = segment[edge === 'start' ? 'sourceStart' : 'sourceEnd'];
        this.store.select({ type: 'segment', id: segment.id });
        this.drag(event, {
          move: (dx) => this.store.mutate((project) => {
            const next = timeline.trimSegment(project.timeline.segments, segment.id, edge, original + (dx / this.pps) * segment.speed, mediaDuration);
            if (next) project.timeline.segments = next;
          }, { history: false }),
        });
      };
      const node = element('div', {
        class: `segment${selected ? ' selected' : ''}`, style: `left:${this.x(start)}px;width:${width}px`,
        onpointerdown: (event) => {
          this.store.select({ type: 'segment', id: segment.id });
          this.scrub(event);
        },
      },
      this.filmstrip(segment, width, height),
      element('span', { class: 'tag' }, `${formatTime(duration)}${Math.abs(segment.speed - 1) > 1e-6 ? ` · ${segment.speed}×` : ''}`),
      element('div', { class: 'handle start', title: '拖动裁短或恢复', onpointerdown: trim('start') }),
      element('div', { class: 'handle end', title: '拖动裁短或恢复', onpointerdown: trim('end') }));
      start += duration;
      return node;
    });
    lane.replaceChildren(...nodes);
  }

  /// 缩放块在素材时间上可移动的范围：不越过相邻缩放块（含对方的退出过渡）与素材两端。
  zoomBounds(clip) {
    const ordered = this.store.zoomClips;
    const index = ordered.findIndex((item) => item.id === clip.id);
    const previous = ordered[index - 1];
    const next = ordered[index + 1];
    return {
      lower: previous ? zoomCore.effectEndTime(previous) : 0,
      upper: (next ? next.startTime : this.store.project.media.screen.duration) - clip.exitDuration,
    };
  }

  speedAt(sourceTime) {
    const segment = this.segments.find((item) => sourceTime >= item.sourceStart && sourceTime <= item.sourceEnd);
    return segment ? segment.speed : 1;
  }

  renderZoomClips() {
    const nodes = [];
    for (const clip of this.store.zoomClips) {
      const outputStart = timeline.sourceToOutput(this.segments, clip.startTime);
      const outputEnd = timeline.sourceToOutput(this.segments, clip.endTime);
      if (outputEnd - outputStart < 0.02) continue; // 整段都被剪掉了
      const selected = this.store.selection && this.store.selection.type === 'zoom' && this.store.selection.id === clip.id;
      const edit = (mode) => (event) => {
        const original = { start: clip.startTime, end: clip.endTime };
        const bounds = this.zoomBounds(clip);
        const speed = this.speedAt(clip.startTime);
        this.store.select({ type: 'zoom', id: clip.id });
        this.preview.pause();
        this.drag(event, {
          move: (dx) => this.store.mutate((project) => {
            const target = project.zoomAnimations.find((item) => item.id === clip.id);
            const delta = (dx / this.pps) * speed;
            if (mode === 'move') {
              const shift = clamp(delta, bounds.lower - original.start, Math.max(bounds.upper - original.end, bounds.lower - original.start));
              target.startTime = original.start + shift;
              target.endTime = original.end + shift;
            } else if (mode === 'start') {
              target.startTime = clamp(original.start + delta, bounds.lower, original.end - MIN_ZOOM_CLIP);
            } else {
              target.endTime = clamp(original.end + delta, original.start + MIN_ZOOM_CLIP, Math.max(bounds.upper, original.start + MIN_ZOOM_CLIP));
            }
          }, { history: false }),
        });
      };
      const left = this.x(outputStart);
      const width = Math.max((outputEnd - outputStart) * this.pps, 8);
      nodes.push(element('div', {
        class: `zoom-clip${selected ? ' selected' : ''}`, style: `left:${left}px;width:${width}px`,
        title: '拖动移动，拖两端改长短', onpointerdown: edit('move'),
      },
      `缩放 ${clip.scale.toFixed(1)}× · ${clip.origin === 'automatic' ? '自动' : '手动'}`,
      element('div', { class: 'handle start', onpointerdown: edit('start') }),
      element('div', { class: 'handle end', onpointerdown: edit('end') })));
      if (clip.exitDuration > 0.02) {
        // 斜纹表示片段结束后的回落过渡。
        nodes.push(element('div', { class: 'zoom-tail', style: `left:${left + width}px;width:${clip.exitDuration / this.speedAt(clip.endTime) * this.pps}px` }));
      }
    }
    this.nodes.zoom.replaceChildren(...nodes);
  }

  /// 在输出时间处添加一段手动缩放。位置被已有缩放占用时返回 false。
  addZoomAt(outputTime) {
    const { project, pointerTrack, zoomClips } = this.store;
    const sourceTime = timeline.locate(this.segments, outputTime).sourceTime;
    if (zoomClips.some((clip) => sourceTime >= clip.startTime - 0.05 && sourceTime <= zoomCore.effectEndTime(clip) + 0.05)) return false;
    const next = zoomClips.find((clip) => clip.startTime > sourceTime);
    const transition = project.motion.defaultZoomTransitionDuration;
    const limit = (next ? next.startTime : project.media.screen.duration) - 0.05;
    const endTime = Math.min(sourceTime + 2, limit - Math.min(transition, 0.3));
    if (endTime - sourceTime < MIN_ZOOM_CLIP) return false;
    // 默认对准当时指针所在的位置。
    const pointer = pointerTrack ? pointerTrack.evaluation(sourceTime, project.motion, project.cursorStyle).position : null;
    const clip = zoomCore.makeClip({
      startTime: sourceTime, endTime, scale: project.motion.defaultZoomScale, focus: pointer || zoomCore.CENTER, origin: 'manual',
      easing: project.motion.defaultZoomEasing, enterDuration: transition, exitDuration: Math.min(transition, limit - endTime),
    });
    this.store.mutate((draft) => { draft.zoomAnimations.push(clip); });
    this.store.select({ type: 'zoom', id: clip.id });
    return true;
  }

  updatePlayhead() {
    const { scroller, playhead } = this.nodes;
    const x = this.x(this.preview.time);
    playhead.style.transform = `translateX(${x}px)`;
    if (this.preview.playing && (x < scroller.scrollLeft + 20 || x > scroller.scrollLeft + scroller.clientWidth - 30)) {
      scroller.scrollLeft = x - 60;
    }
  }
}

module.exports = { TimelineView };
