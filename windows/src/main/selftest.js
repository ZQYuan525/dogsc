'use strict';
// 端到端自测：npm run selftest。在本机真实跑一遍 录屏 → 整理 → 导出，并核对颜色、时长与画面。
// 结果写到 %TEMP%\dogsc-selftest\report.json，截图也放在同一目录。
// 自测只移动自己打开的色卡窗口，不会点击或操作桌面上的其他东西。

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { RecordingSession } = require('./recording');
const { planAutoZoom } = require('../core/zoom');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RENDERER = path.join(__dirname, '..', 'renderer');
const PATCH_COLORS = [['红', [255, 0, 0]], ['绿', [0, 255, 0]], ['蓝', [0, 0, 255]], ['灰', [128, 128, 128]], ['白', [255, 255, 255]], ['肤', [224, 160, 112]], ['黑', [0, 0, 0]]];

async function run(context) {
  const { media, createWindow, openEditor, showRecorder, showLibrary, setEnvironment } = context;
  const output = path.join(app.getPath('temp'), 'dogsc-selftest');
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  const report = {};
  const note = (key, value) => { report[key] = value; console.log(`[selftest] ${key}: ${JSON.stringify(value)}`); };
  const snapshot = async (win, name) => fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG());

  try {
    const environment = await media.checkAvailable();
    note('ffmpeg', environment);
    if (!environment.ok) throw new Error(environment.reason);
    const encoder = await media.detectEncoder();
    note('captureEncoder', encoder.label);
    setEnvironment({ ...environment, encoder: encoder.label });

    const display = screen.getPrimaryDisplay();
    const scale = display.scaleFactor;
    const chartBounds = { x: 140, y: 140, width: 910, height: 420 };
    const chart = new BrowserWindow({ ...chartBounds, frame: false, alwaysOnTop: true, show: false, resizable: false, skipTaskbar: true });
    await chart.loadFile(path.join(RENDERER, 'selftest-chart.html'));
    chart.showInactive();
    await sleep(900);

    // ---- 1. 整块屏幕
    const displaySession = new RecordingSession({ projectsRoot: output, selection: { kind: 'display', displayId: display.id }, frameRate: 60, name: 'selftest-display' });
    const started = await displaySession.start();
    const recordedFor = 4600;
    await sleep(2000);
    displaySession.addMarker();
    await sleep(recordedFor - 2000);
    const stages = [];
    const { directory, project } = await displaySession.finish([], (stage) => stages.push(stage));
    const index = JSON.parse(fs.readFileSync(path.join(directory, 'media', 'screen.index.json'), 'utf8'));
    const pointer = JSON.parse(fs.readFileSync(path.join(directory, 'media', 'pointer.json'), 'utf8'));
    note('displayRecording', {
      encoder: started.encoder, width: project.media.screen.width, height: project.media.screen.height,
      duration: project.media.screen.duration, frames: index.packets.length,
      effectiveFps: Number((index.packets.length / project.media.screen.duration).toFixed(2)),
      keyframes: index.packets.filter((packet) => packet[4]).length, codec: index.codec,
      pointerEvents: pointer.events.length, clickSupport: pointer.hasClicks, markers: project.markers.length, stages,
    });

    // ---- 2. 合成素材：真实桌面上不替用户点鼠标，改为写入一段指针轨迹来驱动光标与自动缩放；
    //         再配一条正弦波"麦克风"和测试图"摄像头"，把混音与画中画也走一遍。
    const physical = screen.dipToScreenRect(null, display.bounds);
    const patches = PATCH_COLORS.map(([name, rgb], i) => ({
      name, rgb,
      x: ((chartBounds.x + chartBounds.width * (i + 0.5) / PATCH_COLORS.length) * scale) / physical.width,
      y: ((chartBounds.y + chartBounds.height * 0.35) * scale) / physical.height,
    }));
    const events = [{ time: 0, x: 0.75, y: 0.8, kind: 'move', cursor: 'arrow' }];
    const glide = (from, to, startTime, endTime, cursor) => {
      for (let t = startTime; t <= endTime + 1e-9; t += 1 / 60) {
        const p = (t - startTime) / (endTime - startTime);
        events.push({ time: t, x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p, kind: 'move', cursor });
      }
    };
    // 点击落在色块下半部，避开上半部的取色点，光标与涟漪不会干扰颜色核对。
    const target = (index) => ({ x: patches[index].x, y: ((chartBounds.y + chartBounds.height * 0.58) * scale) / physical.height });
    glide({ x: 0.75, y: 0.8 }, target(0), 0.5, 1.4, 'arrow');
    events.push({ time: 1.5, ...target(0), kind: 'leftClick', cursor: 'hand' });
    glide(target(0), target(3), 2.6, 3.0, 'hand');
    events.push({ time: 3.1, ...target(3), kind: 'leftClick', cursor: 'hand' });
    fs.writeFileSync(path.join(directory, 'media', 'pointer.json'), JSON.stringify({ hasClicks: true, events }));
    project.zoomAnimations = planAutoZoom(events, { zoomScale: 1.6, easing: 'spring', transitionDuration: 0.7, duration: project.media.screen.duration });
    note('autoZoom', project.zoomAnimations.map((clip) => ({ start: Number(clip.startTime.toFixed(3)), end: Number(clip.endTime.toFixed(3)), scale: clip.scale, exit: clip.exitDuration })));

    await media.ffmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:a', 'aac', path.join(directory, 'media', 'microphone.m4a')]);
    project.media.microphone = { file: 'media/microphone.m4a', duration: 4, offset: 0.3 };
    await media.ffmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x480:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-movflags', '+faststart', path.join(directory, 'media', 'camera.mp4')]);
    fs.writeFileSync(path.join(directory, 'media', 'camera.index.json'), JSON.stringify(await media.buildVideoIndex(path.join(directory, 'media', 'camera.mp4'))));
    project.media.camera = { file: 'media/camera.mp4', index: 'media/camera.index.json', width: 640, height: 480, duration: 4, offset: 0.2 };
    fs.writeFileSync(path.join(directory, 'project.json'), JSON.stringify(project, null, 2));

    // ---- 3. 单个窗口、自选区域
    const hwnd = Number(chart.getNativeWindowHandle().readBigUInt64LE(0));
    const windowSession = new RecordingSession({ projectsRoot: output, selection: { kind: 'window', hwnd, title: '色卡' }, frameRate: 30, name: 'selftest-window' });
    await windowSession.start();
    await sleep(1800);
    const windowResult = await windowSession.finish([]);
    note('windowRecording', {
      width: windowResult.project.media.screen.width, height: windowResult.project.media.screen.height, duration: windowResult.project.media.screen.duration,
      expected: { width: Math.round(chartBounds.width * scale), height: Math.round(chartBounds.height * scale) },
    });
    const areaSession = new RecordingSession({
      projectsRoot: output, frameRate: 30, name: 'selftest-area',
      selection: { kind: 'area', displayId: display.id, rect: { x: Math.round(chartBounds.x * scale), y: Math.round(chartBounds.y * scale), width: Math.round(chartBounds.width * scale) + 1, height: Math.round(chartBounds.height * scale) + 1 } },
    });
    await areaSession.start();
    await sleep(3400);
    const areaResult = await areaSession.finish([]);
    note('areaRecording', { width: areaResult.project.media.screen.width, height: areaResult.project.media.screen.height, duration: areaResult.project.media.screen.duration });
    chart.close();

    // ---- 4. 渲染进程：色彩核对 + 三次导出
    const page = createWindow('selftest.html', { width: 640, height: 400, show: false }, { project: directory, out: output, patches: JSON.stringify(patches) });
    const rendererLog = [];
    page.webContents.on('console-message', (...args) => {
      const message = String(args[0] && args[0].message !== undefined ? args[0].message : args[2]).slice(0, 600);
      rendererLog.push(message);
      console.log(`[selftest] renderer: ${message}`);
    });
    const rendered = await new Promise((resolve) => {
      ipcMain.once('selftest:done', (event, payload) => resolve(payload));
      setTimeout(() => resolve({ ok: false, error: `渲染进程自测超时（180 秒），最后的输出：${rendererLog.slice(-6).join(' | ')}` }), 180000);
    });
    note('rendererWarnings', rendererLog.filter((line) => /重试|uncaught|unhandled/i.test(line)));
    if (!page.isDestroyed()) page.close();
    if (!rendered.ok) throw new Error(rendered.error);
    const worst = (rows) => rows.reduce((max, row) => Math.max(max, row.deviation), 0);
    note('captureColour', { worstDeviation: worst(rendered.result.capture), patches: rendered.result.capture.map((row) => `${row.name} ${row.actual.join(',')}`) });
    note('exportColour', { worstDeviation: worst(rendered.result.roundTrip), samples: rendered.result.roundTrip.length, detail: rendered.result.roundTrip.filter((row) => row.deviation > 6) });
    note('scene', rendered.result.scene);
    for (const [key, file] of [['export1', 'export-1.mp4'], ['export2', 'export-2.mp4'], ['export3', 'export-3.m4a']]) {
      const info = await media.probe(path.join(output, file));
      const colour = key === 'export3' ? null : (await media.run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_range,color_space,color_primaries,color_transfer,profile', '-of', 'csv=p=0', path.join(output, file)])).stdout.trim();
      note(key, { ...rendered.result[key], outputFile: undefined, probed: info, colourTags: colour, expectedDuration: key === 'export1' ? project.media.screen.duration : rendered.result.expectedDuration2 });
    }

    // ---- 5. 录制条的附加轨：用画布和振荡器冒充摄像头与麦克风（不打开真实设备），
    //         系统声音走真实的回环采集，走完 MediaRecorder → 对齐 → 整理 → 导出 的整条路径。
    {
      const recorder = showRecorder();
      await sleep(1800);
      await snapshot(recorder, 'ui-recorder.png');
      // 自测不打开真实的麦克风和摄像头。
      const tracksResult = await recorder.webContents.executeJavaScript(`(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 640; canvas.height = 480;
        const context = canvas.getContext('2d');
        let n = 0;
        const paint = setInterval(() => { context.fillStyle = 'hsl(' + (n * 9 % 360) + ' 75% 45%)'; context.fillRect(0, 0, 640, 480); context.fillStyle = '#fff'; context.font = '120px sans-serif'; context.fillText(String(n++), 60, 280); }, 33);
        const audioContext = new AudioContext();
        const oscillator = audioContext.createOscillator();
        const destination = audioContext.createMediaStreamDestination();
        oscillator.connect(destination); oscillator.start();
        const fake = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...destination.stream.getAudioTracks()]);
        const prepared = await ipcRenderer.invoke('recorder:prepare', { selection: state.selection, frameRate: 30 });
        const tracks = [startTrack('camera', fake, prepared.mediaDirectory, true)];
        let system = 'ok';
        try {
          const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
          display.getVideoTracks().forEach((track) => track.stop());
          if (display.getAudioTracks().length) tracks.push(startTrack('system', new MediaStream(display.getAudioTracks()), prepared.mediaDirectory));
          else system = 'no audio track';
        } catch (error) { system = String(error); }
        await Promise.all(tracks.map((track) => track.started));
        const started = await ipcRenderer.invoke('recorder:start');
        await new Promise((resolve) => setTimeout(resolve, 3600));
        clearInterval(paint);
        const finished = await stopTracks(tracks);
        const result = await ipcRenderer.invoke('recorder:stop', finished);
        return { directory: result.directory, system, mime: tracks.map((track) => track.recorder.mimeType), lead: finished.map((track) => Number((track.startedAt - started.firstFrameTime).toFixed(3))) };
      })()`);
      const recorded = JSON.parse(fs.readFileSync(path.join(tracksResult.directory, 'project.json'), 'utf8')).media;
      note('trackRecording', {
        systemLoopback: tracksResult.system, mime: tracksResult.mime, startOffsets: tracksResult.lead,
        screen: recorded.screen.duration,
        camera: recorded.camera && { width: recorded.camera.width, height: recorded.camera.height, duration: recorded.camera.duration, offset: Number(recorded.camera.offset.toFixed(3)) },
        microphone: recorded.microphone && { duration: recorded.microphone.duration, offset: Number(recorded.microphone.offset.toFixed(3)) },
        systemAudio: recorded.systemAudio && { duration: recorded.systemAudio.duration, offset: Number(recorded.systemAudio.offset.toFixed(3)) },
        leftovers: fs.readdirSync(path.join(tracksResult.directory, 'media')).filter((name) => /raw|\.mkv$/.test(name)),
      });
      const tracksEditor = openEditor(tracksResult.directory);
      await sleep(3000);
      const exported = await tracksEditor.webContents.executeJavaScript(`(async () => {
        const { exportProject } = require('./editor/export');
        const directory = ${JSON.stringify(tracksResult.directory)};
        const project = await require('electron').ipcRenderer.invoke('project:read', directory);
        return exportProject({ project, directory, outputFile: ${JSON.stringify(path.join(output, 'export-tracks.mp4'))}, resolution: 'source', frameRate: 30 });
      })()`);
      await snapshot(tracksEditor, 'ui-editor-tracks.png');
      tracksEditor.close();
      note('trackExport', { frames: exported.frames, duration: exported.duration, probed: await media.probe(path.join(output, 'export-tracks.mp4')) });
    }

    // ---- 6. 其余界面截图
    {
      for (const [file, options, name] of [
        ['picker.html', { width: 900, height: 620 }, 'ui-picker.png'],
        ['area.html', { width: 900, height: 520, frame: false, transparent: true }, 'ui-area.png'],
        ['memo.html', { width: 360, height: 300, frame: false, transparent: true }, 'ui-memo.png'],
      ]) {
        const win = createWindow(file, { ...options, show: true }, { store: path.join(output, 'memo.json') });
        await sleep(file === 'picker.html' ? 2600 : 1200);
        await snapshot(win, name);
        win.close();
      }
      // 说明文档用的编辑器截图：打开只含色卡的区域录制，画面里没有桌面内容。
      const documentEditor = openEditor(areaResult.directory);
      await sleep(3500);
      await documentEditor.webContents.executeJavaScript('document.getElementById("add-zoom").click(); window.dogscSelfTest && window.dogscSelfTest()');
      await sleep(1200);
      await snapshot(documentEditor, 'doc-editor.png');
      documentEditor.close();
      const editor = openEditor(directory);
      const editorMessages = [];
      editor.webContents.on('console-message', (...args) => {
        const entry = args[0] && args[0].message !== undefined ? args[0] : { message: args[2], level: args[1] };
        if (entry.level === 'error' || entry.level === 3 || /Uncaught|Error/.test(String(entry.message))) editorMessages.push(String(entry.message).slice(0, 400));
      });
      await sleep(4500);
      note('editorConsoleErrors', editorMessages);
      await snapshot(editor, 'ui-editor.png');
      await editor.webContents.executeJavaScript('window.dogscSelfTest && window.dogscSelfTest()').then((value) => note('editorSelfTest', value)).catch((error) => note('editorSelfTest', String(error)));
      await sleep(600);
      await snapshot(editor, 'ui-editor-2.png');
      showLibrary();
      await sleep(1500);
      await snapshot(BrowserWindow.getAllWindows().find((win) => win.getTitle().includes('项目库')), 'ui-library.png');
    }
    note('ok', true);
  } catch (error) {
    note('ok', false);
    note('error', String(error && error.stack || error));
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    app.exit(report.ok ? 0 : 1);
  }
}

module.exports = { run };
