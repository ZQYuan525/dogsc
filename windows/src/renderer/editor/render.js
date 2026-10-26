'use strict';
// 画面合成器：把 scene.js 求出的几何画到 2D 画布上。预览与导出走同一份代码，
// 对应 macOS 版的 SharedFrameRenderer（那边是 Core Image / Metal）。

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { PATTERN_PRESETS } = require('../../core/model');
const { cursorLibrary } = require('./cursors');

function roundedRect(ctx, rect, radius) {
  const r = Math.max(Math.min(radius, rect.width / 2, rect.height / 2), 0);
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y, rect.width, rect.height, r);
}

const frameSize = (frame) => ({
  width: frame.displayWidth || frame.videoWidth || frame.width,
  height: frame.displayHeight || frame.videoHeight || frame.height,
});

function loadImage(file) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = pathToFileURL(file).href;
  });
}

class Compositor {
  constructor(directory) {
    this.directory = directory;
    this.images = new Map();
    this.backgroundKey = null;
    this.background = null;
    this.cursors = cursorLibrary();
  }

  backgroundFile(background) {
    if (background.kind === 'image') return path.isAbsolute(background.file) ? background.file : path.join(this.directory, background.file);
    return null;
  }

  /// 背景图片异步解码；预览在加载完成后通过 onReady 重画，导出前显式 await。
  async prepare(project) {
    const file = this.backgroundFile(project.canvas.background);
    if (file && !this.images.has(file)) this.images.set(file, await loadImage(file));
  }

  /// 背景整张缓存：点阵每帧重画上千个圆不划算，背景又不随时间变化。
  backgroundLayer(canvas, width, height, styleScale) {
    const file = this.backgroundFile(canvas.background);
    const image = file ? this.images.get(file) : null;
    const key = JSON.stringify([canvas.background, canvas.backgroundBlur, canvas.patternScale, canvas.patternOpacity, width, height, Boolean(image)]);
    if (this.backgroundKey === key) return this.background;
    const layer = new OffscreenCanvas(width, height);
    const ctx = layer.getContext('2d', { alpha: false });
    const background = canvas.background;
    if (background.kind === 'color') {
      ctx.fillStyle = background.color;
      ctx.fillRect(0, 0, width, height);
    } else if (background.kind === 'image' && image) {
      const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
      const blur = Math.max(canvas.backgroundBlur, 0) * styleScale;
      // 模糊会让边缘透出底色，画大一圈再裁回来。
      const bleed = blur * 3;
      const w = image.naturalWidth * scale + bleed * 2;
      const h = image.naturalHeight * scale + bleed * 2;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      if (blur > 0) ctx.filter = `blur(${blur}px)`;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
      ctx.filter = 'none';
    } else {
      this.drawPattern(ctx, PATTERN_PRESETS[background.preset] || PATTERN_PRESETS.obsidianGrid, canvas, width, height);
    }
    this.backgroundKey = key;
    this.background = layer;
    return layer;
  }

