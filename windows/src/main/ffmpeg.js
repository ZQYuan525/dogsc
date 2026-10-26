'use strict';
// ffmpeg / ffprobe 封装：屏幕采集、编码器探测、素材整理、导出混流。
// macOS 版用 ScreenCaptureKit + AVFoundation，这里换成 ffmpeg 的 ddagrab（Desktop Duplication，
// 恒定帧率）。显示器、区域、窗口三种来源都走它：窗口录制是把窗口切到前台后按其可见边界采集。
// 没有用 gfxcapture（Windows.Graphics.Capture）：它只在窗口内容变化时出帧，窗口静止时
// 停止命令会一直等不到下一帧，实测会卡住并丢掉已录内容。
// 采集时关闭系统光标绘制，光标由后期按记录的轨迹重新合成。

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { exportVideoBitrate, EXPORT_AUDIO_BITRATE } = require('../core/model');

let binaries = null;

function resolveBinaries(resourcesPath) {
  if (binaries) return binaries;
  const bundled = resourcesPath ? path.join(resourcesPath, 'bin') : null;
  const pick = (name) => (bundled && fs.existsSync(path.join(bundled, `${name}.exe`)) ? path.join(bundled, `${name}.exe`) : name);
  binaries = { ffmpeg: pick('ffmpeg'), ffprobe: pick('ffprobe') };
  return binaries;
}

function run(binary, args, { onStderr, onSpawn } = {}) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    if (onSpawn) onSpawn(child);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr = (stderr + text).slice(-20000);
      if (onStderr) onStderr(text);
    });
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: String(error) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function ffmpeg(args, options) {
  const result = await run(binaries.ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], options);
  if (result.code !== 0) {
    const error = new Error(`ffmpeg 失败（${result.code}）：${result.stderr.trim().split(/\r?\n/).slice(-4).join(' / ')}`);
    error.stderr = result.stderr;
    throw error;
  }
  return result;
}

async function checkAvailable() {
  const result = await run(binaries.ffmpeg, ['-hide_banner', '-filters']);
  if (result.code !== 0) return { ok: false, reason: '没有找到 ffmpeg。请先安装（winget install Gyan.FFmpeg）并重新打开 DogSC。' };
  const has = (name) => new RegExp(`\\s${name}\\s`).test(result.stdout);
  if (!has('ddagrab')) return { ok: false, reason: '当前 ffmpeg 不带 ddagrab 采集滤镜，请换用 6.0 以上的完整版。' };
  return { ok: true };
}

// 屏幕是 RGB，H.264 是 YUV。转换矩阵与码流标记必须一致，否则播放端按另一套矩阵解码会偏色。
// 这里统一在 CPU 端按 BT.709 窄范围转换，再用 h264_metadata 把同样的标记写进 SPS。
const COLOR_FILTER = 'scale=out_color_matrix=bt709:out_range=tv';
const COLOR_TAGS = ['-bsf:v', 'h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0'];

// 编码器候选列表：libx264（软件编码）作为最终兜底，任何硬件编码器探测通过但录制失败时都会自动回退到它。
// 注意：h264_mf（Media Foundation 的 Intel Quick Sync 接口）在 ffmpeg 9.x 已移除，且旧版中该接口在部分
// 机器上探测通过但实际录制失败（报 "没有录到画面"），因此改用 Intel QSV 原生接口 h264_qsv。
const ENCODERS = [
  { name: 'h264_nvenc', label: 'NVIDIA NVENC', format: 'nv12', args: (bitrate) => ['-c:v', 'h264_nvenc', '-preset', 'default', '-rc', 'vbr', '-b:v', String(bitrate), '-maxrate', String(bitrate * 2)] },
  { name: 'h264_qsv', label: 'Intel QSV（Quick Sync）', format: 'nv12', args: (bitrate) => ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-b:v', String(bitrate)] },
  { name: 'h264_amf', label: 'AMD AMF', format: 'nv12', args: (bitrate) => ['-c:v', 'h264_amf', '-b:v', String(bitrate)] },
  { name: 'libx264', label: '软件编码（x264）', format: 'yuv420p', args: () => ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '17'] },
];

let encoderCandidates = null;
let chosenEncoder = null;

