'use strict';
// 一帧画面的几何求值：屏幕卡片、摄像头、光标。预览与导出共用同一份结果。
// 移植自 RecorderCore/CompositionScene.swift、FrameScene.swift、CursorRenderGeometry.swift。

const { clamp, CAMERA_SHAPES } = require('./model');
const { sampleZoom, viewportTransform, activeClipIndex, adjacentPreviousClip } = require('./zoom');

const CURSOR_CANONICAL_HEIGHT = 44;
const CANONICAL_SHORT_EDGE = 1080;

/// 项目里的视觉尺寸按 1080 短边设计，随输出短边等比缩放，
/// 这样留白、圆角、阴影在 1080p、4K 和任意预览尺寸下构图一致。
const canonicalStyleScale = (width, height) => Math.max(Math.min(width, height), 1) / CANONICAL_SHORT_EDGE;

function aspectFit(aspectRatio, width, height) {
  const aspect = Math.max(aspectRatio, 0.01);
  return width / Math.max(height, 1) > aspect
    ? { width: height * aspect, height }
    : { width, height: width / aspect };
}

function evaluateScreen(project, time, width, height, sourceAspect, zoomClips, pointerTrack) {
  const canvas = project.canvas;
  const scale = canonicalStyleScale(width, height);
  const padding = clamp(canvas.padding * scale, 0, Math.min(width, height) * 0.42);
  const fitted = aspectFit(sourceAspect, Math.max(width - padding * 2, 2), Math.max(height - padding * 2, 2));
  const fittedRect = { x: (width - fitted.width) / 2, y: (height - fitted.height) / 2, width: fitted.width, height: fitted.height };

  const manualScale = clamp(canvas.contentScale, 0.2, 4);
  const baseBorderWidth = clamp(canvas.borderWidth, 0, 60) * scale * manualScale;
  const scaledWidth = fittedRect.width * manualScale;
  const scaledHeight = fittedRect.height * manualScale;
  // 定位的是带外描边的完整卡片：贴边时描边仍留在画布内。
  const offsetX = (canvas.contentPosition.x - 0.5) * (width - (scaledWidth + baseBorderWidth * 2));
  const offsetY = (canvas.contentPosition.y - 0.5) * (height - (scaledHeight + baseBorderWidth * 2));
  const baseRect = {
    x: fittedRect.x + fittedRect.width / 2 - scaledWidth / 2 + offsetX,
    y: fittedRect.y + fittedRect.height / 2 - scaledHeight / 2 + offsetY,
    width: scaledWidth,
    height: scaledHeight,
  };

  // 自动缩放段的镜头跟随指针：当前段取此刻的跟随位置，相接的前一段取它结束时的位置。
  const sampleTime = Math.max(time, 0);
  let automaticFocus = null;
  let inheritedAutomaticFocus = null;
  const activeIndex = pointerTrack ? activeClipIndex(zoomClips, sampleTime) : -1;
  if (activeIndex >= 0) {
    const active = zoomClips[activeIndex];
    if (active.origin === 'automatic') automaticFocus = pointerTrack.automaticCameraFocus(sampleTime, active, project.motion);
    const previous = adjacentPreviousClip(zoomClips, activeIndex);
    if (previous && previous.origin === 'automatic') inheritedAutomaticFocus = pointerTrack.automaticCameraFocus(previous.endTime, previous, project.motion);
  }
  const zoom = sampleZoom(zoomClips, sampleTime, project.motion, automaticFocus, inheritedAutomaticFocus);
  // 素材已铺满画布时在该视口内缩放，不露出画布边缘。
  const tolerance = Math.max(width, height) * 1e-9;
  const keepsCanvasCovered = baseRect.x <= tolerance && baseRect.y <= tolerance
    && baseRect.x + baseRect.width >= width - tolerance
    && baseRect.y + baseRect.height >= height - tolerance;
  const visibleRect = keepsCanvasCovered
    ? { x: -baseRect.x / baseRect.width, y: -baseRect.y / baseRect.height, width: width / baseRect.width, height: height / baseRect.height }
    : null;
  const viewport = viewportTransform(zoom, visibleRect);
  const finalRect = {
    x: baseRect.x + baseRect.width / 2 - baseRect.width * viewport.scale / 2 + viewport.translation.x * baseRect.width,
    y: baseRect.y + baseRect.height / 2 - baseRect.height * viewport.scale / 2 + viewport.translation.y * baseRect.height,
    width: baseRect.width * viewport.scale,
    height: baseRect.height * viewport.scale,
  };
  const magnification = scale * manualScale * viewport.scale;
  return {
    baseRect,
    finalRect,
    zoom,
    viewport,
    cornerRadius: keepsCanvasCovered ? 0 : Math.max(canvas.cornerRadius, 0) * magnification,
    borderWidth: baseBorderWidth * viewport.scale,
    borderColor: canvas.borderColor,
    shadow: canvas.shadowStrength > 0 && !keepsCanvasCovered
      ? { opacity: canvas.shadowStrength, radius: 22 * magnification, offsetY: 12 * magnification }
      : null,
  };
}

