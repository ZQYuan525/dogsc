'use strict';
// 导出用的逐帧解码器：按包索引从 MP4 里顺序读包，交给 WebCodecs 硬解，
// 按时间取"不晚于 t 的最后一帧"。相当于 macOS 版导出管线里的 AVAssetReader。

const fs = require('node:fs');

const MAX_QUEUED_FRAMES = 10;
const FEED_BATCH = 6;

class FrameSource {
  constructor(file, index, hardware = true) {
    this.file = file;
    this.packets = index.packets; // [pos, size, pts, dts, key]，按解码顺序
    this.config = {
      codec: index.codec,
      codedWidth: index.width,
      codedHeight: index.height,
      description: Uint8Array.from(Buffer.from(index.description, 'base64')),
      hardwareAcceleration: hardware ? 'prefer-hardware' : 'prefer-software',
    };
    this.firstTime = Math.min(...this.packets.slice(0, 8).map((packet) => packet[2]));
    this.lastTime = this.packets.reduce((latest, packet) => Math.max(latest, packet[2]), 0);
    this.fd = fs.openSync(file, 'r');
    this.decoder = null;
    this.queue = [];
    this.nextPacket = 0;
    this.flushed = false;
    this.error = null;
    this.wake = null;
  }

  async open() {
    let support = await VideoDecoder.isConfigSupported(this.config);
    if (!support.supported) {
      this.config.hardwareAcceleration = 'no-preference';
      support = await VideoDecoder.isConfigSupported(this.config);
    }
    if (!support.supported) throw new Error(`无法解码素材（${this.config.codec}）`);
    this.restart(0);
  }

  restart(packetIndex) {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    for (const frame of this.queue) frame.close();
    this.queue = [];
    this.flushed = false;
    this.nextPacket = packetIndex;
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.queue.push(frame);
        if (this.wake) this.wake();
      },
      error: (error) => {
        this.error = error;
        if (this.wake) this.wake();
      },
    });
    this.decoder.configure(this.config);
  }

  keyframeAtOrBefore(time) {
    let found = 0;
    for (let i = 0; i < this.packets.length; i++) {
      const packet = this.packets[i];
      if (packet[4] && packet[2] <= time) found = i;
      if (packet[3] > time + 1) break;
    }
    return found;
  }

  feed() {
    for (let n = 0; n < FEED_BATCH && this.nextPacket < this.packets.length; n++) {
      const [position, size, pts, , key] = this.packets[this.nextPacket];
      const data = new Uint8Array(size);
      fs.readSync(this.fd, data, 0, size, position);
      this.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: Math.round(pts * 1e6), data }));
      this.nextPacket += 1;
    }
  }

  waitForOutput() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.wake = null; resolve(); }, 200);
      this.wake = () => { clearTimeout(timer); this.wake = null; resolve(); };
    });
  }

  /// 返回的帧归本对象所有，在下一次 frameAt 之前有效。
  async frameAt(time) {
    const target = Math.round(Math.min(Math.max(time, this.firstTime), this.lastTime) * 1e6);
    const head = this.queue[0];
    const fedUntil = this.nextPacket > 0 ? this.packets[this.nextPacket - 1][3] : -Infinity;
    // 往回取帧，或跳过了一整段被剪掉的素材：从目标前的关键帧重新开始。
    if ((head && target < head.timestamp - 1) || target / 1e6 > fedUntil + 2) {
      const keyframe = this.keyframeAtOrBefore(target / 1e6);
      if ((head && target < head.timestamp - 1) || keyframe > this.nextPacket) this.restart(keyframe);
    }
    for (;;) {
      if (this.fd === null) throw new Error('解码器已关闭');
      if (this.error) throw Object.assign(new Error(`素材解码失败：${this.error.message || this.error}`), { codecFailure: true });
      while (this.queue.length >= 2 && this.queue[1].timestamp <= target) this.queue.shift().close();
      if (this.queue.length >= 2 || (this.flushed && this.queue.length)) return this.queue[0];
      if (this.nextPacket < this.packets.length) {
        if (this.queue.length < MAX_QUEUED_FRAMES && this.decoder.decodeQueueSize < FEED_BATCH) this.feed();
        await this.waitForOutput();
      } else if (!this.flushed) {
        await this.decoder.flush();
        this.flushed = true;
        if (!this.queue.length) throw new Error('素材解码没有输出画面');
      }
    }
  }

  close() {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    for (const frame of this.queue) frame.close();
    this.queue = [];
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
  }
}

module.exports = { FrameSource };
