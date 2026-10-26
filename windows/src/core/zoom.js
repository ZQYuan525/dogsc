'use strict';
// 缩放动画：自动规划 + 插值 + 视口变换。
// 移植自 RecorderCore/AutoZoomPlanner.swift 与 ZoomAnimation.swift，常量保持一致。

const { clamp, uid } = require('./model');

const ADJACENCY_TOLERANCE = 1 / 120;
const FOCUS_EDGE_INSET = 0;
const FRAMING_TARGET_INSET = 0.30;
const CENTER = { x: 0.5, y: 0.5 };

const CURVES = {
  linear: { x1: 0, y1: 0, x2: 1, y2: 1 },
  quadratic: { x1: 0.45, y1: 0, x2: 0.55, y2: 1 },
  cubic: { x1: 0.65, y1: 0, x2: 0.35, y2: 1 },
  quintic: { x1: 0.82, y1: 0, x2: 0.18, y2: 1 },
};

function constrained(point, safeInset) {
  const inset = clamp(safeInset, 0, 0.5);
  return { x: clamp(point.x, inset, 1 - inset), y: clamp(point.y, inset, 1 - inset) };
}

function bezierPoint(curve, parameter) {
  const t = clamp(parameter, 0, 1);
  const inv = 1 - t;
  return {
    x: 3 * inv * inv * t * curve.x1 + 3 * inv * t * t * curve.x2 + t * t * t,
    y: 3 * inv * inv * t * curve.y1 + 3 * inv * t * t * curve.y2 + t * t * t,
  };
}

/// 给定归一化时间 X 求曲线 Y：牛顿迭代为主，二分兜底。
function bezierValue(curve, normalizedTime) {
  const targetX = clamp(normalizedTime, 0, 1);
  if (targetX <= 0 || targetX >= 1) return targetX;
  let parameter = targetX;
  for (let i = 0; i < 7; i++) {
    const point = bezierPoint(curve, parameter);
    const error = point.x - targetX;
    if (Math.abs(error) < 0.00001) return point.y;
    const t = parameter;
    const inv = 1 - t;
    const derivative = 3 * inv * inv * curve.x1 + 6 * inv * t * (curve.x2 - curve.x1) + 3 * t * t * (1 - curve.x2);
    if (Math.abs(derivative) < 0.00001) break;
    const next = parameter - error / derivative;
    if (next < 0 || next > 1) break;
    parameter = next;
  }
  let lower = 0;
  let upper = 1;
  parameter = targetX;
  for (let i = 0; i < 18; i++) {
    const point = bezierPoint(curve, parameter);
    if (Math.abs(point.x - targetX) < 0.00001) return point.y;
    if (point.x < targetX) lower = parameter; else upper = parameter;
    parameter = (lower + upper) / 2;
  }
  return bezierPoint(curve, parameter).y;
}

/// 归一化欠阻尼弹簧，端点严格落在 0 / 1。
function springProgress(value, mass, stiffness, damping) {
  const t = clamp(value, 0, 1);
  if (t <= 0 || t >= 1) return t;
  const m = Math.max(mass, 0.01);
  const k = Math.max(stiffness, 0.01);
  const c = Math.max(damping, 0.01);
  const omega0 = Math.sqrt(k / m);
  const zeta = Math.min(c / (2 * Math.sqrt(k * m)), 0.9999);
  const omegaD = omega0 * Math.sqrt(Math.max(1 - zeta * zeta, Number.MIN_VALUE));
  const duration = 0.72;
  const response = (seconds) => {
    const envelope = Math.exp(-zeta * omega0 * seconds);
    return 1 - envelope * (Math.cos(omegaD * seconds) + (zeta * omega0 / omegaD) * Math.sin(omegaD * seconds));
  };
  return clamp(response(t * duration) / response(duration), 0, 1);
}

function easedProgress(value, preset, motion) {
  const t = clamp(value, 0, 1);
  if (preset === 'spring') {
    return springProgress(t, motion.screenSpringMass, motion.screenSpringStiffness, motion.screenSpringDamping);
  }
  return bezierValue(CURVES[preset] || CURVES.cubic, t);
}

function makeClip(options) {
  const startTime = Math.max(options.startTime, 0);
  return {
    id: options.id || uid(),
    startTime,
    endTime: Math.max(options.endTime, startTime),
    scale: Math.max(options.scale ?? 1.6, 1),
    focus: constrained(options.focus || CENTER, FOCUS_EDGE_INSET),
    origin: options.origin || 'manual',
    easing: options.easing || 'cubic',
    enterDuration: clamp(options.enterDuration ?? 0.7, 0, 5),
    exitDuration: clamp(options.exitDuration ?? 0.7, 0, 5),
  };
}

