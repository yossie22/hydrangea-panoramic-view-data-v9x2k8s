/**
 * VR画面用ミニ地図（丸表示・タップで拡大）
 * APP_DATA.mapConfig と各シーンの lat/lng を使用
 */
(function(global) {
  'use strict';

  var DEFAULT_CONFIG = {
    image: 'map.jpg',
    bounds: {
      topLeft: { lat: 33.52093, lng: 131.217184 },
      bottomRight: { lat: 33.520168, lng: 131.218755 }
    },
    pinOffset: { x: 0, y: 0 },
    insets: { left: 0, top: 0, right: 0, bottom: 0 }
  };

  function mercatorY(lat) {
    var r = lat * Math.PI / 180;
    return Math.log(Math.tan(Math.PI / 4 + r / 2));
  }

  function normalizeConfig(cfg) {
    cfg = cfg || {};
    var out = {
      image: cfg.image || DEFAULT_CONFIG.image,
      bounds: cfg.bounds || DEFAULT_CONFIG.bounds,
      pinOffset: cfg.pinOffset || DEFAULT_CONFIG.pinOffset,
      insets: cfg.insets || DEFAULT_CONFIG.insets,
      twoPoint: cfg.twoPoint || null
    };
    return out;
  }

  function gpsToPercent(lat, lng, config) {
    var bounds = config.bounds;
    var tp = config.twoPoint;
    var x;
    var y;
    if (tp && tp.p1 && tp.p2) {
      var p1 = tp.p1;
      var p2 = tp.p2;
      x = Math.abs(p2.lng - p1.lng) > 1e-12 ?
        p1.x + (lng - p1.lng) / (p2.lng - p1.lng) * (p2.x - p1.x) : p1.x;
      var y1 = mercatorY(p1.lat);
      var y2 = mercatorY(p2.lat);
      var ym = mercatorY(lat);
      if (Math.abs(y2 - y1) > 1e-12) {
        var s1 = p1.y / 100;
        var s2 = p2.y / 100;
        var sm = (ym - y1) / (y2 - y1);
        y = (s1 + sm * (s2 - s1)) * 100;
      } else {
        y = p1.y;
      }
    } else {
      var lngSpan = bounds.bottomRight.lng - bounds.topLeft.lng;
      var yTop = mercatorY(bounds.topLeft.lat);
      var yBot = mercatorY(bounds.bottomRight.lat);
      x = lngSpan ? (lng - bounds.topLeft.lng) / lngSpan * 100 : 0;
      y = (yTop - yBot) ? (yTop - mercatorY(lat)) / (yTop - yBot) * 100 : 0;
    }
    var il = config.insets.left || 0;
    var it = config.insets.top || 0;
    var ir = config.insets.right || 0;
    var ib = config.insets.bottom || 0;
    x = il + x * (100 - il - ir) / 100;
    y = it + y * (100 - it - ib) / 100;
    x += (config.pinOffset.x || 0);
    y += (config.pinOffset.y || 0);
    return { x: x, y: y };
  }

  function buildPinsFromAppData(appData) {
    var scenes = (appData && appData.scenes) || [];
    return scenes.filter(function(s) {
      return s && s.lat != null && s.lng != null &&
        !isNaN(Number(s.lat)) && !isNaN(Number(s.lng));
    }).map(function(s) {
      return {
        id: s.id,
        lat: Number(s.lat),
        lng: Number(s.lng),
        position: s.position != null ? Number(s.position) : 0,
        name: s.name || s.id
      };
    }).sort(function(a, b) {
      return a.position - b.position;
    });
  }

  function MiniMapWidget(rootEl, options) {
    this.rootEl = rootEl;
    this.config = normalizeConfig(options && options.config);
    this.pins = (options && options.pins) || [];
    this.expanded = false;
    this.diskEl = rootEl.querySelector('.mini-map-disk');
    this.imgEl = rootEl.querySelector('.mini-map-img');
    this.svgEl = rootEl.querySelector('.mini-map-overlay');
    if (this.imgEl && this.config.image) {
      this.imgEl.src = this.config.image;
    }
    this._renderStatic();
    var self = this;
    rootEl.addEventListener('click', function(e) {
      e.stopPropagation();
      self.toggleExpand();
      if (typeof self.onInteract === 'function') self.onInteract();
    });
  }

  MiniMapWidget.prototype.setPins = function(pins) {
    this.pins = pins || [];
    this._renderStatic();
  };

  MiniMapWidget.prototype.toggleExpand = function() {
    this.expanded = !this.expanded;
    this.rootEl.classList.toggle('is-expanded', this.expanded);
  };

  MiniMapWidget.prototype.collapse = function() {
    this.expanded = false;
    this.rootEl.classList.remove('is-expanded');
  };

  MiniMapWidget.prototype._renderStatic = function() {
    if (!this.svgEl) return;
    var pts = [];
    var pinDots = '';
    var i;
    var p;
    var pos;
    for (i = 0; i < this.pins.length; i++) {
      p = this.pins[i];
      pos = gpsToPercent(p.lat, p.lng, this.config);
      pts.push(pos.x + ',' + pos.y);
      pinDots += '<circle class="mini-map-pin-dot" cx="' + pos.x + '" cy="' + pos.y +
        '" r="2.2" data-id="' + p.id + '"></circle>';
    }
    var trail = pts.length >= 2 ?
      '<polyline class="mini-map-trail" points="' + pts.join(' ') + '"></polyline>' : '';
    this.svgEl.innerHTML =
      trail +
      pinDots +
      '<g class="mini-map-bearing-g" style="display:none">' +
      '<polygon class="mini-map-bearing-wedge" points="0,-7 4,4 -4,4"></polygon>' +
      '</g>' +
      '<circle class="mini-map-you-dot" r="3.2" style="display:none"></circle>';
    this.bearingG = this.svgEl.querySelector('.mini-map-bearing-g');
    this.youDot = this.svgEl.querySelector('.mini-map-you-dot');
  };

  MiniMapWidget.prototype.update = function(state) {
    state = state || {};
    if (!this.svgEl) return;
    var hasPos = state.lat != null && state.lng != null &&
      !isNaN(state.lat) && !isNaN(state.lng);
    var pos = hasPos ? gpsToPercent(state.lat, state.lng, this.config) : null;
    var yawDeg = state.yawDeg || 0;
    var northOff = state.northOff;
    var bearing = northOff != null && !isNaN(northOff) ? northOff + yawDeg : yawDeg;
    var activeId = state.sceneId || '';

    var pinEls = this.svgEl.querySelectorAll('.mini-map-pin-dot');
    var j;
    for (j = 0; j < pinEls.length; j++) {
      var isActive = pinEls[j].getAttribute('data-id') === activeId;
      pinEls[j].classList.toggle('is-active', isActive);
    }

    if (this.youDot) {
      if (hasPos && pos) {
        this.youDot.setAttribute('cx', pos.x);
        this.youDot.setAttribute('cy', pos.y);
        this.youDot.style.display = '';
      } else {
        this.youDot.style.display = 'none';
      }
    }

    if (this.bearingG) {
      if (hasPos && pos && state.showBearing !== false) {
        this.bearingG.setAttribute('transform',
          'translate(' + pos.x + ' ' + pos.y + ') rotate(' + bearing + ')');
        this.bearingG.style.display = '';
      } else {
        this.bearingG.style.display = 'none';
      }
    }
  };

  global.MiniMapWidget = MiniMapWidget;
  global.MiniMapGps = {
    mercatorY: mercatorY,
    gpsToPercent: gpsToPercent,
    buildPinsFromAppData: buildPinsFromAppData,
    normalizeConfig: normalizeConfig,
    DEFAULT_CONFIG: DEFAULT_CONFIG
  };
})(typeof window !== 'undefined' ? window : this);