/// 逐个试编 10 帧，返回本机真正可用的编码器候选列表（按 ENCODERS 顺序；
/// 驱动过旧或缺失时 NVENC/AMF 会在这里被跳过）。结果缓存，录制回退时直接复用。
async function detectEncoders() {
  if (encoderCandidates) return encoderCandidates;
  const available = [];
  for (const encoder of ENCODERS) {
    const result = await run(binaries.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=1280x720:r=30',
      '-frames:v', '10', '-vf', `format=${encoder.format}`, ...encoder.args(8_000_000), '-f', 'null', '-',
    ]);
    if (result.code === 0) available.push(encoder);
  }
  encoderCandidates = available;
  return available;
}

/// 取第一个本机可用的编码器（探测通过列表中排序最前）。
async function detectEncoder() {
  if (chosenEncoder) return chosenEncoder;
  const list = await detectEncoders();
  if (!list.length) throw new Error('没有可用的 H.264 编码器');
  chosenEncoder = list[0];
  return chosenEncoder;
}

function captureFilter(source, fps) {
  let filter = `ddagrab=output_idx=${source.outputIndex}:draw_mouse=0:framerate=${fps}`;
  if (source.kind === 'area') {
    filter += `:video_size=${source.rect.width}x${source.rect.height}:offset_x=${source.rect.x}:offset_y=${source.rect.y}`;
  }
  return filter;
}

/// 用指定编码器启动采集进程。返回 capture 对象；firstFrame 在首帧到达时给出系统时钟（秒），
/// 进程在首帧前退出或启动失败时 firstFrame 会 reject。
function spawnCapture(encoder, source, fps, file, bitrate) {
  // setpts 里的 print(time(0)) 只在第 0 帧执行一次，把首帧系统时钟打到 stderr，PTS 本身不变。
  const graph = `${captureFilter(source, fps)},setpts='PTS+0*if(eq(N,0),print(time(0)),0)',hwdownload,format=bgra,${COLOR_FILTER},format=${encoder.format}`;
  const args = [
    '-hide_banner', '-loglevel', 'info', '-nostats', '-y',
    '-filter_complex', graph,
    ...encoder.args(bitrate), '-g', String(fps), ...COLOR_TAGS,
    '-f', 'matroska', file,
  ];
  const child = spawn(binaries.ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  let exited = false;
  let resolveFirst;
  let rejectFirst;
  const firstFrame = new Promise((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
  firstFrame.catch(() => {});
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-20000);
    const match = /\[Eval @ [^\]]+\]\s+(\d+\.\d+)/.exec(stderr);
    if (match) resolveFirst(Number(match[1]));
  });
  const closed = new Promise((resolve) => child.on('close', (code) => {
    exited = true;
    rejectFirst(new Error(`屏幕采集没有启动：${stderr.trim().split(/\r?\n/).slice(-3).join(' / ')}`));
    resolve(code);
  }));
  child.on('error', (error) => rejectFirst(error));
  return {
    encoder,
    firstFrame,
    closed,
    get stderr() { return stderr; },
    async stop() {
      if (!exited) {
        try { child.stdin.write('q'); } catch { /* 进程已退出 */ }
        const timer = setTimeout(() => child.kill(), 8000);
        await closed;
        clearTimeout(timer);
      }
    },
  };
}

/// 开始采集。按本机可用编码器候选依次尝试：某个编码器启动后首帧失败（进程退出或 8 秒内没有出帧），
/// 自动清理并回退到下一个候选（最终兜底 libx264），避免因单个硬件编码器（如旧版 Media Foundation 的
/// Intel Quick Sync 接口）探测通过但实际不可用导致"没有录到画面"。
async function startCapture({ source, fps, file, width, height }) {
  const bitrate = exportVideoBitrate(width, height, fps);
  const candidates = await detectEncoders();
  let lastError = null;
  for (let index = 0; index < candidates.length; index++) {
    const capture = spawnCapture(candidates[index], source, fps, file, bitrate);
    try {
      await Promise.race([
        capture.firstFrame,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`编码器 ${capture.encoder.label} 启动超时（8 秒内未采集到首帧）`)), 8000)),
      ]);
      return capture;
    } catch (error) {
      lastError = error;
      await capture.stop();
      if (index < candidates.length - 1) {
        console.error(`[DogSC] 编码器 ${capture.encoder.label} 启动失败，自动回退到下一个编码器：${error.message}`);
      }
    }
  }
  throw lastError || new Error('没有可用的 H.264 编码器');
}

