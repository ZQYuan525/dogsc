'use strict';
// 编辑器状态：项目文档、选中项、撤销栈与自动保存。

const { ipcRenderer } = require('electron');
const { orderedClips } = require('../../core/zoom');
const { loadPointerTrack } = require('./export');

const HISTORY_LIMIT = 120;

class Store {
  constructor(directory, project) {
    this.directory = directory;
    this.project = project;
    this.pointerTrack = loadPointerTrack(directory, project);
    this.selection = null; // { type: 'segment' | 'zoom', id }
    this.listeners = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.gesture = null;
    this.saveTimer = null;
    this.saveState = 'saved';
    this.refreshDerived();
  }

  refreshDerived() {
    this.zoomClips = orderedClips(this.project.zoomAnimations);
  }

  subscribe(listener) { this.listeners.add(listener); }

  emit(reason) { for (const listener of this.listeners) listener(reason); }

  /// 所有改动都走这里。history 为 false 的改动（拖动过程）不单独进撤销栈。
  mutate(change, { history = true } = {}) {
    const before = history && !this.gesture ? JSON.stringify(this.project) : null;
    change(this.project);
    if (before !== null) this.pushUndo(before);
    this.afterChange();
  }

  pushUndo(snapshot) {
    if (snapshot === JSON.stringify(this.project)) return;
    this.undoStack.push(snapshot);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /// 一次拖动（滑块、片段边缘、缩放块）只算一步撤销。
  beginGesture() {
    if (!this.gesture) this.gesture = JSON.stringify(this.project);
  }

  endGesture() {
    if (!this.gesture) return;
    const snapshot = this.gesture;
    this.gesture = null;
    this.pushUndo(snapshot);
    this.emit('history');
  }

  restore(snapshot) {
    const media = this.project.media;
    this.project = JSON.parse(snapshot);
    this.project.media = media; // 素材引用不随撤销变化
    if (this.selection) {
      const pool = this.selection.type === 'zoom' ? this.project.zoomAnimations : this.project.timeline.segments;
      if (!pool.some((item) => item.id === this.selection.id)) this.selection = null;
    }
    this.afterChange();
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.project));
    this.restore(this.undoStack.pop());
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.project));
    this.restore(this.redoStack.pop());
  }

  afterChange() {
    this.refreshDerived();
    this.scheduleSave();
    this.emit('project');
  }

  select(selection) {
    this.selection = selection;
    this.emit('selection');
  }

  get selectedZoom() {
    return this.selection && this.selection.type === 'zoom' ? this.project.zoomAnimations.find((clip) => clip.id === this.selection.id) || null : null;
  }

  get selectedSegment() {
    return this.selection && this.selection.type === 'segment' ? this.project.timeline.segments.find((segment) => segment.id === this.selection.id) || null : null;
  }

  scheduleSave() {
    this.saveState = 'pending';
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 500);
  }

  async save() {
    clearTimeout(this.saveTimer);
    if (this.saveState === 'saved') return;
    try {
      await ipcRenderer.invoke('project:write', { directory: this.directory, project: this.project });
      this.saveState = 'saved';
    } catch (error) {
      this.saveState = 'failed';
      console.error('[DogSC] 保存失败', error);
    }
    this.emit('save');
  }
}

module.exports = { Store };
