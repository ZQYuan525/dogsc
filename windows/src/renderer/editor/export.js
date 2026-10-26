'use strict';
// 导出：逐帧解码素材 → 合成 → WebCodecs 硬件编码成 H.264 裸流 → 主进程用 ffmpeg 合入音频。
// 对应 macOS 版的 DirectExportPipeline / VideoExporter。

const fs = require('node:fs');
const path = require('node:path');
const { ipcRenderer } = require('electron');
const { canvasDimensions, exportVideoBitrate } = require('../../core/model');
const { orderedClips } = require('../../core/zoom');
const { PointerTrack } = require('../../core/pointer');
const { evaluateScene } = require('../../core/scene');
const timeline = require('../../core/timeline');
const { Compositor } = require('./render');
const { FrameSource } = require('./frame-source');

const STALL_TIMEOUT = 20000;

class ExportCancelled extends Error {
  constructor() { super('已取消导出'); this.cancelled = true; }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function loadVideoIndex(directory, track) {
  const file = path.join(directory, track.index || `${track.file}.index.json`);
  if (fs.existsSync(file)) return readJson(file);
  const index = await ipcRenderer.invoke('project:rebuild-index', path.join(directory, track.file));
  fs.writeFileSync(file, JSON.stringify(index));
  return index;
}

function loadPointerTrack(directory, project) {
  if (!project.media.pointer) return null;
  try {
    return new PointerTrack(readJson(path.join(directory, project.media.pointer)).events);
  } catch {
    return null;
  }
}

/// 参与导出的音轨：静音或音量为 0 的轨不进混音。
function audioTracks(directory, project) {
  const tracks = [];
  const { audio, media } = project;
  if (media.microphone && !audio.isMicrophoneMuted && audio.microphoneVolume > 0) {
    tracks.push({ file: path.join(directory, media.microphone.file), offset: media.microphone.offset || 0, volume: audio.microphoneVolume });
  }
  if (media.systemAudio && !audio.isSystemMuted && audio.systemVolume > 0) {
    tracks.push({ file: path.join(directory, media.systemAudio.file), offset: media.systemAudio.offset || 0, volume: audio.systemVolume });
  }
  return tracks;
}

async function chooseEncoderConfig(width, height, frameRate, hardware) {
  const pixels = width * height;
  const level = pixels > 3_700_000 ? '34' : pixels > 2_100_000 ? '33' : '2a';
  const base = {
    width, height, framerate: frameRate,
    bitrate: exportVideoBitrate(width, height, frameRate),
    bitrateMode: 'variable', latencyMode: 'quality', avc: { format: 'annexb' },
  };
  // 优先 High Profile 硬件编码，依次退到软件编码与 Baseline。
  const candidates = [[`avc1.6400${level}`, 'prefer-software'], [`avc1.4200${level}`, 'prefer-software'], [`avc1.4200${level}`, 'no-preference']];
  if (hardware) candidates.unshift([`avc1.6400${level}`, 'prefer-hardware']);
  for (const [codec, hardwareAcceleration] of candidates) {
    const config = { ...base, codec, hardwareAcceleration };
    if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
  }
  throw new Error('当前系统没有可用的 H.264 编码器');
}

/// 活动看门狗（对应 macOS 版的 ExportActivityWatchdog）：硬件解码器或编码器偶尔会不再吐数据，
/// 与其让进度条永远停住，不如在 20 秒无响应后报出是哪一步，交给上层换软件路径重试。
function guard(promise, label) {
  let timer = null;
  promise.catch(() => {});
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${label}超过 ${STALL_TIMEOUT / 1000} 秒没有响应`), { stalled: true })), STALL_TIMEOUT);
    }),
  ]).finally(() => clearTimeout(timer));
}

/// 渲染全部画面并编码成 H.264 裸流文件。hardware 为 false 时解码与编码都走软件路径。
async function renderVideo({ project, directory, rawFile, width, height, frameRate, totalFrames, hardware, onProgress, checkCancelled, frameHook, indexes }) {
  const { segments } = project.timeline;
  const source = project.media.screen;
  const camera = project.media.camera && !project.camera.isHidden ? project.media.camera : null;
  const compositor = new Compositor(directory);
  await compositor.prepare(project);
  const zoomClips = orderedClips(project.zoomAnimations);
  const pointerTrack = loadPointerTrack(directory, project);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  const screenSource = new FrameSource(path.join(directory, source.file), indexes.screen, hardware);
  const cameraSource = camera ? new FrameSource(path.join(directory, camera.file), indexes.camera, hardware) : null;
  const stream = fs.createWriteStream(rawFile);
  let colorSpace = null;
  let encoderError = null;
  let encoder = null;
  const encodeFailure = () => Object.assign(new Error(`视频编码失败：${encoderError.message || encoderError}`), { codecFailure: true });
  try {
    await screenSource.open();
    if (cameraSource) await cameraSource.open();
    const config = await chooseEncoderConfig(width, height, frameRate, hardware);
    encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        const data = Buffer.allocUnsafe(chunk.byteLength);
        chunk.copyTo(data);
        stream.write(data);
        const space = metadata && metadata.decoderConfig && metadata.decoderConfig.colorSpace;
        // 编码器实际使用的色彩空间，混流时原样写进码流标记。
        if (space) colorSpace = { primaries: space.primaries, transfer: space.transfer, matrix: space.matrix, fullRange: Boolean(space.fullRange) };
      },
      error: (error) => { encoderError = error; },
    });
    encoder.configure(config);

    const startedAt = performance.now();
    for (let n = 0; n < totalFrames; n++) {
      checkCancelled();
      if (encoderError) throw encodeFailure();
      const sourceTime = timeline.locate(segments, n / frameRate).sourceTime;
      const frames = { screen: await guard(screenSource.frameAt(sourceTime), '解码屏幕画面'), camera: null };
      let cameraAspect = null;
      if (cameraSource) {
        const cameraTime = sourceTime - (camera.offset || 0);
        if (cameraTime >= 0 && cameraTime <= camera.duration) {
          frames.camera = await guard(cameraSource.frameAt(cameraTime), '解码摄像头画面');
          cameraAspect = camera.width / camera.height;
        }
      }
      const scene = evaluateScene(project, { time: sourceTime, width, height, sourceAspect: source.width / source.height, cameraAspect, zoomClips, pointerTrack });
      compositor.draw(ctx, project, scene, frames);
      if (frameHook) await frameHook(n, canvas, { sourceTime, scene });

      const frame = new VideoFrame(canvas, { timestamp: Math.round(n * 1e6 / frameRate), duration: Math.round(1e6 / frameRate) });
      encoder.encode(frame, { keyFrame: n % (frameRate * 2) === 0 });
      frame.close();
      // 编码器来不及时等它消化，避免未编码帧在显存里堆积。
      const waitingSince = performance.now();
      while (encoder.encodeQueueSize > 6 && !encoderError) {
        if (performance.now() - waitingSince > STALL_TIMEOUT) throw Object.assign(new Error('视频编码器超过 20 秒没有响应'), { stalled: true });
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      if (n % 5 === 0 || n === totalFrames - 1) {
        onProgress({ stage: '正在渲染画面', fraction: (n + 1) / totalFrames, frames: n + 1, totalFrames, elapsed: (performance.now() - startedAt) / 1000 });
      }
    }
    await guard(encoder.flush(), '视频编码器收尾');
    if (encoderError) throw encodeFailure();
    await new Promise((resolve, reject) => stream.end((error) => (error ? reject(error) : resolve())));
    return { colorSpace, encoder: `${config.codec} / ${config.hardwareAcceleration}` };
  } finally {
    if (encoder && encoder.state !== 'closed') encoder.close();
    stream.destroy();
    screenSource.close();
    if (cameraSource) cameraSource.close();
  }
}

/// onProgress({ stage, fraction, frames, totalFrames })；signal 为 AbortSignal。
/// frameHook(n, canvas) 仅供自测截取中间画面。
async function exportProject({ project, directory, outputFile, kind = 'video', resolution = 'source', frameRate = 60, onProgress = () => {}, signal, frameHook }) {
  const segments = project.timeline.segments;
  const outputDuration = timeline.outputDuration(segments);
  const sourceDuration = project.media.screen.duration;
  const tracks = audioTracks(directory, project);
  const checkCancelled = () => { if (signal && signal.aborted) throw new ExportCancelled(); };
  const mux = (job) => {
    const onMux = (event, fraction) => onProgress({ stage: tracks.length ? '正在合成声音' : '正在写入文件', fraction: Math.min(fraction, 1) });
    ipcRenderer.on('export:mux-progress', onMux);
    const abort = () => ipcRenderer.send('export:cancel');
    if (signal) signal.addEventListener('abort', abort);
    return ipcRenderer.invoke('export:mux', { ...job, audioTracks: tracks, segments, sourceDuration, outputDuration, outputFile })
      .catch((error) => { throw (signal && signal.aborted ? new ExportCancelled() : error); })
      .finally(() => {
        ipcRenderer.removeListener('export:mux-progress', onMux);
        if (signal) signal.removeEventListener('abort', abort);
      });
  };

  if (kind === 'audio') {
    if (!tracks.length) throw new Error('这个项目没有可导出的声音：没有录到麦克风或系统声音，或者都已静音。');
    await mux({ videoFile: null });
    return { outputFile, duration: outputDuration };
  }

  const { width, height } = canvasDimensions(project.canvas, resolution, project.media.screen);
  const totalFrames = Math.max(Math.round(outputDuration * frameRate), 1);
  const rawFile = `${outputFile}.h264.tmp`;
  const camera = project.media.camera && !project.camera.isHidden ? project.media.camera : null;
  const indexes = {
    screen: await loadVideoIndex(directory, project.media.screen),
    camera: camera ? await loadVideoIndex(directory, camera) : null,
  };
  const job = { project, directory, rawFile, width, height, frameRate, totalFrames, onProgress, checkCancelled, frameHook, indexes };
  try {
    let rendered;
    try {
      rendered = await renderVideo({ ...job, hardware: true });
    } catch (error) {
      // 硬件编解码卡住或报错时，自动改用软件路径完整重来一遍。
      if (error.cancelled || !(error.stalled || error.codecFailure)) throw error;
      console.warn('[DogSC] 硬件编解码未能完成，改用软件路径重试：', error.message);
      onProgress({ stage: '硬件编码没有响应，正在改用软件编码重试', fraction: 0 });
      rendered = await renderVideo({ ...job, hardware: false });
      rendered.retriedAfter = error.message;
    }
    checkCancelled();
    await mux({ videoFile: rawFile, frameRate, colorSpace: rendered.colorSpace });
    return { outputFile, width, height, frameRate, frames: totalFrames, duration: outputDuration, ...rendered };
  } finally {
    fs.rmSync(rawFile, { force: true });
  }
}

module.exports = { exportProject, ExportCancelled, loadPointerTrack, loadVideoIndex, audioTracks };
