/**
 * パノラマ用ジャイロ制御 v6
 * 上下: beta（安定） / 左右: alpha ゆっくり追従 + 跳ね時は gamma 補助
 */
(function(global) {
  'use strict';

  var PITCH_SMOOTH = 0.17;
  var YAW_SMOOTH = 0.12;
  var PITCH_MAX_STEP = 0.032;
  var YAW_MAX_STEP = 0.022;
  var ALPHA_SPIKE_DEG = 68;
  var SENSOR_LP = 0.22;
  var YAW_OFF_MAX_DELTA = 0.028;

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
  function lp(prev, next, k) {
    return prev == null ? next : prev + k * (next - prev);
  }
  function screenOrientationAngle() {
    if (global.screen && global.screen.orientation && global.screen.orientation.angle != null) {
      return global.screen.orientation.angle;
    }
    return global.orientation || 0;
  }
  function yawOffFromGamma(initGamma, gamma, initBeta, beta) {
    var orient = screenOrientationAngle();
    if (orient === 90 || orient === -90 || orient === 270) {
      return degToRad(beta - initBeta);
    }
    return degToRad(gamma - initGamma);
  }

  function trackOrientation(e, state) {
    if (e.beta == null) return null;
    if (state.initBeta == null) {
      state.initBeta = e.beta;
      state.initGamma = e.gamma != null ? e.gamma : 0;
      state.fBeta = e.beta;
      state.fGamma = e.gamma != null ? e.gamma : 0;
      state.prevAlpha = e.alpha;
      state.unwrappedAlpha = e.alpha != null ? e.alpha : 0;
      state.initUnwrappedAlpha = state.unwrappedAlpha;
      state.yawOff = 0;
      return { ready: false };
    }

    state.fBeta = lp(state.fBeta, e.beta, SENSOR_LP);
    if (e.gamma != null) state.fGamma = lp(state.fGamma, e.gamma, SENSOR_LP);
    var pitchOff = degToRad(state.initBeta - state.fBeta);

    var yawOffAlpha = state.yawOff;
    var alphaBad = false;
    if (e.alpha != null && state.prevAlpha != null) {
      var alphaStep = e.alpha - state.prevAlpha;
      if (alphaStep > 180) alphaStep -= 360;
      if (alphaStep < -180) alphaStep += 360;
      if (Math.abs(alphaStep) > ALPHA_SPIKE_DEG || Math.abs(e.beta - 90) < 12) {
        alphaBad = true;
      } else {
        state.unwrappedAlpha += alphaStep;
        state.prevAlpha = e.alpha;
        yawOffAlpha = degToRad(state.initUnwrappedAlpha - state.unwrappedAlpha);
      }
    } else {
      alphaBad = true;
    }

    var yawOff = alphaBad
      ? yawOffFromGamma(state.initGamma, state.fGamma, state.initBeta, state.fBeta)
      : yawOffAlpha;

    var dy = yawOff - state.yawOff;
    dy = clamp(dy, -YAW_OFF_MAX_DELTA, YAW_OFF_MAX_DELTA);
    state.yawOff += dy;

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
      initGamma: 0,
      fBeta: null,
      fGamma: null,
      prevAlpha: null,
      unwrappedAlpha: 0,
      initUnwrappedAlpha: 0,
      yawOff: 0
    };

    this.handler = function(e) { self.latestEvent = e; };
    global.addEventListener('deviceorientation', this.handler, true);

    function tick() {
      if (!self.enabled) return;
      self.raf = global.requestAnimationFrame(tick);
      if (self.hooks.onTick) self.hooks.onTick();
      var v = self.getView();
      if (!v || !self.latestEvent) return;
      var o = trackOrientation(self.latestEvent, orientState);
      if (!o || !o.ready) return;
      var targetYaw = self.base.viewYaw + o.yawOff;
      var targetPitch = clamp(self.base.viewPitch + o.pitchOff, -Math.PI / 2, Math.PI / 2);
      displayYaw = normalizeAngle(
        displayYaw + clamp(YAW_SMOOTH * angleDelta(displayYaw, targetYaw), -YAW_MAX_STEP, YAW_MAX_STEP)
      );
      displayPitch = clamp(
        displayPitch + clamp(PITCH_SMOOTH * (targetPitch - displayPitch), -PITCH_MAX_STEP, PITCH_MAX_STEP),
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
