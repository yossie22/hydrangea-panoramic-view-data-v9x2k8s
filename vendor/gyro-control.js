/**
 * パノラマ用ジャイロ制御 v44
 * 統一クォータニオン（THREE.js DeviceOrientation 方式）
 * 縦横切替で基準リセットなし。水平線を世界基準で維持。
 * 詳細: vendor/gyro-STABLE-v44.txt
 */
(function(global) {
  'use strict';

  var PITCH_SMOOTH = 0.17;
  var YAW_SMOOTH = 0.22;
  var PITCH_MAX_STEP = 0.032;
  var YAW_MAX_STEP = 0.040;
  var MAX_PITCH_UP = Math.PI * 82 / 180;
  var MAX_PITCH_DOWN = Math.PI * 82 / 180;
  var TRACK_WARMUP_FRAMES = 15;
  var BUILD = 'v44';

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

  function getScreenAngleDeg() {
    if (global.screen && global.screen.orientation &&
        typeof global.screen.orientation.angle === 'number') {
      return global.screen.orientation.angle;
    }
    if (typeof global.orientation === 'number') return global.orientation;
    return 0;
  }

  function qNormalize(q) {
    var len = Math.sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z);
    if (len < 1e-8) return { w: 1, x: 0, y: 0, z: 0 };
    return { w: q.w / len, x: q.x / len, y: q.y / len, z: q.z / len };
  }

  function qMul(a, b) {
    return qNormalize({
      w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
      x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w
    });
  }

  function qConj(q) {
    return { w: q.w, x: -q.x, y: -q.y, z: -q.z };
  }

  function qFromAxisAngle(ax, ay, az, angleRad) {
    var half = angleRad * 0.5;
    var s = Math.sin(half);
    return qNormalize({
      w: Math.cos(half),
      x: ax * s,
      y: ay * s,
      z: az * s
    });
  }

  /** THREE.js DeviceOrientationControls と同じ順序 */
  function eulerYXZToQuat(beta, alpha, negGamma) {
    var c1 = Math.cos(beta * 0.5);
    var s1 = Math.sin(beta * 0.5);
    var c2 = Math.cos(alpha * 0.5);
    var s2 = Math.sin(alpha * 0.5);
    var c3 = Math.cos(negGamma * 0.5);
    var s3 = Math.sin(negGamma * 0.5);
    return qNormalize({
      w: c1 * c2 * c3 + s1 * s2 * s3,
      x: s1 * c2 * c3 + c1 * s2 * s3,
      y: c1 * s2 * c3 - s1 * c2 * s3,
      z: c1 * c2 * s3 - s1 * s2 * c3
    });
  }

  function alphaRad(rawEvent) {
    if (typeof rawEvent.webkitCompassHeading === 'number' &&
        !isNaN(rawEvent.webkitCompassHeading)) {
      return degToRad(rawEvent.webkitCompassHeading);
    }
    if (rawEvent.alpha != null && !isNaN(rawEvent.alpha)) {
      return degToRad(rawEvent.alpha);
    }
    return 0;
  }

  /** 画面角度を毎フレーム補正（縦横で基準を変えない） */
  function buildDeviceQuaternion(rawEvent, screenAngleDeg) {
    if (rawEvent.beta == null || rawEvent.gamma == null) return null;
    var beta = degToRad(rawEvent.beta);
    var gamma = degToRad(rawEvent.gamma);
    var alpha = alphaRad(rawEvent);
    var q = eulerYXZToQuat(beta, alpha, -gamma);
    var qFix = qFromAxisAngle(1, 0, 0, -Math.PI / 2);
    var qScreen = qFromAxisAngle(0, 0, 1, -degToRad(screenAngleDeg));
    return qMul(qMul(q, qFix), qScreen);
  }

  function quatToYawPitch(q) {
    var sinp = 2 * (q.w * q.x - q.y * q.z);
    var pitch = Math.asin(clamp(sinp, -1, 1));
    var siny = 2 * (q.w * q.y + q.x * q.z);
    var cosy = 1 - 2 * (q.x * q.x + q.y * q.y);
    var yaw = Math.atan2(siny, cosy);
    return { yaw: yaw, pitch: pitch };
  }

  function trackUnified(rawEvent, screenAngleDeg, state) {
    var qCurr = buildDeviceQuaternion(rawEvent, screenAngleDeg);
    if (!qCurr) return null;

    if (state.qWarmup < TRACK_WARMUP_FRAMES) {
      state.qWarmup += 1;
      return { ready: false };
    }

    if (!state.trackingReady) {
      state.qInit = qCurr;
      state.trackingReady = true;
      return {
        ready: true,
        yawOff: 0,
        pitchOff: 0,
        pitchDownMax: MAX_PITCH_DOWN,
        pitchUpMax: MAX_PITCH_UP
      };
    }

    var qRel = qMul(qConj(state.qInit), qCurr);
    var yp = quatToYawPitch(qRel);
    return {
      ready: true,
      yawOff: normalizeAngle(-yp.yaw),
      pitchOff: clamp(-yp.pitch, -MAX_PITCH_DOWN, MAX_PITCH_UP),
      pitchDownMax: MAX_PITCH_DOWN,
      pitchUpMax: MAX_PITCH_UP
    };
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

  GyroControl.prototype._bindOrientation = function() {
    var self = this;
    var sensorFn = function(e) { self.latestEvent = e; };
    ['deviceorientationabsolute', 'deviceorientation'].forEach(function(type) {
      global.addEventListener(type, sensorFn, true);
      self.handlers.push({ type: type, fn: sensorFn, capture: true });
    });
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
      qInit: null,
      qWarmup: 0,
      trackingReady: false
    };

    this._bindOrientation();

    function tick() {
      if (!self.enabled) return;
      self.raf = global.requestAnimationFrame(tick);
      if (self.hooks.onTick) self.hooks.onTick();
      var v = self.getView();
      if (!v || !self.latestEvent || !self.orientState || !self.base) return;

      var screenAngle = getScreenAngleDeg();
      var o = trackUnified(self.latestEvent, screenAngle, self.orientState);
      if (!o || !o.ready) return;

      var targetYaw = self.base.viewYaw + o.yawOff;
      var targetPitch = clamp(
        self.base.viewPitch + o.pitchOff,
        self.base.viewPitch - o.pitchDownMax,
        self.base.viewPitch + o.pitchUpMax
      );
      targetPitch = clamp(targetPitch, -Math.PI / 2, Math.PI / 2);

      self.displayYaw = normalizeAngle(
        self.displayYaw + clamp(YAW_SMOOTH * angleDelta(self.displayYaw, targetYaw), -YAW_MAX_STEP, YAW_MAX_STEP)
      );
      self.displayPitch = clamp(
        self.displayPitch + clamp(PITCH_SMOOTH * (targetPitch - self.displayPitch), -PITCH_MAX_STEP, PITCH_MAX_STEP),
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