function evaluateCamera(style, cameraAspect, screenZoomScale, width, height) {
  const styleScale = canonicalStyleScale(width, height);
  const base = Math.min(width, height);
  const shape = CAMERA_SHAPES[style.shape] || CAMERA_SHAPES.square;
  const aspect = shape.aspect || Math.max(cameraAspect, 0.01);
  const cornerFraction = style.shape === 'circle' ? 0.5 : 0.5 * style.roundness;

  // 屏幕放大时摄像头按 scaleDuringZoom 让位。
  const zoomProgress = clamp((screenZoomScale - 1) / 0.565, 0, 1);
  const zoomScale = 1 + (style.scaleDuringZoom - 1) * zoomProgress;
  const preferredHeight = Math.min(Math.max(base * style.size * zoomScale, 72 * styleScale), base * 1.2);
  const preferredWidth = preferredHeight * aspect;
  const fitScale = Math.min(1, width * 1.2 / Math.max(preferredWidth, 0.0001), height * 1.2 / Math.max(preferredHeight, 0.0001));
  const cameraWidth = preferredWidth * fitScale;
  const cameraHeight = preferredHeight * fitScale;
  const rect = {
    x: clamp(style.position.x, 0, 1) * (width - cameraWidth),
    y: clamp(style.position.y, 0, 1) * (height - cameraHeight),
    width: cameraWidth,
    height: cameraHeight,
  };
  return {
    rect,
    cornerRadius: Math.min(rect.width, rect.height) * clamp(cornerFraction, 0, 0.5),
    borderWidth: clamp(style.borderWidth, 0, 18) * styleScale,
    shadow: style.shadowStrength > 0
      ? { opacity: style.shadowStrength, radius: 14 * styleScale, offsetY: 8 * styleScale }
      : null,
    isMirrored: style.isMirrored,
  };
}

