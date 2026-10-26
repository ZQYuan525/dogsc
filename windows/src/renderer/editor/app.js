'use strict';
// 编辑器入口：装配状态、预览、时间线、检查器，并接好工具栏与快捷键。

const { ipcRenderer } = require('electron');
const { query, icon, element, formatTime } = require('../common');
const { ASPECT_RATIOS } = require('../../core/model');
const timeline = require('../../core/timeline');
const { Store } = require('./store');
const { Preview } = require('./preview');
const { TimelineView } = require('./timeline-view');
const { Inspector, TABS } = require('./inspector');
const { openExportDialog } = require('./export-dialog');

const $ = (id) => document.getElementById(id);
const directory = query.get('project');

const SHORTCUTS = [
  ['空格', '播放 / 暂停'], ['S　或　Ctrl+B', '在播放头处分割'], ['Delete', '删除选中的片段或缩放'], ['Z', '在播放头处添加缩放'],
  ['← / →', '逐帧移动（按住 Shift 每次 1 秒）'], ['Home / End', '跳到开头 / 结尾'], ['Ctrl+Z', '撤销'], ['Ctrl+Shift+Z　或　Ctrl+Y', '重做'],
  ['Ctrl+滚轮', '缩放时间线'], ['Ctrl+E', '导出'],
];

function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 2200);
}