  drawPattern(ctx, preset, canvas, width, height) {
    ctx.fillStyle = preset.background;
    ctx.fillRect(0, 0, width, height);
    const shortEdge = Math.max(Math.min(width, height), 2);
    const tile = Math.max(shortEdge * preset.fraction * canvas.patternScale, 9);
    ctx.globalAlpha = Math.min(Math.max(canvas.patternOpacity, 0), 1);
    // 图案以画布中心为基准铺开，换分辨率时构图不漂移。
    const originX = (width / 2) % tile;
    const originY = (height / 2) % tile;
    if (preset.kind === 'dots') {
      ctx.fillStyle = preset.dot;
      const radius = Math.max(tile * 0.055, 0.9);
      ctx.beginPath();
      for (let y = originY - tile; y < height + tile; y += tile) {
        for (let x = originX - tile; x < width + tile; x += tile) {
          ctx.moveTo(x + radius, y);
          ctx.arc(x, y, radius, 0, Math.PI * 2);
        }
      }
      ctx.fill();
    } else {
      ctx.strokeStyle = preset.stroke;
      ctx.lineWidth = Math.max(shortEdge / 1080, 1);
      ctx.beginPath();
      if (preset.kind === 'grid') {
        for (let x = originX - tile; x < width + tile; x += tile) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
        for (let y = originY - tile; y < height + tile; y += tile) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
      } else {
        // 等角网：±30° 两组斜线加一组竖线。
        const slope = Math.tan(Math.PI / 6);
        const span = width * slope;
        for (let y = originY - span - tile; y < height + span + tile; y += tile) {
          ctx.moveTo(0, y); ctx.lineTo(width, y + span);
          ctx.moveTo(0, y + span); ctx.lineTo(width, y);
        }
        const step = tile / slope / 2;
        for (let x = (width / 2) % step - step; x < width + step; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  drawShadow(ctx, rect, radius, shadow) {
    if (!shadow || shadow.opacity <= 0) return;
    ctx.save();
    // Core Image 的高斯半径是 σ，画布 shadowBlur 约等于 2σ。
    ctx.shadowColor = `rgba(0,0,0,${shadow.opacity})`;
    ctx.shadowBlur = shadow.radius * 2;
    ctx.shadowOffsetY = shadow.offsetY;
    ctx.fillStyle = '#000';
    roundedRect(ctx, rect, radius);
    ctx.fill();
    ctx.restore();
  }

  drawScreen(ctx, screen, frame) {
    const rect = screen.finalRect;
    const border = screen.borderWidth;
    const outer = border > 0
      ? { x: rect.x - border, y: rect.y - border, width: rect.width + border * 2, height: rect.height + border * 2 }
      : rect;
    this.drawShadow(ctx, outer, screen.cornerRadius + border, screen.shadow);
    if (border > 0) {
      ctx.fillStyle = screen.borderColor;
      roundedRect(ctx, outer, screen.cornerRadius + border);
      ctx.fill();
    }
    ctx.save();
    roundedRect(ctx, rect, screen.cornerRadius);
    ctx.clip();
    if (frame) {
      ctx.drawImage(frame, rect.x, rect.y, rect.width, rect.height);
    } else {
      ctx.fillStyle = '#1b1c20';
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    }
    ctx.restore();
  }

  drawRing(ctx, x, y, ring, color) {
    if (!ring || ring.opacity <= 0 || ring.diameter <= 0) return;
    ctx.save();
    ctx.globalAlpha = Math.min(ring.opacity, 1);
    ctx.shadowColor = color;
    ctx.shadowBlur = ring.glow * 2;
    ctx.beginPath();
    ctx.arc(x, y, ring.diameter / 2, 0, Math.PI * 2);
    if (ring.filled) {
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = ring.lineWidth;
      ctx.stroke();
    }
    ctx.restore();
  }

  drawCursor(ctx, screen, cursor) {
    ctx.save();
    // 光标属于屏幕内容：跟着屏幕卡片一起被圆角裁切。
    roundedRect(ctx, screen.finalRect, screen.cornerRadius);
    ctx.clip();
    if (cursor.click) {
      const color = cursor.clickColor || '#FFFFFF';
      this.drawRing(ctx, cursor.x, cursor.y, cursor.click.primary, color);
      this.drawRing(ctx, cursor.x, cursor.y, cursor.click.secondary, color);
      const accent = cursor.click.accent;
      if (accent && accent.opacity > 0) {
        ctx.save();
        ctx.globalAlpha = accent.opacity;
        ctx.fillStyle = color;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          ctx.beginPath();
          ctx.arc(cursor.x + dx * accent.offset, cursor.y + dy * accent.offset, accent.size / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }
    const sprite = this.cursors[cursor.appearance] || this.cursors.arrow;
    const scale = cursor.height / this.cursors.referenceHeight;
    ctx.shadowColor = `rgba(0,0,0,${cursor.shadow.opacity})`;
    ctx.shadowBlur = cursor.shadow.radius * 2;
    ctx.shadowOffsetY = cursor.shadow.offsetY;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sprite.canvas, cursor.x - sprite.hotspotX * scale, cursor.y - sprite.hotspotY * scale, sprite.width * scale, sprite.height * scale);
    ctx.restore();
  }

  drawCamera(ctx, camera, frame) {
    const rect = camera.rect;
    const border = camera.borderWidth;
    const outer = { x: rect.x - border, y: rect.y - border, width: rect.width + border * 2, height: rect.height + border * 2 };
    this.drawShadow(ctx, outer, camera.cornerRadius + border, camera.shadow);
    if (border > 0) {
      ctx.fillStyle = '#FFFFFF';
      roundedRect(ctx, outer, camera.cornerRadius + border);
      ctx.fill();
    }
    ctx.save();
    roundedRect(ctx, rect, camera.cornerRadius);
    ctx.clip();
    // 居中等比填充（aspect-fill）。
    const source = frameSize(frame);
    const scale = Math.max(rect.width / source.width, rect.height / source.height);
    const w = source.width * scale;
    const h = source.height * scale;
    if (camera.isMirrored) {
      ctx.translate(rect.x * 2 + rect.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(frame, rect.x + (rect.width - w) / 2, rect.y + (rect.height - h) / 2, w, h);
    ctx.restore();
  }

  /// frames: { screen, camera }，可以是 <video> 或 WebCodecs VideoFrame。
  draw(ctx, project, scene, frames) {
    const { width, height } = scene;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.backgroundLayer(project.canvas, width, height, scene.styleScale), 0, 0);
    this.drawScreen(ctx, scene.screen, frames.screen);
    if (scene.cursor) this.drawCursor(ctx, scene.screen, scene.cursor);
    if (scene.camera && frames.camera) this.drawCamera(ctx, scene.camera, frames.camera);
  }
}

module.exports = { Compositor };
