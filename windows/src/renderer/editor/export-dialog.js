'use strict';
// 导出面板：视频或音频、分辨率、帧率；导出中显示阶段、已用时间与预计剩余时间，可随时取消。

const { ipcRenderer } = require('electron');
const { element, formatTime } = require('../common');
const { RESOLUTIONS, canvasDimensions, exportVideoBitrate, EXPORT_AUDIO_BITRATE } = require('../../core/model');
const timeline = require('../../core/timeline');
const { exportProject, audioTracks } = require('./export');

function openExportDialog(store, preview, modal) {
  const { project, directory } = store;
  const options = { ...project.export };
  const duration = timeline.outputDuration(project.timeline.segments);
  const hasAudio = audioTracks(directory, project).length > 0;
  const close = () => { modal.hidden = true; modal.replaceChildren(); };
  const chips = (values, key, onChange) => element('div', { class: 'chips' }, Object.entries(values).map(([value, label]) =>
    element('button', { class: String(options[key]) === value ? 'active' : '', onclick: () => { options[key] = key === 'frameRate' ? Number(value) : value; onChange(); } }, label)));

  function showOptions() {
    const size = canvasDimensions(project.canvas, options.resolution, project.media.screen);
    const megabytes = options.kind === 'audio'
      ? duration * EXPORT_AUDIO_BITRATE / 8 / 1e6
      : duration * (exportVideoBitrate(size.width, size.height, options.frameRate) + (hasAudio ? EXPORT_AUDIO_BITRATE : 0)) / 8 / 1e6;
    const summary = options.kind === 'audio'
      ? `M4A · 时长 ${formatTime(duration, false)} · 最大约 ${Math.max(megabytes, 0.1).toFixed(1)} MB`
      : `MP4（H.264${hasAudio ? ' + AAC' : '，无声音'}）· ${size.width}×${size.height} · 时长 ${formatTime(duration, false)} · 最大约 ${Math.round(megabytes)} MB`;
    modal.replaceChildren(element('div', { class: 'dialog card' },
      element('h2', {}, '导出'),
      element('div', { class: 'section', style: 'padding-top:0' }, element('h3', {}, '类型'), chips({ video: '视频 MP4', audio: '音频 M4A' }, 'kind', showOptions)),
      options.kind === 'video' ? element('div', { class: 'section' }, element('h3', {}, '分辨率'),
        chips(Object.fromEntries(Object.entries(RESOLUTIONS).map(([id, item]) => [id, item.label])), 'resolution', showOptions)) : null,
      options.kind === 'video' ? element('div', { class: 'section' }, element('h3', {}, '帧率'), chips({ 30: '30 FPS', 60: '60 FPS' }, 'frameRate', showOptions)) : null,
      element('p', { class: 'note', style: 'margin-top:14px' }, summary),
      options.kind === 'audio' && !hasAudio ? element('p', { class: 'note', style: 'color:var(--danger)' }, '这个项目没有可导出的声音：没有录到麦克风或系统声音，或者都已静音。') : null,
      element('div', { class: 'actions' },
        element('button', { class: 'btn ghost', onclick: close }, '取消'),
        element('button', { class: 'btn primary', disabled: options.kind === 'audio' && !hasAudio, onclick: start }, '导出…'))));
  }

  async function start() {
    const outputFile = await ipcRenderer.invoke('dialog:save-export', { name: project.name, kind: options.kind });
    if (!outputFile) return;
    store.mutate((draft) => { draft.export = { ...options }; }, { history: false });
    preview.pause();
    await store.save();

    const controller = new AbortController();
    const stage = element('b', {}, '正在准备');
    const detail = element('span', { class: 'muted' }, '');
    const bar = element('i');
    modal.replaceChildren(element('div', { class: 'dialog card' },
      element('h2', {}, '正在导出'),
      stage, element('div', { class: 'progress' }, bar), detail,
      element('div', { class: 'actions' }, element('button', { class: 'btn', onclick: () => controller.abort() }, '取消导出'))));

    const startedAt = performance.now();
    const onProgress = ({ stage: name, fraction, frames, totalFrames }) => {
      const elapsed = (performance.now() - startedAt) / 1000;
      stage.textContent = name;
      bar.style.width = `${Math.round(fraction * 100)}%`;
      // 速度稳定（过了 3 秒且完成 5% 以上）后才给预计剩余时间。
      const remaining = name === '正在渲染画面' && elapsed > 3 && fraction > 0.05 ? `　预计还需 ${formatTime(elapsed / fraction - elapsed, false)}` : '';
      detail.textContent = `${Math.round(fraction * 100)}%${frames ? `　${frames} / ${totalFrames} 帧` : ''}　已用 ${formatTime(elapsed, false)}${remaining}`;
    };
    try {
      const result = await exportProject({ project: JSON.parse(JSON.stringify(store.project)), directory, outputFile, ...options, onProgress, signal: controller.signal });
      const seconds = (performance.now() - startedAt) / 1000;
      modal.replaceChildren(element('div', { class: 'dialog card' },
        element('h2', {}, '导出完成'),
        element('p', { class: 'note', style: 'user-select:text' }, outputFile),
        element('p', { class: 'note' }, result.width
          ? `${result.width}×${result.height} · ${result.frameRate} FPS · ${result.frames} 帧 · 用时 ${formatTime(seconds, false)}`
          : `时长 ${formatTime(result.duration, false)} · 用时 ${formatTime(seconds, false)}`),
        element('div', { class: 'actions' },
          element('button', { class: 'btn', onclick: () => ipcRenderer.send('project:reveal', outputFile) }, '在文件夹中显示'),
          element('button', { class: 'btn', onclick: () => ipcRenderer.send('shell:open', outputFile) }, '打开'),
          element('button', { class: 'btn primary', onclick: close }, '完成'))));
    } catch (error) {
      if (error.cancelled) {
        showOptions();
        return;
      }
      const message = String(error && error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      modal.replaceChildren(element('div', { class: 'dialog card' },
        element('h2', {}, '导出没有完成'),
        element('p', { class: 'note', style: 'user-select:text;color:var(--danger)' }, message),
        element('p', { class: 'note' }, '项目本身没有受影响。可以换一个分辨率或帧率再试；如果仍然失败，把上面这段信息反馈出来。'),
        element('div', { class: 'actions' },
          element('button', { class: 'btn', onclick: showOptions }, '返回导出设置'),
          element('button', { class: 'btn primary', onclick: close }, '关闭'))));
    }
  }

  modal.hidden = false;
  showOptions();
}

module.exports = { openExportDialog };