const clipDuration = (clip) => Math.max(clip.endTime - clip.startTime, 0);
const effectEndTime = (clip) => clip.endTime + clip.exitDuration;

function orderedClips(clips) {
  return clips
    .filter((clip) => clipDuration(clip) > 0.001)
    .sort((a, b) => (a.startTime === b.startTime ? (a.id < b.id ? -1 : 1) : a.startTime - b.startTime));
}

/// last-active-wins：起点不晚于 time 且仍在效果区间内的最后一段。
function activeClipIndex(ordered, time) {
  if (!Number.isFinite(time)) return -1;
  for (let index = ordered.length - 1; index >= 0; index--) {
    const clip = ordered[index];
    if (clip.startTime <= time && time <= effectEndTime(clip)) return index;
  }
  return -1;
}

const lerp = (from, to, progress) => from + (to - from) * progress;

function adjacentPreviousClip(ordered, index) {
  const previous = index > 0 ? ordered[index - 1] : null;
  return previous && Math.abs(previous.endTime - ordered[index].startTime) <= ADJACENCY_TOLERANCE ? previous : null;
}

/// 对应 ZoomInterpolator.sample。`ordered` 需先经过 orderedClips。
/// automaticFocus / inheritedAutomaticFocus：自动缩放段的跟随镜头位置（由指针轨迹给出），
/// 分别对应当前段与它相接的前一段；不提供时使用片段自身的焦点。
function sampleZoom(ordered, time, motion, automaticFocus = null, inheritedAutomaticFocus = null) {
  const index = activeClipIndex(ordered, time);
  if (index < 0) return { scale: 1, focus: CENTER, framingProgress: 0, targetScale: 1 };
  const clip = ordered[index];
  const focusOf = (target, followed) => constrained(target.origin === 'automatic' && followed ? followed : target.focus, FOCUS_EDGE_INSET);
  const targetFocus = focusOf(clip, automaticFocus);

  // 相接的两段视为一次连续运镜：后一段从前一段保持的状态出发。
  const adjacent = adjacentPreviousClip(ordered, index);
  const inherited = adjacent
    ? { scale: adjacent.scale, focus: focusOf(adjacent, inheritedAutomaticFocus) }
    : null;

  const requestedEnter = inherited && clip.enterDuration <= 0.001
    ? motion.defaultZoomTransitionDuration
    : clip.enterDuration;
  const enter = Math.min(requestedEnter, clipDuration(clip));
  let progress;
  if (enter > 0.001 && time < clip.startTime + enter) {
    progress = easedProgress((time - clip.startTime) / enter, clip.easing, motion);
  } else if (time <= clip.endTime) {
    progress = 1; // 时间线上的片段代表聚焦保持区间，退出只在尾部之后开始
  } else if (clip.exitDuration > 0.001) {
    progress = 1 - easedProgress((time - clip.endTime) / clip.exitDuration, clip.easing, motion);
  } else {
    progress = 0;
  }

  if (inherited && time <= clip.endTime) {
    const scale = lerp(inherited.scale, clip.scale, progress);
    return {
      scale,
      focus: { x: lerp(inherited.focus.x, targetFocus.x, progress), y: lerp(inherited.focus.y, targetFocus.y, progress) },
      framingProgress: 1,
      targetScale: scale,
      manualTransition: clip.origin === 'manual'
        ? { fromScale: inherited.scale, fromFocus: inherited.focus, toScale: clip.scale, toFocus: clip.focus, progress }
        : null,
    };
  }
  // 进入、保持、退出全程使用同一个锚点，避免"先居中再滑动"。
  return { scale: lerp(1, clip.scale, progress), focus: targetFocus, framingProgress: progress, targetScale: clip.scale };
}

