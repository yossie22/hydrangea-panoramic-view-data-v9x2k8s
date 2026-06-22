/**
 * パノラマ用ジャイロ制御 v21
 * 縦画面: v13 そのまま
 * 横画面: 左右=コンパス、上下=beta 線形（iPhone/iPad で符号切替）
 * 起動待ち・感度低め・地面/空で固まったら基準リセット
 * 詳細: vendor/gyro-STABLE-v21.txt
 */
(function(global) {
  'use strict';

  var PITCH_SMOOTH = 0.17;
  var YAW_SMOOTH = 0.22;
  var PITCH_MAX_STEP = 0.032;
  var YAW_MAX_STEP = 0.040;
  var HEADING_SPIKE_DEG = 55;
  var SENSOR_LP = 0.22;
  var MAX_PITCH_OFF = Math.PI * 50 / 180;

  var LANDSCAPE_PITCH_SENSOR_LP = 0.14;
  var LANDSCAPE_PITCH_SMOOTH = 0.12;
  var LANDSCAPE_PITCH_MAX_STEP = 0.012;
  var LANDSCAPE_PITCH_GAIN = 0.34;
  var LANDSCAPE_PITCH_MAX = Math.PI * 42 / 180;
  var LANDSCAPE_PITCH_RATE = 0.014;
  var LANDSCAPE_PITCH_DEAD = Math.PI * 2 / 180;
  var LANDSCAPE_YAW_PITCH_SLIDE = 0.90;
  var LANDSCAPE_WARMUP = 12;
  var LANDSCAPE_STUCK_LIMIT = 1.06;
  var LANDSCAPE_STUCK_FRAMES = 28;
  var BUILD = 'v21';

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
  function normalizeAngle360(d) {
    d = d % 360;
    if (d < 0) d += 360;
    return d;
  }

  function isIPhoneDevice() {
    var ua = navigator.userAgent || '';
    if (/iPad/.test(ua)) return false;
    if (/iPhone|iPod/.test(ua)) return true;
    return false;
  }

  /** iPhone は上下符号を反転（iPad とは逆） */
  function landscapePitchSign() {
    return isIPhoneDevice() ? -1 : 1;
  }

  function getScreenAngleDeg() {
    if (global.screen && global.screen.orientation &&
        typeof global.screen.orientation.angle === 'number') {
      return global.screen.orientation.angle;
    }
    if (typeof global.orientation === 'number') return global.orientation;
    return 0;
  }

  function isPortraitScreen(screenAngleDeg) {
    var a = Math.round(normalizeAngle360(screenAngleDeg));
    return a === 0 || a === 180;
  }

  function readHeadingDegPortrait(rawEvent) {
    if (typeof rawEvent.webkitCompassHeading === 'number' &&
        !isNaN(rawEvent.webkitCompassHeading)) {
      return rawEvent.webkitCompassHeading;
    }
    if (rawEvent.alpha != null && !isNaN(rawEvent.alpha)) {
      return rawEvent.alpha;
    }
    return null;
  }

  function readHeadingDegLandscape(rawEvent, screenAngleDeg) {
    var raw = null;
    if (typeof rawEvent.webkitCompassHeading === 'number' &&
        !isNaN(rawEvent.webkitCompassHeading)) {
      raw = rawEvent.webkitCompassHeading;
    } else if (rawEvent.alpha != null && !isNaN(rawEvent.alpha)) {
      raw = rawEvent.alpha;
    }
    if (raw == null) return null;
    return normalizeAngle360(raw - screenAngleDeg);
  }

  function landscapePitchSampleRad(rawEvent) {
    if (rawEvent.beta == null || isNaN(rawEvent.beta)) return null;
    return degToRad(rawEvent.beta);
  }

  function resetOrientState(state) {
    state.initBeta = null;
    state.fBeta = null;
    state.initPitch = null;
    state.fPitch = null;
    state.initGamma = null;
    state.fGamma = null;
    state.prevHeading = null;
    state.initHeading = null;
    state.unwrappedHeading = 0;
    state.gammaYawDeg = 0;
    state.headingMode = true;
    state.lastHStepAbs = 0;
    state.prevPitchOff = 0;
    state.warmupPitch = null;
    state.stuckPitchFrames = 0;
  }

  function releaseLandscapePitchStick(state, displayPitch, base) {
    if (state.fPitch != null) state.initPitch = state.fPitch;
    if (base) base.viewPitch = displayPitch;
    state.prevPitchOff = 0;
    state.stuckPitchFrames = 0;
  }

  function trackYawFromHeading(heading, state) {
    var yawOff = 0;
    state.lastHStepAbs = 0;
    if (heading != null && state.prevHeading != null) {
      var hStep = heading - state.prevHeading;
      if (hStep > 180) hStep -= 360;
      if (hStep < -180) hStep += 360;
      state.lastHStepAbs = Math.abs(hStep);
      if (Math.abs(hStep) <= HEADING_SPIKE_DEG) {
        state.unwrappedHeading += hStep;
        state.prevHeading = heading;
      }
      if (state.initHeading != null) {
        yawOff = degToRad(state.unwrappedHeading - state.initHeading);
        state.headingMode = true;
      }
    }
    return yawOff;
  }

  function trackPortrait(rawEvent, state) {
    if (rawEvent.beta == null) return null;

    if (state.initBeta == null) {
      state.initBeta = rawEvent.beta;
      state.fBeta = rawEvent.beta;
      state.initGamma = rawEvent.gamma;
      state.fGamma = rawEvent.gamma;
      state.prevHeading = readHeadingDegPortrait(rawEvent);
      state.initHeading = state.prevHeading;
      state.unwrappedHeading = state.prevHeading != null ? state.prevHeading : 0;
      state.gammaYawDeg = 0;
      state.headingMode = state.prevHeading != null;
      return { ready: false };
    }

    state.fBeta = lp(state.fBeta, rawEvent.beta, SENSOR_LP);
    var pitchOff = clamp(degToRad(state.initBeta - state.fBeta), -MAX_PITCH_OFF, MAX_PITCH_OFF);

    var heading = readHeadingDegPortrait(rawEvent);
    var yawOff = trackYawFromHeading(heading, state);

    if (heading == null && rawEvent.gamma != null && state.initGamma != null) {
      state.fGamma = lp(state.fGamma, rawEvent.gamma, SENSOR_LP);
      state.gammaYawDeg = state.fGamma - state.initGamma;
      yawOff = degToRad(state.gammaYawDeg);
      state.headingMode = false;
    }

    return { ready: true, yawOff: yawOff, pitchOff: pitchOff, landscape: false };
  }

  function trackLandscape(rawEvent, screenAngleDeg, state) {
    var pitchSample = landscapePitchSampleRad(rawEvent);
    if (pitchSample == null) return null;

    if (state.initPitch == null) {
      if (!state.warmupPitch) state.warmupPitch = [];
      state.warmupPitch.push(pitchSample);
      if (state.warmupPitch.length < LANDSCAPE_WARMUP) return { ready: false };
      state.initPitch = state.warmupPitch[state.warmupPitch.length - 1];
      state.fPitch = state.initPitch;
      state.warmupPitch = null;
      state.initGamma = rawEvent.gamma;
      state.fGamma = rawEvent.gamma;
      state.prevHeading = readHeadingDegLandscape(rawEvent, screenAngleDeg);
      state.initHeading = state.prevHeading;
      state.unwrappedHeading = state.prevHeading != null ? state.prevHeading : 0;
      state.gammaYawDeg = 0;
      state.headingMode = state.prevHeading != null;
      state.lastHStepAbs = 0;
      state.prevPitchOff = 0;
      return { ready: false };
    }

    var heading = readHeadingDegLandscape(rawEvent, screenAngleDeg);
    var yawOff = trackYawFromHeading(heading, state);

    if (heading == null && rawEvent.gamma != null && state.initGamma != null) {
      state.fGamma = lp(state.fGamma, rawEvent.gamma, SENSOR_LP);
      state.gammaYawDeg = state.fGamma - state.initGamma;
      yawOff = degToRad(state.gammaYawDeg);
      state.headingMode = false;
    }

    if (state.lastHStepAbs > 0.7) {
      var drift = pitchSample - state.fPitch;
      state.initPitch += drift * LANDSCAPE_YAW_PITCH_SLIDE;
    }

    state.fPitch = lp(state.fPitch, pitchSample, LANDSCAPE_PITCH_SENSOR_LP);

    var delta = state.initPitch - state.fPitch;
    if (Math.abs(delta) < LANDSCAPE_PITCH_DEAD) delta = 0;
    var rawOff = landscapePitchSign() * delta * LANDSCAPE_PITCH_GAIN;
    var pitchOff = clamp(rawOff, -LANDSCAPE_PITCH_MAX, LANDSCAPE_PITCH_MAX);

    var prev = state.prevPitchOff || 0;
    pitchOff = clamp(pitchOff, prev - LANDSCAPE_PITCH_RATE, prev + LANDSCAPE_PITCH_RATE);
    state.prevPitchOff = pitchOff;

    return { ready: true, yawOff: yawOff, pitchOff: pitchOff, landscape: true };
  }

  function GyroControl(getView) {
    this.getView = getView;
    this.enabled = false;
    this.handlers = [];
    this.raf = null;
    this.latestEvent = null;
    this.base = null;
    this.onChange = null;
    this.hooks = {};
    this.orientState = null;
    this.displayYaw = 0;
    this.displayPitch = 0;
  }

  GyroControl.BUILD = BUILD;

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
    this.handlers.forEach(function(item) {
      if (item.target) {
        item.target.removeEventListener(item.type, item.fn);
      } else {
        global.removeEventListener(item.type, item.fn, item.capture === true);
      }
    });
    this.handlers = [];
    if (this.raf) {
      global.cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    this.latestEvent = null;
  };

  GyroControl.prototype._recalibrateForScreenRotate = function() {
    if (this.base) {
      this.base.viewYaw = this.displayYaw;
      this.base.viewPitch = this.displayPitch;
    }
    if (this.orientState) resetOrientState(this.orientState);
  };

  GyroControl.prototype._bindOrientation = function() {
    var self = this;
    var sensorFn = function(e) { self.latestEvent = e; };
    ['deviceorientationabsolute', 'deviceorientation'].forEach(function(type) {
      global.addEventListener(type, sensorFn, true);
      self.handlers.push({ type: type, fn: sensorFn, capture: true });
    });

    var rotateFn = function() {
      if (!self.enabled) return;
      self._recalibrateForScreenRotate();
    };
    global.addEventListener('orientationchange', rotateFn);
    self.handlers.push({ type: 'orientationchange', fn: rotateFn, capture: false });
    if (global.screen && global.screen.orientation &&
        typeof global.screen.orientation.addEventListener === 'function') {
      global.screen.orientation.addEventListener('change', rotateFn);
      self.handlers.push({
        type: 'change',
        fn: rotateFn,
        target: global.screen.orientation
      });
    }
  };

  GyroControl.prototype.stop = function() {
    var wasOn = this.enabled;
    this._cleanupListeners();
    this.base = null;
    this.orientState = null;
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
    this.displayYaw = view.yaw();
    this.displayPitch = view.pitch();
    if (!wasOn && this.hooks.onStart) this.hooks.onStart();

    var self = this;
    this.orientState = {
      initBeta: null,
      fBeta: null,
      initPitch: null,
      fPitch: null,
      initGamma: null,
      fGamma: null,
      prevHeading: null,
      initHeading: null,
      unwrappedHeading: 0,
      gammaYawDeg: 0,
      headingMode: true,
      lastScreenAngle: getScreenAngleDeg(),
      lastTrackMode: null,
      lastHStepAbs: 0,
      prevPitchOff: 0,
      warmupPitch: null,
      stuckPitchFrames: 0
    };

    this._bindOrientation();

    function tick() {
      if (!self.enabled) return;
      self.raf = global.requestAnimationFrame(tick);
      if (self.hooks.onTick) self.hooks.onTick();
      var v = self.getView();
      if (!v || !self.latestEvent || !self.orientState) return;

      var screenAngle = getScreenAngleDeg();
      var portrait = isPortraitScreen(screenAngle);
      var trackMode = portrait ? 'portrait' : 'landscape';

      if (self.orientState.lastScreenAngle !== screenAngle ||
          self.orientState.lastTrackMode !== trackMode) {
        self.orientState.lastScreenAngle = screenAngle;
        self.orientState.lastTrackMode = trackMode;
        self._recalibrateForScreenRotate();
        return;
      }

      var o = portrait
        ? trackPortrait(self.latestEvent, self.orientState)
        : trackLandscape(self.latestEvent, screenAngle, self.orientState);
      if (!o || !o.ready) return;

      if (o.landscape && Math.abs(self.displayPitch) >= LANDSCAPE_STUCK_LIMIT) {
        self.orientState.stuckPitchFrames++;
        if (self.orientState.stuckPitchFrames >= LANDSCAPE_STUCK_FRAMES) {
          releaseLandscapePitchStick(self.orientState, self.displayPitch, self.base);
        }
      } else {
        self.orientState.stuckPitchFrames = 0;
      }

      var targetYaw = self.base.viewYaw + o.yawOff;
      var relMax = o.landscape ? LANDSCAPE_PITCH_MAX : MAX_PITCH_OFF;
      var targetPitch = clamp(
        self.base.viewPitch + o.pitchOff,
        self.base.viewPitch - relMax,
        self.base.viewPitch + relMax
      );
      targetPitch = clamp(targetPitch, -Math.PI / 2, Math.PI / 2);

      var pitchSmooth = o.landscape ? LANDSCAPE_PITCH_SMOOTH : PITCH_SMOOTH;
      var pitchMaxStep = o.landscape ? LANDSCAPE_PITCH_MAX_STEP : PITCH_MAX_STEP;

      self.displayYaw = normalizeAngle(
        self.displayYaw + clamp(YAW_SMOOTH * angleDelta(self.displayYaw, targetYaw), -YAW_MAX_STEP, YAW_MAX_STEP)
      );
      self.displayPitch = clamp(
        self.displayPitch + clamp(pitchSmooth * (targetPitch - self.displayPitch), -pitchMaxStep, pitchMaxStep),
        -Math.PI / 2,
        Math.PI / 2
      );
      v.setYaw(self.displayYaw);
      v.setPitch(self.displayPitch);
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