async function main() {
  const project = await ipcRenderer.invoke('project:read', directory);
  const store = new Store(directory, project);
  const preview = new Preview(store, $('preview'), $('canvas-wrap'));
  const timelineView = new TimelineView(store, preview, {
    scroller: $('scroller'), lanes: $('lanes'), ruler: $('ruler'), screen: $('lane-screen'), zoom: $('lane-zoom'), playhead: $('playhead'), slider: $('timeline-zoom'),
  });
  const inspector = new Inspector(store, preview, $('inspector'), $('inspector-title'));

  // ---- 顶栏
  $('open-library').innerHTML = icon('folder');
  $('undo').innerHTML = icon('undo');
  $('redo').innerHTML = icon('redo');
  $('export').innerHTML = `${icon('export')}导出`;
  $('project-name').value = project.name;
  $('project-name').addEventListener('change', (event) => {
    const name = event.target.value.trim() || project.name;
    event.target.value = name;
    store.mutate((draft) => { draft.name = name; });
    document.title = `${name} — DogSC`;
  });
  $('project-name').addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === 'Escape') event.target.blur(); });
  $('open-library').addEventListener('click', () => ipcRenderer.send('recorder:library'));
  $('undo').addEventListener('click', () => store.undo());
  $('redo').addEventListener('click', () => store.redo());
  $('export').addEventListener('click', () => openExportDialog(store, preview, $('modal')));
  $('shortcuts').addEventListener('click', () => {
    const modal = $('modal');
    modal.hidden = false;
    modal.replaceChildren(element('div', { class: 'dialog card' }, element('h2', {}, '快捷键'),
      element('div', { class: 'keys' }, SHORTCUTS.flatMap(([keys, action]) => [element('kbd', {}, keys), element('span', {}, action)])),
      element('div', { class: 'actions' }, element('button', { class: 'btn primary', onclick: () => { modal.hidden = true; } }, '知道了'))));
  });

  // ---- 左侧分类栏与画布比例
  const railButtons = TABS.map((tab) => element('button', { html: `${icon(tab.icon)}<span>${tab.label}</span>`, onclick: () => showTab(tab.id) }));
  $('rail').append(...railButtons);
  function showTab(id) {
    railButtons.forEach((button, index) => button.classList.toggle('active', TABS[index].id === id));
    inspector.show(id);
  }
  function renderRatio() {
    $('ratio').replaceChildren(...Object.entries(ASPECT_RATIOS).map(([id, item]) => element('button', {
      class: store.project.canvas.aspectRatio === id ? 'active' : '', onclick: () => store.mutate((draft) => { draft.canvas.aspectRatio = id; }),
    }, item.label)));
  }

  // ---- 时间线工具栏
  $('split').innerHTML = icon('scissors');
  $('delete').innerHTML = icon('trash');
  $('previous').innerHTML = icon('previous');
  $('next').innerHTML = icon('next');
  $('zoom-out').innerHTML = icon('minus');
  $('zoom-in').innerHTML = icon('plus');
  $('label-screen').innerHTML = `${icon('display')}屏幕录制`;
  $('label-zoom').innerHTML = `${icon('motion')}缩放`;

  const split = () => {
    const next = timeline.splitAt(store.project.timeline.segments, preview.time);
    if (!next) return toast('离片段边缘太近，无法在这里分割');
    store.mutate((draft) => { draft.timeline.segments = next; });
    return null;
  };
  const remove = () => {
    if (store.selectedZoom) {
      const { id } = store.selectedZoom;
      store.mutate((draft) => { draft.zoomAnimations = draft.zoomAnimations.filter((clip) => clip.id !== id); });
      store.select(null);
    } else if (store.selectedSegment) {
      const next = timeline.removeSegment(store.project.timeline.segments, store.selectedSegment.id);
      if (!next) return toast('至少要保留一个片段');
      store.mutate((draft) => { draft.timeline.segments = next; });
      store.select(null);
    } else {
      toast('先在时间线上点选一个片段或一段缩放');
    }
    return null;
  };
  const addZoom = () => {
    if (!timelineView.addZoomAt(preview.time)) return toast('这个位置已经有缩放了，或离下一段缩放太近');
    showTab('motion');
    return null;
  };
  const chooseSpeed = async () => {
    const segment = store.selectedSegment || timeline.locate(store.project.timeline.segments, preview.time).segment;
    const chosen = await ipcRenderer.invoke('recorder:menu', timeline.SPEEDS.map((speed) => ({ id: String(speed), label: `${speed}×`, checked: Math.abs(segment.speed - speed) < 1e-6 })));
    if (!chosen) return;
    // 变速后保持播放头停在同一处素材上。
    const sourceTime = preview.sourceTime;
    store.mutate((draft) => { draft.timeline.segments = timeline.setSpeed(draft.timeline.segments, segment.id, Number(chosen)); });
    preview.seek(timeline.sourceToOutput(store.project.timeline.segments, sourceTime));
  };
  /// 剪辑点、标记、缩放起点都算可跳转的位置。
  const jump = (direction) => {
    const { segments } = store.project.timeline;
    const points = new Set([0, timeline.outputDuration(segments)]);
    let start = 0;
    for (const segment of segments) { points.add(start); start += timeline.segmentOutputDuration(segment); }
    for (const marker of store.project.markers) if (timeline.isRetained(segments, marker.time)) points.add(timeline.sourceToOutput(segments, marker.time));
    for (const clip of store.zoomClips) if (timeline.isRetained(segments, clip.startTime)) points.add(timeline.sourceToOutput(segments, clip.startTime));
    const ordered = [...points].sort((a, b) => a - b);
    const target = direction > 0 ? ordered.find((point) => point > preview.time + 0.02) : ordered.reverse().find((point) => point < preview.time - 0.02);
    if (target !== undefined) preview.seek(target);
  };

  $('split').addEventListener('click', split);
  $('delete').addEventListener('click', remove);
  $('speed').addEventListener('click', chooseSpeed);
  $('add-zoom').addEventListener('click', addZoom);
  $('add-zoom').innerHTML = `${icon('plus')}缩放`;
  $('previous').addEventListener('click', () => jump(-1));
  $('next').addEventListener('click', () => jump(1));
  $('play').addEventListener('click', () => preview.toggle());
  $('zoom-out').addEventListener('click', () => timelineView.setZoom(Math.max(timelineView.zoomLevel - 0.1, 0)));
  $('zoom-in').addEventListener('click', () => timelineView.setZoom(Math.min(timelineView.zoomLevel + 0.1, 1)));

  // ---- 状态同步
  const refreshChrome = () => {
    const segment = store.selectedSegment || timeline.locate(store.project.timeline.segments, preview.time).segment;
    $('speed').innerHTML = `${icon('speed')}${segment.speed}×`;
    $('undo').disabled = !store.undoStack.length;
    $('redo').disabled = !store.redoStack.length;
    $('clock-total').textContent = formatTime(timeline.outputDuration(store.project.timeline.segments));
    $('save-state').textContent = { saved: '已保存', pending: '正在保存…', failed: '保存失败，请检查磁盘空间或权限' }[store.saveState];
    $('save-state').style.color = store.saveState === 'failed' ? 'var(--danger)' : '';
    renderRatio();
  };
  store.subscribe(refreshChrome);
  preview.onState = () => { $('play').innerHTML = icon(preview.playing ? 'pause' : 'play'); };
  preview.onTime = (time) => {
    $('clock-now').textContent = formatTime(time);
    timelineView.updatePlayhead();
  };
  preview.onState();
  preview.onTime(0);
  refreshChrome();
  showTab('canvas');

  // ---- 快捷键
  window.addEventListener('keydown', (event) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) && event.target.type !== 'range';
    const control = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (!$('modal').hidden) {
      if (event.key === 'Escape' && !$('modal').querySelector('.progress')) { $('modal').hidden = true; }
      return;
    }
    if (typing) return;
    const frame = 1 / (store.project.media.screen.frameRate || 60);
    const handlers = [
      [control && key === 'z' && !event.shiftKey, () => store.undo()],
      [control && ((key === 'z' && event.shiftKey) || key === 'y'), () => store.redo()],
      [control && key === 'e', () => openExportDialog(store, preview, $('modal'))],
      [control && key === 'b', split],
      [!control && key === ' ', () => preview.toggle()],
      [!control && key === 's', split],
      [!control && key === 'z', addZoom],
      [key === 'delete' || key === 'backspace', remove],
      [key === 'arrowleft', () => { preview.pause(); preview.seek(preview.time - (event.shiftKey ? 1 : frame)); }],
      [key === 'arrowright', () => { preview.pause(); preview.seek(preview.time + (event.shiftKey ? 1 : frame)); }],
      [key === 'home', () => preview.seek(0)],
      [key === 'end', () => preview.seek(preview.duration)],
      [key === 'escape', () => store.select(null)],
    ];
    const match = handlers.find(([condition]) => condition);
    if (!match) return;
    event.preventDefault();
    match[1]();
  });

  // 关窗前把还没落盘的改动写完。
  window.addEventListener('beforeunload', () => { store.save(); });
  document.title = `${project.name} — DogSC`;

  // 自测钩子：切到运镜面板、选中第一段缩放并跳到它的保持区间。
  window.dogscSelfTest = () => {
    const clip = store.zoomClips[0];
    if (clip) {
      store.select({ type: 'zoom', id: clip.id });
      preview.seek(timeline.sourceToOutput(store.project.timeline.segments, clip.startTime + clip.enterDuration + 0.4));
    }
    showTab('motion');
    return { zoomClips: store.zoomClips.length, segments: store.project.timeline.segments.length, time: preview.time, canvas: `${$('preview').width}x${$('preview').height}`, screenReady: preview.screen.node.readyState };
  };
}

main().catch((error) => {
  document.body.replaceChildren(element('div', { style: 'padding:40px;font-size:15px;user-select:text' },
    element('b', {}, '这个项目打不开'), element('p', {}, String(error && error.message || error)),
    element('p', { class: 'muted' }, directory || '')));
});
