'use strict';
// 主轨剪辑：片段是素材时间区间 [sourceStart, sourceEnd) 加播放速度，按素材顺序排列。
// 缩放、光标、标记都以素材时间保存，剪切后自动跟随所在画面。

const { clamp, uid } = require('./model');

const MIN_SEGMENT = 0.1;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

const segmentOutputDuration = (segment) => (segment.sourceEnd - segment.sourceStart) / segment.speed;
const outputDuration = (segments) => segments.reduce((sum, segment) => sum + segmentOutputDuration(segment), 0);

/// 输出时间 → 所在片段与素材时间。超出末尾时停在最后一帧。
function locate(segments, outputTime) {
  let start = 0;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const duration = segmentOutputDuration(segment);
    if (outputTime < start + duration || index === segments.length - 1) {
      const local = clamp(outputTime - start, 0, duration);
      return { index, segment, outputStart: start, sourceTime: segment.sourceStart + local * segment.speed };
    }
    start += duration;
  }
  return null;
}

/// 素材时间 → 输出时间。落在被剪掉的区间时，吸附到其后第一段的起点。
function sourceToOutput(segments, sourceTime) {
  let start = 0;
  for (const segment of segments) {
    if (sourceTime < segment.sourceStart) return start;
    if (sourceTime <= segment.sourceEnd) return start + (sourceTime - segment.sourceStart) / segment.speed;
    start += segmentOutputDuration(segment);
  }
  return start;
}

const isRetained = (segments, sourceTime) =>
  segments.some((segment) => sourceTime >= segment.sourceStart && sourceTime <= segment.sourceEnd);

function splitAt(segments, outputTime) {
  const hit = locate(segments, outputTime);
  if (!hit) return null;
  const { index, segment, sourceTime } = hit;
  if (sourceTime - segment.sourceStart < MIN_SEGMENT || segment.sourceEnd - sourceTime < MIN_SEGMENT) return null;
  const next = segments.slice();
  next.splice(index, 1,
    { ...segment, sourceEnd: sourceTime },
    { ...segment, id: uid(), sourceStart: sourceTime });
  return next;
}

function removeSegment(segments, id) {
  if (segments.length <= 1) return null;
  const next = segments.filter((segment) => segment.id !== id);
  return next.length === segments.length ? null : next;
}

/// 拖动片段边缘裁短／恢复：不越过相邻片段，也不超出素材。
function trimSegment(segments, id, edge, sourceTime, mediaDuration) {
  const index = segments.findIndex((segment) => segment.id === id);
  if (index < 0) return null;
  const segment = segments[index];
  const next = segments.slice();
  if (edge === 'start') {
    const lower = index > 0 ? segments[index - 1].sourceEnd : 0;
    next[index] = { ...segment, sourceStart: clamp(sourceTime, lower, segment.sourceEnd - MIN_SEGMENT) };
  } else {
    const upper = index + 1 < segments.length ? segments[index + 1].sourceStart : mediaDuration;
    next[index] = { ...segment, sourceEnd: clamp(sourceTime, segment.sourceStart + MIN_SEGMENT, upper) };
  }
  return next;
}

function setSpeed(segments, id, speed) {
  return segments.map((segment) => (segment.id === id ? { ...segment, speed: clamp(speed, 0.25, 8) } : segment));
}

module.exports = {
  MIN_SEGMENT, SPEEDS,
  segmentOutputDuration, outputDuration, locate, sourceToOutput, isRetained,
  splitAt, removeSegment, trimSegment, setSpeed,
};
