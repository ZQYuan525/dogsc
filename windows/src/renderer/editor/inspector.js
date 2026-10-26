'use strict';
// 右侧检查器：画面 / 运镜 / 光标 / 摄像头 / 声音。控件直接读写项目文档，拖动过程合并成一步撤销。

const path = require('node:path');
const fs = require('node:fs');
const { ipcRenderer } = require('electron');
const { element, fileUrl } = require('../common');
const { PATTERN_PRESETS, CAMERA_SHAPES, CLICK_EFFECTS, ZOOM_EASINGS, clamp } = require('../../core/model');
const { planAutoZoom } = require('../../core/zoom');
const { isInside } = require('../../core/pointer');

const TABS = [
  { id: 'canvas', label: '画面', icon: 'canvas' },
  { id: 'motion', label: '运镜', icon: 'motion' },
  { id: 'cursor', label: '光标', icon: 'cursor' },
  { id: 'camera', label: '摄像头', icon: 'camera' },
  { id: 'audio', label: '声音', icon: 'speaker' },
];

class Inspector {
  constructor(store, preview, root, title) {
    this.store = store;
    this.preview = preview;
    this.root = root;
    this.title = title;
    this.tab = 'canvas';
    this.wallpapers = null;
    store.subscribe((reason) => {
      // 拖动滑块时只更新数值显示，不重建控件，否则正在拖的滑块会被换掉。
      if (reason === 'project' && store.gesture) this.refreshValues();
      else if (reason === 'project' || reason === 'selection' || reason === 'history') this.render();
    });
    ipcRenderer.invoke('system:wallpapers').then((wallpapers) => { this.wallpapers = wallpapers; if (this.tab === 'canvas') this.render(); });
  }

  show(tab) {
    this.tab = tab;
    this.render();
  }

  // ---------------------------------------------------------------- 控件

  section(title, ...children) {
    return element('div', { class: 'section' }, title ? element('h3', {}, title) : null, children);
  }

  slider(label, get, set, { min, max, step, format = (value) => String(value) }) {
    const value = element('span', { class: 'value' }, format(get()));
    const input = element('input', { type: 'range', min, max, step, value: get() });
    input.addEventListener('pointerdown', () => this.store.beginGesture());
    input.addEventListener('input', () => {
      this.store.beginGesture();
      this.store.mutate(() => set(Number(input.value)), { history: false });
    });
    // 只按下没拖动时不会有 change 事件，松手与失焦也要收尾。
    for (const type of ['change', 'pointerup', 'blur']) input.addEventListener(type, () => this.store.endGesture());
    this.refreshers.push(() => { value.textContent = format(get()); });
    return element('label', { class: 'field' }, element('span', {}, label), value, input);
  }

  toggle(label, get, set) {
    const button = element('button', { class: `switch${get() ? ' on' : ''}`, onclick: () => this.store.mutate(() => set(!get())) });
    return element('div', { class: 'field' }, element('span', {}, label), button);
  }

  select(label, options, get, set) {
    const input = element('select', {}, Object.entries(options).map(([value, text]) => element('option', { value, selected: value === String(get()) }, text)));
    input.addEventListener('change', () => this.store.mutate(() => set(input.value)));
    return element('div', { class: 'field' }, element('span', {}, label), input);
  }

  color(label, get, set) {
    const input = element('input', { type: 'color', value: get() });
    input.addEventListener('input', () => { this.store.beginGesture(); this.store.mutate(() => set(input.value.toUpperCase()), { history: false }); });
    input.addEventListener('change', () => this.store.endGesture());
    return element('div', { class: 'field' }, element('span', {}, label), input);
  }

  chips(options, get, set) {
    return element('div', { class: 'chips' }, Object.entries(options).map(([value, text]) =>
      element('button', { class: value === String(get()) ? 'active' : '', onclick: () => this.store.mutate(() => set(value)) }, text)));
  }

  button(label, onClick, kind = '') {
    return element('button', { class: `btn ${kind}`, onclick: onClick }, label);
  }