/// 对应 ZoomViewportTransform.make（未移植裁切，crop 恒为全幅）。
/// 返回 { scale, translation }，translation 以屏幕卡片宽高为单位。
function viewportTransform(sample, visibleRect) {
  if (sample.manualTransition) {
    const transition = sample.manualTransition;
    const from = viewportTransform({ scale: transition.fromScale, focus: transition.fromFocus, framingProgress: 1 }, visibleRect);
    const to = viewportTransform({ scale: transition.toScale, focus: transition.toFocus, framingProgress: 1 }, visibleRect);
    const progress = clamp(transition.progress, 0, 1);
    return {
      scale: lerp(from.scale, to.scale, progress),
      translation: { x: lerp(from.translation.x, to.translation.x, progress), y: lerp(from.translation.y, to.translation.y, progress) },
    };
  }
  const scale = clamp(sample.scale, 1, 6);
  const localFocus = constrained({ x: clamp(sample.focus.x, 0, 1), y: clamp(sample.focus.y, 0, 1) }, FOCUS_EDGE_INSET);
  const destination = constrained(localFocus, FRAMING_TARGET_INSET);
  const progress = clamp(sample.framingProgress, 0, 1);
  const desired = { x: lerp(localFocus.x, destination.x, progress), y: lerp(localFocus.y, destination.y, progress) };
  const scaled = { x: 0.5 + scale * (localFocus.x - 0.5), y: 0.5 + scale * (localFocus.y - 0.5) };
  let translation = { x: desired.x - scaled.x, y: desired.y - scaled.y };
  if (visibleRect) {
    // 素材已铺满画布时，缩放不能把画布边缘露出来。
    translation = {
      x: Math.min(Math.max(translation.x, visibleRect.x + visibleRect.width - 0.5 - scale / 2), visibleRect.x - 0.5 + scale / 2),
      y: Math.min(Math.max(translation.y, visibleRect.y + visibleRect.height - 0.5 - scale / 2), visibleRect.y - 0.5 + scale / 2),
    };
  }
  return { scale, translation };
}

// ---------------------------------------------------------------- 自动规划

function orderedValidClicks(clicks) {
  return clicks.filter((c) => Number.isFinite(c.time) && c.time >= 0).sort((a, b) => a.time - b.time);
}

function spatialFocusGroups(clicks, maximumSpanX, maximumSpanY) {
  const groups = [];
  for (const click of clicks) {
    const last = groups[groups.length - 1];
    if (last
      && Math.max(last.maxX, click.x) - Math.min(last.minX, click.x) <= maximumSpanX
      && Math.max(last.maxY, click.y) - Math.min(last.minY, click.y) <= maximumSpanY) {
      last.minX = Math.min(last.minX, click.x); last.maxX = Math.max(last.maxX, click.x);
      last.minY = Math.min(last.minY, click.y); last.maxY = Math.max(last.maxY, click.y);
    } else {
      groups.push({ firstTime: click.time, minX: click.x, maxX: click.x, minY: click.y, maxY: click.y });
    }
  }
  return groups;
}

function planFromClicks(clicks, { zoomScale, enterDuration, exitDuration, easing }) {
  const holdDuration = 0.9;
  const clickGroupGap = 1.4;
  const safeInset = 0.12;
  const ordered = orderedValidClicks(clicks);
  const temporalGroups = [];
  for (const click of ordered) {
    const group = temporalGroups[temporalGroups.length - 1];
    if (group && click.time - group[group.length - 1].time <= clickGroupGap) group.push(click);
    else temporalGroups.push([click]);
  }

  const animations = [];
  let earliestNextStart = 0;
  for (const group of temporalGroups) {
    const first = group[0];
    const last = group[group.length - 1];
    // 相邻点击共用一个镜头区域：只有累计点击范围放不进缩放视口时才换区域。
    const visibleExtent = 1 / Math.max(zoomScale, 1);
    const focusGroups = spatialFocusGroups(group, visibleExtent * 0.50, visibleExtent * 0.70);
    if (!focusGroups.length) continue;
    const starts = [Math.max(first.time - enterDuration * 0.18, earliestNextStart, 0)];
    for (let i = 1; i < focusGroups.length; i++) {
      starts.push(Math.max(focusGroups[i].firstTime - enterDuration, starts[starts.length - 1] + 0.16));
    }
    for (let i = 0; i < focusGroups.length; i++) {
      const start = starts[i];
      const isLast = i === focusGroups.length - 1;
      const end = isLast ? Math.max(last.time + holdDuration, start + enterDuration) : starts[i + 1];
      if (end - start <= 0.01) continue;
      const g = focusGroups[i];
      animations.push(makeClip({
        startTime: start,
        endTime: end,
        scale: zoomScale,
        focus: constrained({ x: (g.minX + g.maxX) / 2, y: (g.minY + g.maxY) / 2 }, safeInset),
        origin: 'automatic',
        easing,
        enterDuration,
        exitDuration: isLast ? exitDuration : 0,
      }));
    }
    earliestNextStart = animations.length ? effectEndTime(animations[animations.length - 1]) : last.time;
  }
  return animations;
}

