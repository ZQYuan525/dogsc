'use strict';
// 光标轨迹重建：240 Hz 二阶弹簧平滑 + 点击锚定。
// 移植自 RecorderCore/PointerTrack.swift。事件结构：{ time, x, y, kind, cursor }，
// x / y 为相对采集区域的归一化坐标，kind 为 move | leftClick | rightClick。

const { clamp, CLICK_EFFECTS } = require('./model');

const MAX_CONTINUOUS_INPUT_GAP = 0.12;
const MAX_SLOW_MOVE_GAP = 0.50;
const MAX_SLOW_MOVE_DISTANCE = 0.03;
const CLICK_ANCHOR_LEAD = 0.18;
const CLICK_ANCHOR_TRAIL = 0.18;
const SPRING_INTERVAL = 1 / 240;
const JITTER_THRESHOLD = 0.00035;

const isClick = (event) => event.kind === 'leftClick' || event.kind === 'rightClick';
const isInside = (event) => event.x >= 0 && event.x <= 1 && event.y >= 0 && event.y <= 1;
const smootherStep = (value) => {
  const t = clamp(value, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/// 间隔过长说明指针曾静止：跨越静止段插值会让合成光标提前移动。
function isContinuousMovement(lower, upper) {
  const duration = upper.time - lower.time;
  if (duration <= 0) return false;
  if (duration <= MAX_CONTINUOUS_INPUT_GAP) return true;
  if (duration > MAX_SLOW_MOVE_GAP) return false;
  const dx = upper.x - lower.x;
  const dy = upper.y - lower.y;
  return dx * dx + dy * dy <= MAX_SLOW_MOVE_DISTANCE * MAX_SLOW_MOVE_DISTANCE;
}

/// 第一个 time > target 的下标。
function upperBound(times, target) {
  let lower = 0;
  let upper = times.length;
  while (lower < upper) {
    const middle = (lower + upper) >> 1;
    if (times[middle] <= target) lower = middle + 1; else upper = middle;
  }
  return lower;
}

class PointerTrack {
  constructor(events) {
    this.events = (events || [])
      .filter((e) => Number.isFinite(e.time) && Number.isFinite(e.x) && Number.isFinite(e.y))
      .map((e, index) => ({ ...e, index }))
      .sort((a, b) => a.time - b.time || a.index - b.index);
    this.eventTimes = this.events.map((e) => e.time);
    this.clicks = this.events.filter(isClick);
    this.clickTimes = this.clicks.map((e) => e.time);
    this.springKey = null;
    this.spring = null;
  }

  springSamples(motion) {
    const key = `${motion.cursorSpringMass}|${motion.cursorSpringStiffness}|${motion.cursorSpringDamping}`;
    if (this.springKey !== key) {
      this.spring = this.makeSpringSamples(motion);
      this.springKey = key;
    }
    return this.spring;
  }

  makeSpringSamples(motion) {
    const events = this.events;
    if (!events.length) return { times: [], xs: [], ys: [] };
    const first = events[0];
    const last = events[events.length - 1];
    const mass = Math.max(motion.cursorSpringMass, 0.01);
    const stiffness = Math.max(motion.cursorSpringStiffness, 0.01);
    const damping = Math.max(motion.cursorSpringDamping, 0.01);
    const settleDuration = Math.max(0.65, 6 * Math.sqrt(mass / stiffness));
    const endTime = Math.max(last.time, first.time) + settleDuration;
    const jitterSquared = JITTER_THRESHOLD * JITTER_THRESHOLD;

    let px = first.x;
    let py = first.y;
    let vx = 0;
    let vy = 0;
    let stableX = first.x;
    let stableY = first.y;
    let eventIndex = 1;
    let sampleTime = first.time;
    const times = [sampleTime];
    const xs = [px];
    const ys = [py];

    while (sampleTime < endTime) {
      const nextTime = Math.min(sampleTime + SPRING_INTERVAL, endTime);
      while (eventIndex < events.length && events[eventIndex].time <= nextTime) eventIndex += 1;
      const lower = events[Math.max(eventIndex - 1, 0)];
      let tx;
      let ty;
      if (eventIndex < events.length) {
        const upper = events[eventIndex];
        if (isContinuousMovement(lower, upper)) {
          const progress = clamp((nextTime - lower.time) / Math.max(upper.time - lower.time, Number.MIN_VALUE), 0, 1);
          tx = lower.x + (upper.x - lower.x) * progress;
          ty = lower.y + (upper.y - lower.y) * progress;
        } else {
          tx = lower.x;
          ty = lower.y;
        }
      } else {
        tx = last.x;
        ty = last.y;
      }
      // 亚像素抖动不更新目标，弹簧只追踪稳定目标。
      if ((tx - stableX) ** 2 + (ty - stableY) ** 2 >= jitterSquared) {
        stableX = tx;
        stableY = ty;
      }
      const dt = Math.max(nextTime - sampleTime, 0);
      vx += ((stiffness * (stableX - px) - damping * vx) / mass) * dt;
      vy += ((stiffness * (stableY - py) - damping * vy) / mass) * dt;
      px = clamp(px + vx * dt, 0, 1);
      py = clamp(py + vy * dt, 0, 1);
      sampleTime = nextTime;
      times.push(sampleTime);
      xs.push(px);
      ys.push(py);
    }
    return this.anchorClicks({ times, xs, ys });
  }

  /// 在每次点击附近施加一段紧凑的修正，使平滑后的路径精确经过点击位置，
  /// 相邻点击的支撑区间止于两者中点，互不拉扯。
  anchorClicks(base) {
    const clicks = this.clicks;
    if (!base.times.length || !clicks.length) return base;

    // 一次归并把点击时刻插进 240 Hz 网格。
    const times = [];
    const xs = [];
    const ys = [];
    let clickIndex = 0;
    for (let i = 0; i < base.times.length; i++) {
      while (clickIndex < clicks.length && clicks[clickIndex].time < base.times[i]) {
        const t = clicks[clickIndex].time;
        if (i > 0 && t > base.times[i - 1] && (!times.length || times[times.length - 1] !== t)) {
          const progress = (t - base.times[i - 1]) / (base.times[i] - base.times[i - 1]);
          times.push(t);
          xs.push(base.xs[i - 1] + (base.xs[i] - base.xs[i - 1]) * progress);
          ys.push(base.ys[i - 1] + (base.ys[i] - base.ys[i - 1]) * progress);
        }
        clickIndex += 1;
      }
      times.push(base.times[i]);
      xs.push(base.xs[i]);
      ys.push(base.ys[i]);
    }

    const lastTime = times[times.length - 1];
    for (let c = 0; c < clicks.length; c++) {
      const click = clicks[c];
      const anchorIndex = upperBound(times, click.time) - 1;
      if (anchorIndex < 0 || times[anchorIndex] !== click.time) continue;
      const previousTime = c > 0 ? clicks[c - 1].time : null;
      const nextTime = c + 1 < clicks.length ? clicks[c + 1].time : null;
      const supportStart = Math.max(times[0], click.time - CLICK_ANCHOR_LEAD,
        previousTime === null ? -Infinity : (previousTime + click.time) * 0.5);
      const supportEnd = Math.min(lastTime, click.time + CLICK_ANCHOR_TRAIL,
        nextTime === null ? Infinity : (click.time + nextTime) * 0.5);
      const correctionX = click.x - xs[anchorIndex];
      const correctionY = click.y - ys[anchorIndex];
      const from = upperBound(times, supportStart - 1e-12);
      const to = upperBound(times, supportEnd);
      for (let i = from; i < to; i++) {
        const t = times[i];
        let weight;
        if (t <= click.time) {
          const span = click.time - supportStart;
          weight = smootherStep(span > 0 ? (t - supportStart) / span : 1);
        } else {
          const span = supportEnd - click.time;
          weight = 1 - smootherStep(span > 0 ? (t - click.time) / span : 1);
        }
        xs[i] = clamp(xs[i] + correctionX * weight, 0, 1);
        ys[i] = clamp(ys[i] + correctionY * weight, 0, 1);
      }
      xs[anchorIndex] = click.x;
      ys[anchorIndex] = click.y;
    }
    return { times, xs, ys };
  }

  springLocation(time, motion) {
    const { times, xs, ys } = this.springSamples(motion);
    if (!times.length) return null;
    if (time <= times[0]) return { x: xs[0], y: ys[0] };
    const last = times.length - 1;
    if (time >= times[last]) return { x: xs[last], y: ys[last] };
    const upper = Math.min(upperBound(times, time), last);
    const lower = Math.max(upper - 1, 0);
    const progress = clamp((time - times[lower]) / Math.max(times[upper] - times[lower], Number.MIN_VALUE), 0, 1);
    return { x: xs[lower] + (xs[upper] - xs[lower]) * progress, y: ys[lower] + (ys[upper] - ys[lower]) * progress };
  }

  rawLocation(time) {
    const upperIndex = upperBound(this.eventTimes, time);
    const lower = this.events[Math.max(upperIndex - 1, 0)];
    const upper = this.events[upperIndex];
    if (upper && upper.time > lower.time && isContinuousMovement(lower, upper)) {
      const progress = clamp((time - lower.time) / (upper.time - lower.time), 0, 1);
      return { x: lower.x + (upper.x - lower.x) * progress, y: lower.y + (upper.y - lower.y) * progress };
    }
    return { x: lower.x, y: lower.y };
  }

  /// 不做静止判定的原始线性插值，供自动镜头使用。
  interpolatedRawPosition(time) {
    const events = this.events;
    if (!events.length) return null;
    if (time <= events[0].time) return events[0];
    const last = events[events.length - 1];
    if (time >= last.time) return last;
    const upper = Math.min(upperBound(this.eventTimes, time), events.length - 1);
    const a = events[Math.max(upper - 1, 0)];
    const b = events[upper];
    const progress = clamp((time - a.time) / Math.max(b.time - a.time, Number.MIN_VALUE), 0, 1);
    return { x: a.x + (b.x - a.x) * progress, y: a.y + (b.y - a.y) * progress };
  }

  /// 自动跟随（对应 ProjectPointerTrack.automaticCameraFocus）：点击组给出稳定的初始构图，
  /// 进入动画结束后，只有指针走出安全区才移动目标，镜头再用屏幕弹簧追过去。
  automaticCameraFocus(time, clip, motion) {
    const clamp01 = (point) => ({ x: clamp(point.x, 0, 1), y: clamp(point.y, 0, 1) });
    const base = clamp01(clip.focus);
    if (clip.origin !== 'automatic' || !Number.isFinite(time) || !(clip.endTime > clip.startTime)) return base;
    const key = [clip.id, clip.startTime, clip.endTime, clip.scale, base.x, base.y, clip.enterDuration,
      motion.screenSpringMass, motion.screenSpringStiffness, motion.screenSpringDamping].join('|');
    if (!this.cameraCache) this.cameraCache = new Map();
    let samples = this.cameraCache.get(key);
    if (!samples) {
      if (this.cameraCache.size > 24) this.cameraCache.clear();
      samples = this.makeAutomaticCameraSamples(clip, base, motion);
      this.cameraCache.set(key, samples);
    }
    const { times, xs, ys } = samples;
    const t = clamp(time, clip.startTime, clip.endTime);
    const last = times.length - 1;
    if (t <= times[0]) return { x: xs[0], y: ys[0] };
    if (t >= times[last]) return { x: xs[last], y: ys[last] };
    const upper = Math.min(upperBound(times, t), last);
    const lower = Math.max(upper - 1, 0);
    const progress = clamp((t - times[lower]) / Math.max(times[upper] - times[lower], Number.MIN_VALUE), 0, 1);
    return { x: xs[lower] + (xs[upper] - xs[lower]) * progress, y: ys[lower] + (ys[upper] - ys[lower]) * progress };
  }

  makeAutomaticCameraSamples(clip, fallback, motion) {
    const interval = 1 / 120;
    const duration = clip.endTime - clip.startTime;
    const followStart = Math.min(clip.startTime + clamp(clip.enterDuration, 0, duration), clip.endTime);
    // 进入窗口内的第一次点击就是触发这次缩放的操作，镜头提前对准它。
    const entryClick = this.clicks.find((click) => click.time >= clip.startTime && click.time <= followStart);
    const entry = entryClick || this.interpolatedRawPosition(clip.startTime) || fallback;
    const visibleHalfSpan = 1 / (2 * Math.max(clip.scale, 1));
    const restAreaHalfSpan = Math.max(visibleHalfSpan - 2 * visibleHalfSpan * 0.22, 0.01);
    const mass = Math.max(motion.screenSpringMass, 0.01);
    const stiffness = Math.max(motion.screenSpringStiffness, 0.01);
    const damping = Math.max(motion.screenSpringDamping, 0.01);

    let px = clamp(entry.x, 0, 1);
    let py = clamp(entry.y, 0, 1);
    let tx = px;
    let ty = py;
    let vx = 0;
    let vy = 0;
    let sampleTime = clip.startTime;
    const times = [sampleTime];
    const xs = [px];
    const ys = [py];
    while (sampleTime < clip.endTime) {
      const nextTime = Math.min(sampleTime + interval, clip.endTime);
      const cursor = nextTime >= followStart ? this.interpolatedRawPosition(nextTime) : null;
      if (cursor) {
        if (cursor.x < tx - restAreaHalfSpan || cursor.x > tx + restAreaHalfSpan) tx = clamp(cursor.x, 0, 1);
        if (cursor.y < ty - restAreaHalfSpan || cursor.y > ty + restAreaHalfSpan) ty = clamp(cursor.y, 0, 1);
      }
      const dt = Math.max(nextTime - sampleTime, 0);
      vx += ((stiffness * (tx - px) - damping * vx) / mass) * dt;
      vy += ((stiffness * (ty - py) - damping * vy) / mass) * dt;
      px = clamp(px + vx * dt, 0, 1);
      py = clamp(py + vy * dt, 0, 1);
      sampleTime = nextTime;
      times.push(sampleTime);
      xs.push(px);
      ys.push(py);
    }
    return { times, xs, ys };
  }

  mostRecentClick(from, through) {
    const index = upperBound(this.clickTimes, through) - 1;
    if (index < 0) return null;
    const click = this.clicks[index];
    return click.time >= from ? click : null;
  }

  /// 对应 PointerTrack.evaluation：position 与光标是否可见无关（隐藏光标不影响镜头）。
  evaluation(time, motion, style) {
    if (!this.events.length || time < this.events[0].time) return { position: null, cursor: null };
    const lowerIndex = Math.max(upperBound(this.eventTimes, time) - 1, 0);
    const lower = this.events[lowerIndex];
    const position = motion.cursor === 'smooth'
      ? (this.springLocation(time, motion) || { x: lower.x, y: lower.y })
      : this.rawLocation(time);
    // 区域／窗口录制时指针可能移出采集范围：此时不画光标，而不是让它贴在边缘。
    const visible = style.appearance !== 'hidden'
      && isInside(lower)
      && (!style.hideWhenIdle || time - lower.time <= style.idleDelay);
    if (!visible) return { position, cursor: null };

    let clickPhase = null;
    const effect = CLICK_EFFECTS[style.clickEffectStyle];
    if (effect && effect.duration > 0) {
      const click = this.mostRecentClick(time - effect.duration, time);
      if (click) {
        const elapsed = Math.max(time - click.time, 0);
        clickPhase = { progress: clamp(elapsed / effect.duration, 0, 1), elapsed, duration: effect.duration, kind: click.kind };
      }
    }
    return { position, cursor: { location: position, clickPhase, recordedCursor: lower.cursor || 'arrow' } };
  }
}

module.exports = { PointerTrack, isContinuousMovement, isInside };
