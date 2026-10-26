'use strict';
// 项目模型与默认值。字段名与默认数值对齐 macOS 版 RecorderCore/ProjectModel.swift，
// 所有视觉尺寸按 1080 短边设计（见 scene.js 的 canonicalStyleScale）。

const { randomUUID } = require('node:crypto');

const clamp = (value, lower, upper) => Math.min(Math.max(value, lower), upper);
const even = (value) => Math.max(Math.round(value / 2) * 2, 2);

const ASPECT_RATIOS = {
  adaptive: { label: '适应', ratio: null },
  landscape: { label: '16:9', ratio: 16 / 9 },
  standard: { label: '4:3', ratio: 4 / 3 },
  portrait: { label: '9:16', ratio: 9 / 16 },
  square: { label: '1:1', ratio: 1 },
  standardPortrait: { label: '3:4', ratio: 3 / 4 },
  cinema: { label: '2.39:1', ratio: 2.39 },
};

const RESOLUTIONS = {
  source: { label: '原始素材', short: null, long: null },
  fullHD: { label: '1080p', short: 1080, long: 1920 },
  quadHD: { label: '1440p', short: 1440, long: 2560 },
  ultraHD: { label: '4K', short: 2160, long: 3840 },
};

const PATTERN_PRESETS = {
  obsidianGrid: { label: '黑曜石网格', background: '#0F0F0F', stroke: '#3D3D3D', kind: 'grid', fraction: 0.0425 },
  engineeringWhiteGrid: { label: '工程白网格', background: '#F7F7F7', stroke: '#C9C9C9', kind: 'grid', fraction: 0.040 },
  midnightDots: { label: '暗夜星阵', background: '#111111', dot: 'rgba(194,173,138,0.90)', kind: 'dots', fraction: 0.032 },
  architecturalDots: { label: '建筑极简点', background: '#F9F9F9', dot: 'rgba(148,148,148,0.75)', kind: 'dots', fraction: 0.030 },
  isometricMesh: { label: '立体等角网', background: '#131313', stroke: '#4F4A42', kind: 'iso', fraction: 0.050 },
};

const CAMERA_SHAPES = {
  square: { label: '方形', aspect: 1 },
  horizontal: { label: '横向', aspect: 1.5 },
  vertical: { label: '纵向', aspect: 0.72 },
  original: { label: '原始比例', aspect: null },
  circle: { label: '圆形', aspect: 1 },
};

const CLICK_EFFECTS = {
  ripple: { label: '涟漪扩散', duration: 0.36 },
  glow: { label: '柔和光晕', duration: 0.32 },
  pulse: { label: '弹性双环', duration: 0.38 },
  burst: { label: '聚焦微闪', duration: 0.22 },
  none: { label: '无效果', duration: 0 },
};

const ZOOM_EASINGS = {
  linear: '线性', quadratic: '二次方缓动', cubic: '三次方缓动', quintic: '五次平滑', spring: '弹簧',
};

function defaultCanvas() {
  return {
    aspectRatio: 'adaptive',
    background: { kind: 'pattern', preset: 'obsidianGrid' },
    backgroundBlur: 0,
    padding: 100,
    contentScale: 1,
    contentPosition: { x: 0.5, y: 0.5 },
    cornerRadius: 24,
    borderWidth: 0,
    borderColor: '#FFFFFF',
    shadowStrength: 0.28,
    patternScale: 1,
    patternOpacity: 1,
  };
}

function defaultCamera() {
  return {
    shape: 'square',
    position: { x: 0.96, y: 0.47 },
    size: 0.29,
    borderWidth: 3,
    shadowStrength: 0.25,
    roundness: 0.5,
    isMirrored: true,
    isHidden: false,
    scaleDuringZoom: 0.7,
  };
}

function defaultCursorStyle() {
  return {
    appearance: 'automatic', // automatic | arrow | pointingHand | hidden
    size: 1.25,
    hideWhenIdle: false,
    idleDelay: 1.2,
    clickEffectStyle: 'ripple',
    clickColor: null,
    clickOpacity: 0.8,
    clickScale: 1,
    timeOffset: 0, // 光标时间校准（秒），不改变平滑参数
  };
}

function defaultMotion() {
  return {
    cursor: 'smooth', // smooth | none
    screenSpringMass: 2.4,
    screenSpringStiffness: 210,
    screenSpringDamping: 42,
    cursorSpringMass: 2.8,
    cursorSpringStiffness: 450,
    cursorSpringDamping: 66,
    defaultZoomEasing: 'spring',
    defaultZoomTransitionDuration: 0.7,
    defaultZoomScale: 1.6,
  };
}