/// 点击启动自动镜头，但何时离开由指针活动决定：活动连续时保持，停下后再留一小段。
function extendHoldsThroughPointerActivity(planned, clicks, pointerEvents) {
  const activityIdleGap = 1.4;
  const settleHold = 0.55;
  if (!planned.length || !clicks.length) return planned;
  const events = pointerEvents.filter((e) => e.time >= 0).sort((a, b) => a.time - b.time);
  const orderedClicks = orderedValidClicks(clicks);
  const result = planned.map((clip) => ({ ...clip }));
  for (let index = 0; index < result.length; index++) {
    const clip = result[index];
    if (clip.exitDuration <= 0.001) continue;
    let lastClick = null;
    for (const click of orderedClicks) {
      if (click.time <= clip.endTime + 0.0001) lastClick = click; else break;
    }
    if (!lastClick || lastClick.time < clip.startTime - 0.0001) continue;
    const nextStart = index + 1 < result.length ? result[index + 1].startTime : Infinity;
    let previousActivityTime = lastClick.time;
    let activityEndTime = lastClick.time;
    for (const event of events) {
      if (event.time <= lastClick.time) continue;
      if (event.time >= nextStart - 0.0001) break;
      if (event.time - previousActivityTime > activityIdleGap) break;
      previousActivityTime = event.time;
      activityEndTime = event.time;
    }
    if (activityEndTime <= lastClick.time + 0.0001) continue;
    const extendedEnd = Math.min(Math.max(clip.endTime, activityEndTime + settleHold), nextStart);
    if (extendedEnd <= clip.endTime + 0.0001) continue;
    clip.endTime = extendedEnd;
    if (Number.isFinite(nextStart)) {
      clip.exitDuration = Math.min(clip.exitDuration, Math.max(nextStart - extendedEnd, 0));
    }
  }
  return result;
}

/// 一次连续的交互只保留一段缩放包络，避免每段都从零速度重新缓动。
function mergeConnectedAutomaticEnvelopes(animations) {
  const result = [];
  for (const animation of orderedClips(animations)) {
    const previous = result[result.length - 1];
    if (previous
      && previous.origin === 'automatic' && animation.origin === 'automatic'
      && previous.exitDuration <= ADJACENCY_TOLERANCE
      && Math.abs(previous.endTime - animation.startTime) <= ADJACENCY_TOLERANCE
      && Math.abs(previous.scale - animation.scale) <= 0.000001
      && previous.easing === animation.easing) {
      previous.endTime = Math.max(previous.endTime, animation.endTime);
      previous.exitDuration = animation.exitDuration;
    } else {
      result.push({ ...animation });
    }
  }
  return result;
}

function clipAnimationsTo(animations, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const result = [];
  for (const animation of animations) {
    if (animation.startTime >= duration) continue;
    const clipped = { ...animation, endTime: Math.min(animation.endTime, duration) };
    clipped.exitDuration = Math.min(animation.exitDuration, Math.max(duration - clipped.endTime, 0));
    if (clipped.endTime - clipped.startTime > 0.01) result.push(clipped);
  }
  return result;
}

/// 对应 AutoZoomPlanner.makeAnimations(for pointerEvents:)。
function planAutoZoom(pointerEvents, { zoomScale = 1.6, easing = 'spring', transitionDuration = 0.7, duration } = {}) {
  const clicks = pointerEvents.filter((e) => e.kind === 'leftClick' || e.kind === 'rightClick');
  const transition = clamp(transitionDuration, 0, 5);
  const planned = planFromClicks(clicks, { zoomScale, enterDuration: transition, exitDuration: transition, easing });
  const merged = mergeConnectedAutomaticEnvelopes(extendHoldsThroughPointerActivity(planned, clicks, pointerEvents));
  return duration ? clipAnimationsTo(merged, duration) : merged;
}

module.exports = {
  ADJACENCY_TOLERANCE, FRAMING_TARGET_INSET, CENTER,
  constrained, bezierValue, springProgress, easedProgress,
  makeClip, clipDuration, effectEndTime, orderedClips, activeClipIndex, adjacentPreviousClip,
  sampleZoom, viewportTransform, planAutoZoom, clipAnimationsTo,
};
