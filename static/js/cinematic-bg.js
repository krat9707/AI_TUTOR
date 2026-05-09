/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  Cinematic Scroll-Synced Background Engine                  ║
 * ║  Premium Apple-style image-sequence animation               ║
 * ║  158 PNG frames · Lenis smooth scroll · Canvas 2D           ║
 * ╚══════════════════════════════════════════════════════════════╝
 */
(function () {
  'use strict';

  /* ═══════════════════════════════════════════
     CONFIGURATION
  ═══════════════════════════════════════════ */
  const CONFIG = {
    frameCount: 158,
    framePath: '/static/bg-frames/ezgif-frame-',
    frameExt: '.png',
    frameDigits: 3,

    // Lerp interpolation — lower = smoother/heavier, higher = snappier
    lerpFactor: 0.075,
    lerpThreshold: 0.01,

    // Preloading strategy
    criticalFrames: 30,
    batchSize: 15,
    batchDelay: 60,

    // Lenis smooth scroll
    lenis: {
      duration: 1.2,
      easing: function (t) { return Math.min(1, 1.001 - Math.pow(2, -10 * t)); },
      orientation: 'vertical',
      gestureOrientation: 'vertical',
      smoothWheel: true,
      wheelMultiplier: 1,
      touchMultiplier: 2,
    },

    canvasId: 'webgl-bg',
    maxDPR: 2,
    enableLoop: false,
    darkOverlayOpacity: 0.15,
  };

  /* ═══════════════════════════════════════════
     STATE
  ═══════════════════════════════════════════ */
  const state = {
    frames: new Array(CONFIG.frameCount).fill(null),
    loadedCount: 0,
    targetFrame: 0,
    currentFrame: 0,
    lastRenderedFrame: -1,
    isRunning: false,
    canvasWidth: 0,
    canvasHeight: 0,
    dpr: 1,
    isDark: false,
    resizeTimer: null,
  };

  /* ═══════════════════════════════════════════
     CANVAS SETUP
  ═══════════════════════════════════════════ */
  const canvas = document.getElementById(CONFIG.canvasId);
  if (!canvas) {
    console.warn('[CinematicBG] Canvas element not found');
    return;
  }

  const ctx = canvas.getContext('2d', {
    alpha: false,
    willReadFrequently: false,
  });

  function sizeCanvas() {
    state.dpr = Math.min(window.devicePixelRatio || 1, CONFIG.maxDPR);
    state.canvasWidth = window.innerWidth;
    state.canvasHeight = window.innerHeight;

    canvas.width = state.canvasWidth * state.dpr;
    canvas.height = state.canvasHeight * state.dpr;
    canvas.style.width = state.canvasWidth + 'px';
    canvas.style.height = state.canvasHeight + 'px';

    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);

    // Force redraw after resize
    state.lastRenderedFrame = -1;
  }

  sizeCanvas();

  window.addEventListener('resize', function () {
    clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(sizeCanvas, 150);
  }, { passive: true });

  /* ═══════════════════════════════════════════
     FRAME FILENAME HELPER
  ═══════════════════════════════════════════ */
  function getFramePath(index) {
    var num = String(index + 1).padStart(CONFIG.frameDigits, '0');
    return CONFIG.framePath + num + CONFIG.frameExt;
  }

  /* ═══════════════════════════════════════════
     IMAGE PRELOADING PIPELINE
  ═══════════════════════════════════════════ */
  function loadFrame(index) {
    return new Promise(function (resolve) {
      if (state.frames[index]) {
        resolve(state.frames[index]);
        return;
      }

      var img = new Image();
      img.decoding = 'async';

      img.onload = function () {
        state.frames[index] = img;
        state.loadedCount++;

        if (typeof img.decode === 'function') {
          img.decode().then(function () { resolve(img); }).catch(function () { resolve(img); });
        } else {
          resolve(img);
        }
      };

      img.onerror = function () {
        console.warn('[CinematicBG] Failed to load frame', index);
        resolve(null);
      };

      img.src = getFramePath(index);
    });
  }

  async function preloadFrames() {
    // Phase 1: Critical frames sequentially for fastest first-paint
    for (var i = 0; i < Math.min(CONFIG.criticalFrames, CONFIG.frameCount); i++) {
      await loadFrame(i);
      if (i === 0 && state.frames[0]) {
        drawFrame(0);
        state.lastRenderedFrame = 0;
      }
    }

    // Phase 2: Progressive batch loading for remaining frames
    var cursor = CONFIG.criticalFrames;
    while (cursor < CONFIG.frameCount) {
      var batchEnd = Math.min(cursor + CONFIG.batchSize, CONFIG.frameCount);
      var batch = [];
      for (var j = cursor; j < batchEnd; j++) {
        batch.push(loadFrame(j));
      }
      await Promise.all(batch);
      cursor = batchEnd;

      if (cursor < CONFIG.frameCount) {
        await new Promise(function (r) { setTimeout(r, CONFIG.batchDelay); });
      }
    }
  }

  /* ═══════════════════════════════════════════
     CANVAS DRAWING
  ═══════════════════════════════════════════ */
  function drawFrame(frameIndex) {
    var img = state.frames[frameIndex];
    if (!img) return;

    var cw = state.canvasWidth;
    var ch = state.canvasHeight;
    var iw = img.naturalWidth || img.width;
    var ih = img.naturalHeight || img.height;

    if (!iw || !ih) return;

    // "Cover" scaling — fill canvas preserving aspect ratio
    var canvasRatio = cw / ch;
    var imageRatio = iw / ih;
    var drawWidth, drawHeight, offsetX, offsetY;

    if (imageRatio > canvasRatio) {
      drawHeight = ch;
      drawWidth = ch * imageRatio;
      offsetX = (cw - drawWidth) * 0.5;
      offsetY = 0;
    } else {
      drawWidth = cw;
      drawHeight = cw / imageRatio;
      offsetX = 0;
      offsetY = (ch - drawHeight) * 0.5;
    }

    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(img, offsetX, offsetY, drawWidth, drawHeight);

    // Dark mode overlay
    if (state.isDark && CONFIG.darkOverlayOpacity > 0) {
      ctx.fillStyle = 'rgba(0, 0, 0, ' + CONFIG.darkOverlayOpacity + ')';
      ctx.fillRect(0, 0, cw, ch);
    }
  }

  /* ═══════════════════════════════════════════
     SCROLL → FRAME MAPPING
  ═══════════════════════════════════════════ */
  function updateTargetFrame(scrollProgress) {
    var rawFrame = scrollProgress * (CONFIG.frameCount - 1);

    if (CONFIG.enableLoop) {
      rawFrame = ((rawFrame % CONFIG.frameCount) + CONFIG.frameCount) % CONFIG.frameCount;
    } else {
      rawFrame = Math.max(0, Math.min(CONFIG.frameCount - 1, rawFrame));
    }

    state.targetFrame = rawFrame;
  }

  /* ═══════════════════════════════════════════
     LENIS SMOOTH SCROLL
  ═══════════════════════════════════════════ */
  var lenisInstance = null;

  function initLenis() {
    if (typeof Lenis === 'undefined') {
      console.warn('[CinematicBG] Lenis not loaded, falling back to native scroll');
      initNativeScrollFallback();
      return;
    }

    lenisInstance = new Lenis(CONFIG.lenis);

    lenisInstance.on('scroll', function (e) {
      var scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
      var progress = scrollHeight > 0 ? (e.scroll / scrollHeight) : 0;
      updateTargetFrame(progress);
    });
  }

  function initNativeScrollFallback() {
    window.addEventListener('scroll', function () {
      var scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
      var progress = scrollHeight > 0 ? (window.scrollY / scrollHeight) : 0;
      updateTargetFrame(progress);
    }, { passive: true });
  }

  /* ═══════════════════════════════════════════
     ANIMATION LOOP (requestAnimationFrame)
  ═══════════════════════════════════════════ */
  function lerp(current, target, factor) {
    return current + (target - current) * factor;
  }

  function tick(time) {
    if (!state.isRunning) return;

    // Drive Lenis
    if (lenisInstance) {
      lenisInstance.raf(time);
    }

    // Lerp current frame toward target
    var delta = state.targetFrame - state.currentFrame;

    if (Math.abs(delta) > CONFIG.lerpThreshold) {
      state.currentFrame = lerp(state.currentFrame, state.targetFrame, CONFIG.lerpFactor);
    } else {
      state.currentFrame = state.targetFrame;
    }

    // Determine which discrete frame to render
    var frameToRender = Math.round(state.currentFrame);
    var clampedFrame = Math.max(0, Math.min(CONFIG.frameCount - 1, frameToRender));

    // Only redraw if frame actually changed
    if (clampedFrame !== state.lastRenderedFrame && state.frames[clampedFrame]) {
      drawFrame(clampedFrame);
      state.lastRenderedFrame = clampedFrame;
    }

    requestAnimationFrame(tick);
  }

  function start() {
    if (state.isRunning) return;
    state.isRunning = true;
    requestAnimationFrame(tick);
  }

  function stop() {
    state.isRunning = false;
  }

  /* ═══════════════════════════════════════════
     THEME COMPATIBILITY
  ═══════════════════════════════════════════ */
  window.updateParticleTheme = function (theme) {
    state.isDark = (theme === 'dark');
    state.lastRenderedFrame = -1;
  };

  state.isDark = document.documentElement.classList.contains('dark');

  /* ═══════════════════════════════════════════
     INITIALIZATION
  ═══════════════════════════════════════════ */
  function init() {
    // Fill canvas with neutral color while frames load
    ctx.fillStyle = state.isDark ? '#0a0a0a' : '#ffffff';
    ctx.fillRect(0, 0, state.canvasWidth, state.canvasHeight);

    initLenis();
    start();

    preloadFrames().then(function () {
      var scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
      var progress = scrollHeight > 0 ? (window.scrollY / scrollHeight) : 0;
      updateTargetFrame(progress);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ═══════════════════════════════════════════
     CLEANUP
  ═══════════════════════════════════════════ */
  window.addEventListener('beforeunload', function () {
    stop();
    if (lenisInstance) {
      lenisInstance.destroy();
      lenisInstance = null;
    }
  });

})();