function defaultAudio() {
  return { systemVolume: 0.82, microphoneVolume: 0.9, isSystemMuted: false, isMicrophoneMuted: false };
}

function makeProject({ name, media, capture }) {
  const duration = media.screen.duration;
  return {
    schema: 1,
    app: 'dogsc-windows',
    name,
    createdAt: new Date().toISOString(),
    media,
    capture,
    canvas: defaultCanvas(),
    camera: defaultCamera(),
    cursorStyle: defaultCursorStyle(),
    motion: defaultMotion(),
    audio: defaultAudio(),
    zoomAnimations: [],
    timeline: { segments: [{ id: randomUUID(), sourceStart: 0, sourceEnd: duration, speed: 1 }] },
    markers: [],
    export: { kind: 'video', resolution: 'source', frameRate: 60 },
  };
}

/// 旧项目补默认值；新增字段在这里兜底，不改用户已保存的值。
function normalizeProject(project) {
  const merge = (defaults, value) => ({ ...defaults, ...(value || {}) });
  project.canvas = merge(defaultCanvas(), project.canvas);
  project.camera = merge(defaultCamera(), project.camera);
  project.cursorStyle = merge(defaultCursorStyle(), project.cursorStyle);
  project.motion = merge(defaultMotion(), project.motion);
  project.audio = merge(defaultAudio(), project.audio);
  project.zoomAnimations = project.zoomAnimations || [];
  project.markers = project.markers || [];
  project.export = merge({ kind: 'video', resolution: 'source', frameRate: 60 }, project.export);
  if (!project.timeline || !project.timeline.segments || !project.timeline.segments.length) {
    project.timeline = { segments: [{ id: randomUUID(), sourceStart: 0, sourceEnd: project.media.screen.duration, speed: 1 }] };
  }
  return project;
}

function fixedAspectRatio(canvas) {
  const entry = ASPECT_RATIOS[canvas.aspectRatio];
  return entry ? entry.ratio : null;
}

/// 对应 CanvasStyle.pixelDimensions：导出画布像素尺寸。
function canvasDimensions(canvas, resolution, source) {
  const src = source || { width: 1920, height: 1080 };
  const fixed = fixedAspectRatio(canvas);
  const preset = RESOLUTIONS[resolution] || RESOLUTIONS.source;
  if (!preset.short) {
    const w = Math.max(src.width, 2);
    const h = Math.max(src.height, 2);
    if (!fixed) return { width: even(w), height: even(h) };
    // 固定比例在素材像素包络内取最大，不放大素材。
    return w / h >= fixed
      ? { width: even(h * fixed), height: even(h) }
      : { width: even(w), height: even(w / fixed) };
  }
  const { short, long } = preset;
  switch (canvas.aspectRatio) {
    case 'landscape': return { width: even(short * 16 / 9), height: short };
    case 'standard': return { width: even(short * 4 / 3), height: short };
    case 'portrait': return { width: short, height: even(short * 16 / 9) };
    case 'square': return { width: short, height: short };
    case 'standardPortrait': return { width: short, height: even(short * 4 / 3) };
    default: {
      // 适应素材比例与超宽比例都以长边为准。
      const ratio = fixed || clamp(src.width / src.height, 0.2, 5);
      return ratio >= 1
        ? { width: even(long), height: even(long / ratio) }
        : { width: even(long * ratio), height: even(long) };
    }
  }
}

/// 对应 ExportEncodingPolicy.videoBitrate。
function exportVideoBitrate(width, height, frameRate) {
  const pixels = Math.max(width * height, 1);
  const ceiling = pixels >= 7_000_000 ? 130_000_000 : pixels >= 3_500_000 ? 100_000_000 : 65_000_000;
  return Math.min(Math.max(Math.floor(pixels * Math.max(frameRate, 1) / 6), 12_000_000), ceiling);
}

const EXPORT_AUDIO_BITRATE = 192_000;

module.exports = {
  clamp, even, uid: randomUUID,
  ASPECT_RATIOS, RESOLUTIONS, PATTERN_PRESETS, CAMERA_SHAPES, CLICK_EFFECTS, ZOOM_EASINGS,
  defaultCanvas, defaultCamera, defaultCursorStyle, defaultMotion, defaultAudio,
  makeProject, normalizeProject, canvasDimensions, exportVideoBitrate, EXPORT_AUDIO_BITRATE,
};