/// 对应 CursorRenderGeometry.clickGeometry：返回主环、副环与（聚焦微闪的）四个强调点。
function clickGeometry(style, progress, baseHeight, opacityMultiplier, scaleMultiplier) {
  if (style === 'none' || !(progress >= 0 && progress <= 1) || baseHeight <= 0) return null;
  const opacity = clamp(opacityMultiplier, 0.05, 1);
  const h = baseHeight * clamp(scaleMultiplier, 0.4, 3);
  const ring = (diameter, lineWidth, alpha, filled, glow) => ({ diameter, lineWidth, opacity: Math.max(alpha, 0), filled, glow });
  const none = ring(0, 0, 0, false, 0);
  if (style === 'ripple') {
    const e = 1 - (1 - progress) ** 3;
    const dot = progress / 0.35;
    return {
      primary: ring(h * (0.45 + 1.45 * e), Math.max(h * (0.075 - 0.04 * progress), 1.2), opacity * 0.95 * (1 - progress ** 1.3), false, h * 0.10 * (1 - progress)),
      secondary: progress < 0.35 ? ring(h * 0.28 * (1 - dot), 0, opacity * 0.85 * (1 - dot), true, h * 0.08 * (1 - dot)) : none,
    };
  }
  if (style === 'glow') {
    let diameter;
    let alpha;
    if (progress < 0.18) {
      const bloom = progress / 0.18;
      diameter = h * (0.75 + 0.50 * (1 - (1 - bloom) ** 2));
      alpha = opacity * 0.78 * bloom;
    } else {
      const fade = (progress - 0.18) / 0.82;
      diameter = h * (1.25 + 0.55 * fade);
      alpha = opacity * 0.78 * (1 - fade ** 1.4);
    }
    return { primary: ring(diameter, 0, alpha, true, h * 0.30), secondary: ring(diameter * 0.5, 0, alpha * 0.75, true, h * 0.18) };
  }
  if (style === 'pulse') {
    const e = 1 - (1 - progress) ** 2.5;
    const inner = progress / 0.55;
    return {
      primary: ring(h * (0.50 + 1.25 * e), Math.max(h * 0.065, 1.2), opacity * 0.90 * (1 - progress), false, h * 0.10 * (1 - progress)),
      secondary: progress <= 0.55
        ? ring(h * (0.25 + 0.45 * Math.sin(inner * Math.PI)), 0, opacity * 0.55 * (1 - inner), true, h * 0.12 * (1 - inner))
        : none,
    };
  }
  // burst
  const burst = 1 - (1 - progress) ** 2;
  return {
    primary: ring(Math.max(h * (0.35 - 0.18 * progress), 1), 0, opacity * 0.95 * (1 - progress ** 2), true, h * 0.14 * (1 - progress)),
    secondary: ring(h * (0.45 + 0.55 * progress), Math.max(h * 0.035, 1), opacity * 0.55 * (1 - progress), false, h * 0.08 * (1 - progress)),
    accent: { offset: h * (0.28 + 0.38 * burst), size: Math.max(h * 0.075 * (1 - progress), 1.2), opacity: Math.max(opacity * 0.85 * (1 - progress), 0) },
  };
}

function evaluateCursor(project, time, screen, width, height, pointerTrack) {
  if (!pointerTrack) return null;
  const style = project.cursorStyle;
  const sample = pointerTrack.evaluation(time + (style.timeOffset || 0), project.motion, style).cursor;
  if (!sample) return null;
  const { x, y } = sample.location;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  const shortEdge = Math.min(width, height);
  // 光标大小只跟画布短边走，不随屏幕缩放放大。
  const referenceHeight = Math.max(shortEdge * CURSOR_CANONICAL_HEIGHT / CANONICAL_SHORT_EDGE * clamp(style.size, 0.25, 6), 1);
  return {
    x: screen.finalRect.x + x * screen.finalRect.width,
    y: screen.finalRect.y + y * screen.finalRect.height,
    height: referenceHeight,
    appearance: style.appearance === 'automatic' ? sample.recordedCursor : style.appearance,
    shadow: { opacity: 0.42, radius: Math.max(referenceHeight * 1.5 / 44, 0.5), offsetY: Math.max(referenceHeight / 44, 0.5) },
    click: sample.clickPhase
      ? clickGeometry(style.clickEffectStyle, sample.clickPhase.progress, referenceHeight, style.clickOpacity, style.clickScale)
      : null,
    clickColor: style.clickColor,
  };
}

/// time 为素材时间（秒）。zoomClips 需先经过 zoom.orderedClips。
function evaluateScene(project, { time, width, height, sourceAspect, cameraAspect, zoomClips, pointerTrack }) {
  const w = Math.max(width, 2);
  const h = Math.max(height, 2);
  const screen = evaluateScreen(project, time, w, h, sourceAspect, zoomClips, pointerTrack);
  const camera = cameraAspect && !project.camera.isHidden
    ? evaluateCamera(project.camera, cameraAspect, screen.zoom.scale, w, h)
    : null;
  const cursor = evaluateCursor(project, time, screen, w, h, pointerTrack);
  return { width: w, height: h, styleScale: canonicalStyleScale(w, h), screen, camera, cursor };
}

module.exports = { canonicalStyleScale, aspectFit, evaluateScene, evaluateCamera, clickGeometry };
