/**
 * パノラマ用ジャイロ制御（look.html / viewer.html 共通）
 * v5: ゆっくり追従・指ドラッグと分離・固まりにくい
 */
(function(global) {
  'use strict';

  var GYRO_SMOOTH = 0.11;
  var GYRO_MAX_STEP = 0.028;
  var ALPHA_SPIKE_DEG = 72;

  function degToRad(d) { return d * Math.PI / 180; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function normalizeAngle(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }
  function angleDelta(from, to) {
    return normalizeAngle(to - from);
  }
  function smoothStep(current, target, smooth, maxStep) {
    var d = target - current;
    var step = smooth * d;
    if (maxStep > 0) step = clamp(step, -maxStep, maxStep);
    return current + step;
  }

  function trackOrientation(e, state) {
    if (e.beta == null) return null;
    if (state.initBeta == null) {
      state.initBeta = e.beta;
      state.initUnwrappedAlpha = e.alpha != null ? e.alpha : 0;
      state.prevAlpha = e.alpha;
      state.unwrappedAlpha = e.alpha != null ? e.alpha : 0;
      state.yawOff = 0;
      return { ready: false };
    }

    var pitchOff = degToRad(state.initBeta - e.beta);

    if (e.alpha != null && state.prevAlpha != null) {
      var alphaStep = e.alpha - state.prevAlpha;
      if (alphaStep > 180) alphaStep -= 360;
      if (alphaStep < -180) alphaStep += 360;
      if (Math.abs(alphaStep) <= ALPHA_SPIKE_DEG) {
        state.unwrappedAlpha += alphaStep;
        state.prevAlpha = e.alpha;
      }
      state.yawOff = degToRad(state.initUnwrappedAlpha - state.unwrappedAlpha);
    }

    return { ready: true, yawOff: state.yawOff, pitchOff: pitchOff };
  }

  function GyroControl(getView) {
    this.getView = getView;
    this.enabled = false;
    this.handler = null;
    this.raf = null;
    this.latestEvent = null;
    this.base = null;
    this.onChange = null;
    this.hooks = {};
  }

  GyroControl.prototype.setOnChange = function(fn) {
    this.onChange = fn;
  };

  GyroControl.prototype.setHooks = function(hooks) {
    this.hooks = hooks || {};
  };

  GyroControl.prototype._emit = function() {
    if (this.onChange) this.onChange(this.enabled);
  };

  GyroControl.prototype._cleanupListeners = function() {
    if (this.handler) {
      global.removeEventListener('deviceorientation', this.handler, true);
      this.handler = null;
    }
    if (this.raf) {
      global.cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    this.latestEvent = null;
  };

  GyroControl.prototype.stop = function() {
    var wasOn = this.enabled;
    this._cleanupListeners();
    this.base = null;
    this.enabled = false;
    if (wasOn) {
      if (this.hooks.onStop) this.hooks.onStop();
      this._emit();
    }
  };

  GyroControl.prototype.start = function() {
    var view = this.getView();
    if (!view) return false;
    var wasOn = this.enabled;
    this._cleanupListeners();
    this.enabled = true;
    this.base = { viewYaw: view.yaw(), viewPitch: view.pitch() };
    if (!wasOn && this.hooks.onStart) this.hooks.onStart();

    var self = this;
    var displayYaw = view.yaw();
    var displayPitch = view.pitch();
    var orientState = {
      initBeta: null,
      initUnwrappedAlpha: 0,
      prevAlpha: null,
      unwrappedAlpha: 0,
      yawOff: 0
    };

    this.handler = function(e) { self.latestEvent = e; };
    global.addEventListener('deviceorientation', this.handler, true);

    function tick() {
      if (!self.enabled) return;
      self.raf = global.requestAnimationFrame(tick);
      var v = self.getView();
      if (!v || !self.latestEvent) return;
      var o = trackOrientation(self.latestEvent, orientState);
      if (!o) return;
      if (!o.ready) {
        displayYaw = self.base.viewYaw;
        displayPitch = self.base.viewPitch;
        return;
      }
      var targetYaw = self.base.viewYaw + o.yawOff;
      var targetPitch = clamp(self.base.viewPitch + o.pitchOff, -Math.PI / 2, Math.PI / 2);
      displayYaw = normalizeAngle(
        displayYaw + clamp(GYRO_SMOOTH * angleDelta(displayYaw, targetYaw), -GYRO_MAX_STEP, GYRO_MAX_STEP)
      );
      displayPitch = clamp(
        smoothStep(displayPitch, targetPitch, GYRO_SMOOTH, GYRO_MAX_STEP),
        -Math.PI / 2,
        Math.PI / 2
      );
      v.setYaw(displayYaw);
      v.setPitch(displayPitch);
    }
    this.raf = global.requestAnimationFrame(tick);
    this._emit();
    return true;
  };

  GyroControl.prototype.requestStart = function() {
    var self = this;
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      return DeviceOrientationEvent.requestPermission().then(function(state) {
        if (state === 'granted') return self.start();
        return false;
      }).catch(function() { return false; });
    }
    return Promise.resolve(self.start());
  };

  GyroControl.prototype.toggle = function() {
    if (this.enabled) {
      this.stop();
      return Promise.resolve(false);
    }
    return this.requestStart();
  };

  GyroControl.isSupportedDevice = function() {
    if (!('ontouchstart' in global)) return false;
    var ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod|Android/i.test(ua)) return true;
    if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
    return false;
  };

  global.GyroControl = GyroControl;
})(typeof window !== 'undefined' ? window : this);