async function probe(file) {
  const result = await run(binaries.ffprobe, ['-v', 'error', '-show_entries',
    'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,duration', '-of', 'json', file]);
  if (result.code !== 0) throw new Error(`无法读取素材：${path.basename(file)}`);
  const info = JSON.parse(result.stdout);
  const video = (info.streams || []).find((stream) => stream.codec_type === 'video');
  const audio = (info.streams || []).find((stream) => stream.codec_type === 'audio');
  const rate = video && video.avg_frame_rate ? video.avg_frame_rate.split('/').map(Number) : null;
  return {
    duration: Number(info.format && info.format.duration) || 0,
    video: video ? { codec: video.codec_name, width: video.width, height: video.height, fps: rate && rate[1] ? rate[0] / rate[1] : 0 } : null,
    hasAudio: Boolean(audio),
  };
}

/// MP4 里 avcC 盒的内容，即 WebCodecs VideoDecoder 需要的 description。
function readAvcConfiguration(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const header = Buffer.alloc(16);
    let offset = 0;
    while (offset + 8 <= size) {
      fs.readSync(fd, header, 0, 16, offset);
      let boxSize = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      if (boxSize === 1) boxSize = Number(header.readBigUInt64BE(8));
      if (boxSize < 8) break;
      if (type === 'moov') {
        const moov = Buffer.alloc(boxSize);
        fs.readSync(fd, moov, 0, boxSize, offset);
        const at = moov.indexOf('avcC', 0, 'latin1');
        if (at < 4) return null;
        return moov.subarray(at + 4, at - 4 + moov.readUInt32BE(at - 4));
      }
      offset += boxSize;
    }
  } finally {
    fs.closeSync(fd);
  }
  return null;
}

/// 逐包索引（文件偏移、大小、时间戳、是否关键帧），导出时据此顺序解码，不必整段读入内存。
async function buildVideoIndex(file) {
  const result = await run(binaries.ffprobe, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time,dts_time,size,pos,flags', '-of', 'csv=p=0:nk=0', file]);
  if (result.code !== 0) throw new Error(`无法建立索引：${path.basename(file)}`);
  const packets = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const fields = Object.fromEntries(line.split(',').map((pair) => pair.split('=')));
    const pts = Number(fields.pts_time);
    if (!Number.isFinite(pts)) continue;
    const dts = Number(fields.dts_time);
    packets.push([Number(fields.pos), Number(fields.size), pts, Number.isFinite(dts) ? dts : pts, (fields.flags || '').includes('K') ? 1 : 0]);
  }
  packets.sort((a, b) => a[3] - b[3] || a[0] - b[0]);
  const description = readAvcConfiguration(file);
  if (!description || !packets.length) throw new Error(`素材不是可索引的 H.264 MP4：${path.basename(file)}`);
  const info = await probe(file);
  const hex = (byte) => byte.toString(16).padStart(2, '0');
  return {
    codec: `avc1.${hex(description[1])}${hex(description[2])}${hex(description[3])}`,
    description: description.toString('base64'),
    width: info.video.width,
    height: info.video.height,
    duration: info.duration,
    packets,
  };
}

const remuxToMp4 = (input, output) => ffmpeg(['-loglevel', 'error', '-i', input, '-map', '0:v:0', '-c', 'copy', '-movflags', '+faststart', output]);

/// 摄像头录像（浏览器 MediaRecorder 产物）整理成可索引的 H.264 MP4；已是 H.264 时直接换封装。
async function finalizeCamera(input, output) {
  const info = await probe(input);
  if (!info.video) return null;
  if (info.video.codec === 'h264') {
    try {
      await remuxToMp4(input, output);
      return probe(output);
    } catch { /* 换封装失败时转码兜底 */ }
  }
  const encoder = await detectEncoder();
  await ffmpeg(['-loglevel', 'error', '-i', input, '-map', '0:v:0', '-vf', `${COLOR_FILTER},format=${encoder.format}`, '-r', '30',
    ...encoder.args(exportVideoBitrate(info.video.width, info.video.height, 30)), '-g', '30', ...COLOR_TAGS, '-movflags', '+faststart', output]);
  return probe(output);
}

async function finalizeAudio(input, output) {
  const info = await probe(input);
  if (!info.hasAudio) return null;
  await ffmpeg(['-loglevel', 'error', '-i', input, '-vn', '-c:a', 'aac', '-b:a', String(EXPORT_AUDIO_BITRATE), '-movflags', '+faststart', output]);
  return probe(output);
}