  /// 二维定位板：在 0…1 的方框里拖动一个点。
  pad(get, set, { aspect, background, viewport }) {
    const dot = element('i');
    const view = viewport ? element('div', { class: 'view' }) : null;
    const node = element('div', { class: 'pad', style: `aspect-ratio:${aspect};${background ? `background-image:url("${background}")` : ''}` }, view, dot);
    const place = () => {
      const point = get();
      dot.style.left = `${point.x * 100}%`;
      dot.style.top = `${point.y * 100}%`;
      if (view) {
        const rect = viewport();
        Object.assign(view.style, { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` });
      }
    };
    const update = (event) => {
      const bounds = node.getBoundingClientRect();
      const point = { x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1), y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1) };
      this.store.mutate(() => set(point), { history: false });
    };
    node.addEventListener('pointerdown', (event) => {
      node.setPointerCapture(event.pointerId);
      this.store.beginGesture();
      update(event);
      const move = (moveEvent) => update(moveEvent);
      const up = () => {
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', up);
        this.store.endGesture();
      };
      node.addEventListener('pointermove', move);
      node.addEventListener('pointerup', up);
    });
    this.refreshers.push(place);
    place();
    return node;
  }

  refreshValues() { for (const refresh of this.refreshers) refresh(); }

  render() {
    this.refreshers = [];
    const tab = TABS.find((item) => item.id === this.tab);
    this.title.textContent = tab.label;
    const scroll = this.root.scrollTop;
    this.root.replaceChildren(...this[`${this.tab}Panel`]());
    this.root.scrollTop = scroll;
  }

  // ---------------------------------------------------------------- 面板

  canvasPanel() {
    const { project } = this.store;
    const canvas = project.canvas;
    const background = canvas.background;
    const setBackground = (value) => this.store.mutate((draft) => { draft.canvas.background = value; });
    const patterns = Object.entries(PATTERN_PRESETS).map(([id, preset]) => element('button', {
      class: background.kind === 'pattern' && background.preset === id ? 'active' : '', title: preset.label,
      style: `background:${preset.background};background-image:${preset.kind === 'dots'
        ? `radial-gradient(${preset.dot} 1px, transparent 1.4px)` : `linear-gradient(${preset.stroke} 1px, transparent 1px), linear-gradient(90deg, ${preset.stroke} 1px, transparent 1px)`};background-size:9px 9px`,
      onclick: () => setBackground({ kind: 'pattern', preset: id }),
    }));
    const files = this.wallpapers ? [this.wallpapers.current, ...this.wallpapers.files].filter(Boolean) : [];
    const wallpapers = files.slice(0, 8).map((file, index) => element('button', {
      class: background.kind === 'image' && background.file === file ? 'active' : '', title: index === 0 && this.wallpapers.current ? '当前桌面壁纸' : path.basename(file),
      style: `background-image:url("${fileUrl(file)}")`, onclick: () => setBackground({ kind: 'image', file }),
    }));
    const pickImage = async () => {
      const file = await ipcRenderer.invoke('dialog:open-image');
      if (!file) return;
      // 自选图片复制进项目包，移动或拷贝项目时背景不会丢。
      const name = `background${path.extname(file).toLowerCase()}`;
      fs.copyFileSync(file, path.join(this.store.directory, 'media', name));
      this.preview.compositor.images.delete(path.join(this.store.directory, 'media', name));
      setBackground({ kind: 'image', file: `media/${name}`, stamp: Date.now() });
    };
    return [
      this.section('背景',
        element('div', { class: 'swatches' }, patterns),
        files.length ? element('p', { class: 'note' }, 'Windows 壁纸') : null,
        files.length ? element('div', { class: 'swatches' }, wallpapers) : null,
        element('div', { class: 'row' },
          this.button('选择图片…', pickImage),
          this.button('纯色', () => setBackground({ kind: 'color', color: background.color || '#1F2A44' }))),
        background.kind === 'color' ? this.color('颜色', () => background.color, (value) => { canvas.background = { kind: 'color', color: value }; }) : null,
        background.kind === 'image' ? this.slider('背景模糊', () => canvas.backgroundBlur, (value) => { canvas.backgroundBlur = value; }, { min: 0, max: 60, step: 1 }) : null,
        background.kind === 'pattern' ? this.slider('图案大小', () => canvas.patternScale, (value) => { canvas.patternScale = value; }, { min: 0.4, max: 4, step: 0.05, format: (value) => `${value.toFixed(2)}×` }) : null),
      this.section('画面留白',
        this.slider('边距', () => canvas.padding, (value) => { canvas.padding = value; }, { min: 0, max: 320, step: 2 })),
      this.section('位置与大小',
        this.pad(() => canvas.contentPosition, (point) => { canvas.contentPosition = point; }, { aspect: '16 / 9' }),
        this.slider('素材缩放', () => canvas.contentScale, (value) => { canvas.contentScale = value; }, { min: 0.5, max: 2, step: 0.01, format: (value) => `${value.toFixed(2)}×` }),
        element('div', { class: 'row' }, this.button('恢复位置与大小', () => this.store.mutate((draft) => { draft.canvas.contentPosition = { x: 0.5, y: 0.5 }; draft.canvas.contentScale = 1; })))),
      this.section('圆角、描边与阴影',
        this.slider('内容圆角', () => canvas.cornerRadius, (value) => { canvas.cornerRadius = value; }, { min: 0, max: 120, step: 1 }),
        this.slider('外描边', () => canvas.borderWidth, (value) => { canvas.borderWidth = value; }, { min: 0, max: 30, step: 0.5 }),
        canvas.borderWidth > 0 ? this.color('描边颜色', () => canvas.borderColor, (value) => { canvas.borderColor = value; }) : null,
        this.slider('阴影', () => canvas.shadowStrength, (value) => { canvas.shadowStrength = value; }, { min: 0, max: 1, step: 0.01, format: (value) => `${Math.round(value * 100)}%` })),
    ];
  }

  motionPanel() {
    const { project, pointerTrack } = this.store;
    const motion = project.motion;
    const clip = this.store.selectedZoom;
    const clicks = pointerTrack ? pointerTrack.clicks.filter(isInside).length : 0;
    const regenerate = () => this.store.mutate((draft) => {
      const manual = draft.zoomAnimations.filter((item) => item.origin === 'manual');
      const automatic = planAutoZoom(pointerTrack.events.filter(isInside), {
        zoomScale: draft.motion.defaultZoomScale, easing: draft.motion.defaultZoomEasing,
        transitionDuration: draft.motion.defaultZoomTransitionDuration, duration: draft.media.screen.duration,
      // 手动缩放优先：与手动片段重叠的自动片段不生成。
      }).filter((item) => !manual.some((other) => item.startTime < other.endTime + other.exitDuration && other.startTime < item.endTime + item.exitDuration));
      draft.zoomAnimations = [...manual, ...automatic];
    });
    const sections = [];
    if (clip) {
      const source = project.media.screen;
      const thumbnails = project.media.thumbnails;
      sections.push(this.section(`选中的缩放 · ${clip.origin === 'automatic' ? '自动跟随' : '手动'}`,
        this.slider('放大倍率', () => clip.scale, (value) => { clip.scale = value; }, { min: 1.1, max: 4, step: 0.05, format: (value) => `${value.toFixed(2)}×` }),
        element('p', { class: 'note' }, clip.origin === 'automatic' ? '自动缩放的镜头会跟着指针走。在下面的画面里点一下，可以改成固定看某个位置。' : '点击或拖动下面的画面，指定镜头对准的位置。'),
        this.pad(() => clip.focus, (point) => { clip.focus = point; clip.origin = 'manual'; }, {
          aspect: `${source.width} / ${source.height}`,
          background: null,
          viewport: () => {
            const span = 1 / clip.scale;
            return { x: clamp(clip.focus.x - span / 2, 0, 1 - span), y: clamp(clip.focus.y - span / 2, 0, 1 - span), width: span, height: span };
          },
        }),
        this.select('缓动', ZOOM_EASINGS, () => clip.easing, (value) => { clip.easing = value; }),
        this.slider('进入时长', () => clip.enterDuration, (value) => { clip.enterDuration = value; }, { min: 0, max: 2, step: 0.05, format: (value) => `${value.toFixed(2)} 秒` }),
        this.slider('退出时长', () => clip.exitDuration, (value) => { clip.exitDuration = value; }, { min: 0, max: 2, step: 0.05, format: (value) => `${value.toFixed(2)} 秒` }),
        element('div', { class: 'row' },
          clip.origin === 'manual' && pointerTrack ? this.button('改回自动跟随', () => this.store.mutate(() => { clip.origin = 'automatic'; })) : null,
          this.button('删除这段缩放', () => { this.store.mutate((draft) => { draft.zoomAnimations = draft.zoomAnimations.filter((item) => item.id !== clip.id); }); this.store.select(null); }, 'danger'))));
      // 定位板背景：取该缩放起点附近的缩略图，方便对着画面选位置。
      if (thumbnails) {
        const index = clamp(Math.floor(clip.startTime / thumbnails.interval), 0, thumbnails.count - 1);
        const pad = sections[0].querySelector('.pad');
        pad.style.backgroundImage = `url("${fileUrl(path.join(this.store.directory, thumbnails.file))}")`;
        pad.style.backgroundSize = `${thumbnails.count * 100}% 100%`;
        pad.style.backgroundPosition = `${thumbnails.count > 1 ? (index / (thumbnails.count - 1)) * 100 : 0}% 0`;
      }
    } else {
      sections.push(this.section('缩放', element('p', { class: 'note' }, '在时间线的「缩放」轨上点选一段可以单独调整；双击空白处或按 Z 在播放头位置添加一段手动缩放。')));
    }
    sections.push(this.section('自动缩放',
      element('p', { class: 'note' }, pointerTrack
        ? `这次录制记录到 ${clicks} 次点击。自动缩放会在点击处放大，并在连续操作时保持、跟随指针。`
        : '这个项目没有指针记录，无法自动生成缩放，可以手动添加。'),
      this.slider('默认放大倍率', () => motion.defaultZoomScale, (value) => { motion.defaultZoomScale = value; }, { min: 1.1, max: 3, step: 0.05, format: (value) => `${value.toFixed(2)}×` }),
      this.slider('过渡时长', () => motion.defaultZoomTransitionDuration, (value) => { motion.defaultZoomTransitionDuration = value; }, { min: 0.1, max: 2, step: 0.05, format: (value) => `${value.toFixed(2)} 秒` }),
      this.select('缓动', ZOOM_EASINGS, () => motion.defaultZoomEasing, (value) => { motion.defaultZoomEasing = value; }),
      element('div', { class: 'row' },
        pointerTrack && clicks ? this.button('按点击重新生成', regenerate) : null,
        project.zoomAnimations.length ? this.button('清除全部缩放', () => { this.store.mutate((draft) => { draft.zoomAnimations = []; }); this.store.select(null); }, 'danger') : null)));
    return sections;
  }

  cursorPanel() {
    const { project, pointerTrack } = this.store;
    const style = project.cursorStyle;
    if (!pointerTrack) return [this.section('光标', element('p', { class: 'note' }, '这个项目没有指针记录。'))];
    return [
      this.section('样式',
        this.chips({ automatic: '跟随录制', arrow: '箭头', pointingHand: '手型', hidden: '隐藏' }, () => style.appearance, (value) => { style.appearance = value; }),
        this.slider('大小', () => style.size, (value) => { style.size = value; }, { min: 0.5, max: 4, step: 0.05, format: (value) => `${value.toFixed(2)}×` }),
        this.toggle('移动平滑', () => project.motion.cursor === 'smooth', (on) => { project.motion.cursor = on ? 'smooth' : 'none'; }),
        this.toggle('静止后隐藏', () => style.hideWhenIdle, (on) => { style.hideWhenIdle = on; }),
        style.hideWhenIdle ? this.slider('静止多久后隐藏', () => style.idleDelay, (value) => { style.idleDelay = value; }, { min: 0.2, max: 5, step: 0.1, format: (value) => `${value.toFixed(1)} 秒` }) : null),
      this.section('点击反馈',
        this.select('效果', Object.fromEntries(Object.entries(CLICK_EFFECTS).map(([id, effect]) => [id, effect.label])), () => style.clickEffectStyle, (value) => { style.clickEffectStyle = value; }),
        style.clickEffectStyle !== 'none' ? this.color('颜色', () => style.clickColor || '#FFFFFF', (value) => { style.clickColor = value; }) : null,
        style.clickEffectStyle !== 'none' ? this.slider('不透明度', () => style.clickOpacity, (value) => { style.clickOpacity = value; }, { min: 0.05, max: 1, step: 0.01, format: (value) => `${Math.round(value * 100)}%` }) : null,
        style.clickEffectStyle !== 'none' ? this.slider('大小', () => style.clickScale, (value) => { style.clickScale = value; }, { min: 0.4, max: 3, step: 0.05, format: (value) => `${value.toFixed(2)}×` }) : null),
      this.section('时间校准',
        element('p', { class: 'note' }, '光标比画面早或晚时在这里微调，不影响移动平滑。正值让光标更早出现。'),
        this.slider('光标时间', () => style.timeOffset, (value) => { style.timeOffset = value; }, { min: -0.5, max: 0.5, step: 0.005, format: (value) => `${value > 0 ? '+' : ''}${Math.round(value * 1000)} 毫秒` })),
    ];
  }

  cameraPanel() {
    const { project } = this.store;
    const camera = project.camera;
    if (!project.media.camera) return [this.section('摄像头', element('p', { class: 'note' }, '这次录制没有开摄像头。在录制条上打开摄像头后再录，摄像头画面会作为单独一轨进入项目。'))];
    return [
      this.section('显示',
        this.toggle('显示摄像头', () => !camera.isHidden, (on) => { camera.isHidden = !on; }),
        this.toggle('镜像', () => camera.isMirrored, (on) => { camera.isMirrored = on; })),
      this.section('形状与大小',
        this.chips(Object.fromEntries(Object.entries(CAMERA_SHAPES).map(([id, shape]) => [id, shape.label])), () => camera.shape, (value) => { camera.shape = value; }),
        this.slider('大小', () => camera.size, (value) => { camera.size = value; }, { min: 0.1, max: 1, step: 0.01, format: (value) => `${Math.round(value * 100)}%` }),
        camera.shape !== 'circle' ? this.slider('圆角', () => camera.roundness, (value) => { camera.roundness = value; }, { min: 0, max: 1, step: 0.01, format: (value) => `${Math.round(value * 100)}%` }) : null,
        this.slider('屏幕放大时', () => camera.scaleDuringZoom, (value) => { camera.scaleDuringZoom = value; }, { min: 0.3, max: 1, step: 0.01, format: (value) => `缩到 ${Math.round(value * 100)}%` })),
      this.section('位置',
        this.pad(() => camera.position, (point) => { camera.position = point; }, { aspect: '16 / 9' }),
        this.chips({ 'tl': '左上', 'tr': '右上', 'bl': '左下', 'br': '右下' }, () => '', (value) => {
          camera.position = { x: value[1] === 'l' ? 0.04 : 0.96, y: value[0] === 't' ? 0.06 : 0.94 };
        })),
      this.section('描边与阴影',
        this.slider('描边', () => camera.borderWidth, (value) => { camera.borderWidth = value; }, { min: 0, max: 18, step: 0.5 }),
        this.slider('阴影', () => camera.shadowStrength, (value) => { camera.shadowStrength = value; }, { min: 0, max: 1, step: 0.01, format: (value) => `${Math.round(value * 100)}%` })),
    ];
  }

  audioPanel() {
    const { project } = this.store;
    const audio = project.audio;
    const percent = (value) => `${Math.round(value * 100)}%`;
    const track = (title, present, mutedKey, volumeKey, missing) => this.section(title, ...(present ? [
      this.toggle('静音', () => audio[mutedKey], (on) => { audio[mutedKey] = on; }),
      this.slider('音量', () => audio[volumeKey], (value) => { audio[volumeKey] = value; }, { min: 0, max: 1, step: 0.01, format: percent }),
    ] : [element('p', { class: 'note' }, missing)]));
    return [
      track('麦克风', project.media.microphone, 'isMicrophoneMuted', 'microphoneVolume', '这次录制没有录麦克风。'),
      track('系统声音', project.media.systemAudio, 'isSystemMuted', 'systemVolume', '这次录制没有录系统声音。'),
    ];
  }
}

module.exports = { Inspector, TABS };