/// 时间线缩略图：一张横向拼图，时间线按素材时间取其中一格。
async function makeThumbnails(input, output, duration) {
  const count = Math.max(1, Math.min(60, Math.ceil(duration / 0.5)));
  const interval = duration / count;
  const tileHeight = 72;
  await ffmpeg(['-loglevel', 'error', '-i', input, '-vf', `fps=${(1 / interval).toFixed(6)},scale=-2:${tileHeight},tile=${count}x1`, '-frames:v', '1', '-q:v', '5', output]);
  return { file: path.basename(output), count, interval };
}

/// 把一条音轨对齐到屏幕时间轴，再按时间线片段裁切、变速、拼接。
function audioChain(inputIndex, track, segments, sourceDuration, label) {
  const filters = [];
  const aligned = `${label}al`;
  const align = track.offset >= 0
    ? `adelay=${Math.round(track.offset * 1000)}:all=1`
    : `atrim=start=${(-track.offset).toFixed(6)},asetpts=PTS-STARTPTS`;
  filters.push(`[${inputIndex}:a]aresample=48000,${align},apad=whole_dur=${sourceDuration.toFixed(6)},volume=${track.volume.toFixed(4)},asplit=${segments.length}${segments.map((_, i) => `[${aligned}${i}]`).join('')}`);
  segments.forEach((segment, i) => {
    const tempo = Math.abs(segment.speed - 1) > 1e-6 ? `,atempo=${segment.speed}` : '';
    filters.push(`[${aligned}${i}]atrim=start=${segment.sourceStart.toFixed(6)}:end=${segment.sourceEnd.toFixed(6)},asetpts=PTS-STARTPTS${tempo}[${label}s${i}]`);
  });
  filters.push(`${segments.map((_, i) => `[${label}s${i}]`).join('')}concat=n=${segments.length}:v=0:a=1[${label}]`);
  return filters;
}

/// 导出最后一步：把渲染好的 H.264 裸流与按时间线处理过的音频合成 MP4，或只出 M4A。
function buildMuxArguments({ videoFile, frameRate, audioTracks, segments, sourceDuration, outputDuration, outputFile, colorSpace }) {
  const args = ['-loglevel', 'error', '-stats'];
  let inputCount = 0;
  if (videoFile) {
    args.push('-r', String(frameRate), '-f', 'h264', '-i', videoFile);
    inputCount += 1;
  }
  const filters = [];
  const labels = [];
  audioTracks.forEach((track, i) => {
    args.push('-i', track.file);
    const label = `a${i}`;
    filters.push(...audioChain(inputCount, track, segments, sourceDuration, label));
    labels.push(`[${label}]`);
    inputCount += 1;
  });
  if (labels.length > 1) filters.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest[aout]`);
  if (filters.length) args.push('-filter_complex', filters.join(';'));
  if (videoFile) {
    args.push('-map', '0:v:0', '-c:v', 'copy');
    const matrix = { bt709: 1, smpte170m: 6, bt470bg: 5 }[colorSpace && colorSpace.matrix] || 1;
    const primaries = { bt709: 1, smpte170m: 6, bt470bg: 5 }[colorSpace && colorSpace.primaries] || 1;
    const transfer = { bt709: 1, smpte170m: 6, 'iec61966-2-1': 13 }[colorSpace && colorSpace.transfer] || 1;
    args.push('-bsf:v', `h264_metadata=colour_primaries=${primaries}:transfer_characteristics=${transfer}:matrix_coefficients=${matrix}:video_full_range_flag=${colorSpace && colorSpace.fullRange ? 1 : 0}`);
  }
  if (labels.length) {
    args.push('-map', labels.length > 1 ? '[aout]' : labels[0], '-c:a', 'aac', '-b:a', String(EXPORT_AUDIO_BITRATE));
  }
  args.push('-t', outputDuration.toFixed(6), '-movflags', '+faststart', outputFile);
  return args;
}

module.exports = {
  resolveBinaries, run, ffmpeg, checkAvailable, detectEncoders, detectEncoder, startCapture, probe,
  buildVideoIndex, remuxToMp4, finalizeCamera, finalizeAudio, makeThumbnails, buildMuxArguments,
};
