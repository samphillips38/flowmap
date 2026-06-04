// ── Grid generation ────────────────────────────────────────────────────────

// Default sample density: 16×12 = 192 points
const GRID_COLS = 16;
const GRID_ROWS = 12;
const LONDON_BOUNDS = { south: 51.30, north: 51.70, west: -0.52, east: 0.28 };

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

function distanceMeters(a, b) {
  const R = 6371000;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const hav = (sinLat * sinLat) + Math.cos(lat1) * Math.cos(lat2) * (sinLng * sinLng);
  return 2 * R * Math.asin(Math.sqrt(hav));
}

function generateGrid(bounds, options = {}) {
  const { south, north, west, east } = bounds;
  const cols = Math.max(4, options.cols ?? GRID_COLS);
  const rows = Math.max(4, options.rows ?? GRID_ROWS);
  const center = options.center || null;
  const radiusMeters = options.radiusMeters || null;
  const points = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const point = {
        lat: south + ((r + 0.5) / rows) * (north - south),
        lng: west  + ((c + 0.5) / cols) * (east  - west),
      };
      if (center && radiusMeters && distanceMeters(center, point) > radiusMeters) {
        continue;
      }
      points.push(point);
    }
  }
  return points;
}

// ── Colour scale ───────────────────────────────────────────────────────────

// Good areas: green and opaque. Slow areas: red and transparent.
function travelTimeToColor(seconds, minSeconds, maxSeconds) {
  const span = Math.max(1, maxSeconds - minSeconds);
  const ratio = Math.max(0, Math.min(1, (seconds - minSeconds) / span));
  const r = Math.round(34 + (239 - 34) * ratio);
  const g = Math.round(197 + (68 - 197) * ratio);
  const b = Math.round(94 + (68 - 94) * ratio);
  const a = Math.max(0, Math.round((1 - ratio) * 210));
  return { r, g, b, a };
}

function travelTimeToStrokeColor(seconds, minSeconds, maxSeconds) {
  const { r, g, b } = travelTimeToColor(seconds, minSeconds, maxSeconds);
  return `rgba(${r},${g},${b},0.95)`;
}

function lerp(a, b, t) {
  return a + ((b - a) * t);
}

function edgePoint(edgeIdx, x, y, t) {
  if (edgeIdx === 0) return { x: x + t, y };
  if (edgeIdx === 1) return { x: x + 1, y: y + t };
  if (edgeIdx === 2) return { x: x + 1 - t, y: y + 1 };
  return { x, y: y + 1 - t };
}

function drawContourLines(ctx, scalarField, width, height, levels, scale, minTime, maxTime) {
  if (!scalarField.length || !levels.length) return;
  const EPSILON = 1e-6;
  const edgeCorners = [
    [0, 1], // top: tl -> tr
    [1, 2], // right: tr -> br
    [2, 3], // bottom: br -> bl
    [3, 0], // left: bl -> tl
  ];
  const cornerValue = (value, level) => value > (level + EPSILON);
  const fillSmallHoles = sourceField => {
    const filled = sourceField.slice();
    const total = sourceField.length;
    for (let pass = 0; pass < 2; pass++) {
      let changed = false;
      for (let i = 0; i < total; i++) {
        if (filled[i] !== null) continue;
        const x = i % width;
        const y = Math.floor(i / width);
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const v = filled[ny * width + nx];
            if (v === null) continue;
            sum += v;
            count++;
          }
        }
        if (count >= 5) {
          filled[i] = sum / count;
          changed = true;
        }
      }
      if (!changed) break;
    }
    return filled;
  };
  const smoothedField = fillSmallHoles(scalarField);

  ctx.save();
  ctx.lineWidth = 1.4;
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 2;

  for (const level of levels) {
    ctx.strokeStyle = travelTimeToStrokeColor(level, minTime, maxTime);
    ctx.beginPath();
    for (let y = 0; y < height - 1; y++) {
      for (let x = 0; x < width - 1; x++) {
        const tl = smoothedField[y * width + x];
        const tr = smoothedField[y * width + (x + 1)];
        const br = smoothedField[(y + 1) * width + (x + 1)];
        const bl = smoothedField[(y + 1) * width + x];
        if (tl === null || tr === null || br === null || bl === null) continue;

        const values = [tl, tr, br, bl];
        const edgeHits = [];
        for (let edgeIdx = 0; edgeIdx < 4; edgeIdx++) {
          const [c0, c1] = edgeCorners[edgeIdx];
          const v0 = values[c0];
          const v1 = values[c1];
          const above0 = cornerValue(v0, level);
          const above1 = cornerValue(v1, level);
          if (above0 === above1) continue;
          const t = Math.max(0, Math.min(1, (level - v0) / (v1 - v0)));
          edgeHits.push({ edgeIdx, point: edgePoint(edgeIdx, x, y, t) });
        }

        if (edgeHits.length === 2) {
          const p1 = edgeHits[0].point;
          const p2 = edgeHits[1].point;
          ctx.moveTo((p1.x + 0.5) * scale, (p1.y + 0.5) * scale);
          ctx.lineTo((p2.x + 0.5) * scale, (p2.y + 0.5) * scale);
          continue;
        }

        if (edgeHits.length === 4) {
          const centerValue = (tl + tr + br + bl) / 4;
          const connectAcrossCenter = centerValue > level;
          const edgePointMap = new Map(edgeHits.map(hit => [hit.edgeIdx, hit.point]));
          const pairs = connectAcrossCenter
            ? [[0, 1], [2, 3]]
            : [[0, 3], [1, 2]];
          for (const [a, b] of pairs) {
            const p1 = edgePointMap.get(a);
            const p2 = edgePointMap.get(b);
            if (!p1 || !p2) continue;
            ctx.moveTo((p1.x + 0.5) * scale, (p1.y + 0.5) * scale);
            ctx.lineTo((p2.x + 0.5) * scale, (p2.y + 0.5) * scale);
          }
        }
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}

// ── Canvas overlay ─────────────────────────────────────────────────────────

// Build a lat/lng scalar field once; pan/zoom only re-samples it (no per-frame IDW).
function buildGeoScalarField(renderPoints) {
  if (!renderPoints.length) return null;

  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let west = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  for (const p of renderPoints) {
    if (p.lat < south) south = p.lat;
    if (p.lat > north) north = p.lat;
    if (p.lng < west) west = p.lng;
    if (p.lng > east) east = p.lng;
  }

  const latSpan = Math.max(0.0005, north - south);
  const lngSpan = Math.max(0.0005, east - west);
  const padLat = latSpan * 0.08;
  const padLng = lngSpan * 0.08;
  south -= padLat;
  north += padLat;
  west -= padLng;
  east += padLng;

  const aspect = lngSpan / latSpan;
  const geoCols = Math.min(128, Math.max(36, Math.round(Math.sqrt(renderPoints.length) * 5)));
  const geoRows = Math.min(128, Math.max(36, Math.round(geoCols / Math.max(0.35, aspect))));

  const midLat = (south + north) / 2;
  const latM = (north - south) * 111320;
  const lngM = (east - west) * 111320 * Math.max(0.2, Math.abs(Math.cos(toRadians(midLat))));
  const typicalSpacingM = Math.sqrt((latM * lngM) / Math.max(1, renderPoints.length));
  const influenceM = typicalSpacingM * 2.5;

  const values = new Float32Array(geoCols * geoRows);
  values.fill(Number.NaN);

  for (let gy = 0; gy < geoRows; gy++) {
    for (let gx = 0; gx < geoCols; gx++) {
      const lat = south + ((gy + 0.5) / geoRows) * (north - south);
      const lng = west + ((gx + 0.5) / geoCols) * (east - west);
      const sample = { lat, lng };

      let wSum = 0;
      let tSum = 0;
      for (const p of renderPoints) {
        const distM = distanceMeters(sample, p);
        if (distM > influenceM) continue;
        if (distM < 8) {
          wSum = 1;
          tSum = p.time;
          break;
        }
        const w = 1 / (distM * distM);
        wSum += w;
        tSum += p.time * w;
      }
      if (wSum > 0) values[gy * geoCols + gx] = tSum / wSum;
    }
  }

  return { south, north, west, east, geoCols, geoRows, values };
}

function sampleGeoField(geo, lat, lng) {
  if (lat < geo.south || lat > geo.north || lng < geo.west || lng > geo.east) return null;

  const { geoCols, geoRows, values } = geo;
  const fx = ((lng - geo.west) / (geo.east - geo.west)) * geoCols - 0.5;
  const fy = ((lat - geo.south) / (geo.north - geo.south)) * geoRows - 0.5;
  if (fx < 0 || fy < 0 || fx > geoCols - 1 || fy > geoRows - 1) return null;

  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, geoCols - 1);
  const y1 = Math.min(y0 + 1, geoRows - 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const v00 = values[y0 * geoCols + x0];
  const v10 = values[y0 * geoCols + x1];
  const v01 = values[y1 * geoCols + x0];
  const v11 = values[y1 * geoCols + x1];

  let wSum = 0;
  let tSum = 0;
  const corners = [
    [v00, (1 - tx) * (1 - ty)],
    [v10, tx * (1 - ty)],
    [v01, (1 - tx) * ty],
    [v11, tx * ty],
  ];
  for (const [v, w] of corners) {
    if (!Number.isFinite(v) || w <= 0) continue;
    wSum += w;
    tSum += v * w;
  }
  return wSum > 0 ? tSum / wSum : null;
}

function latLngAtCanvasPoint(cornerLatLng, cx, cy, W, H) {
  const tx = cx / W;
  const ty = cy / H;
  const lat = (1 - tx) * (1 - ty) * cornerLatLng.tl.lat
    + tx * (1 - ty) * cornerLatLng.tr.lat
    + (1 - tx) * ty * cornerLatLng.bl.lat
    + tx * ty * cornerLatLng.br.lat;
  const lng = (1 - tx) * (1 - ty) * cornerLatLng.tl.lng
    + tx * (1 - ty) * cornerLatLng.tr.lng
    + (1 - tx) * ty * cornerLatLng.bl.lng
    + tx * ty * cornerLatLng.br.lng;
  return { lat, lng };
}

// Defined as a factory so the class is evaluated only after Google Maps loads.
function createTransitHeatmap(googleMap) {
  const MIN_RENDER_SCALE = 2;
  const TARGET_PIXELS_IDLE = 140000;
  const TARGET_PIXELS_INTERACT = 90000;

  class TransitHeatmap extends google.maps.OverlayView {
    constructor(map) {
      super();
      this.renderPoints = [];
      this.geoCache = null;
      this.minTime = 0;
      this.maxTime = 1;
      this.displayMode = 'both';
      this.isInteracting = false;
      this._off = null;
      this.setMap(map);
    }

    onAdd() {
      this.canvas = document.createElement('canvas');
      this.canvas.style.cssText = 'position:absolute;pointer-events:none;';
      this.getPanes().overlayLayer.appendChild(this.canvas);
    }

    setData(points) {
      this.renderPoints = points.filter(point => point.time !== null);
      if (!this.renderPoints.length) {
        this.minTime = 0;
        this.maxTime = 1;
        this.geoCache = null;
      } else {
        let minTime = Number.POSITIVE_INFINITY;
        let maxTime = Number.NEGATIVE_INFINITY;
        for (const point of this.renderPoints) {
          if (point.time < minTime) minTime = point.time;
          if (point.time > maxTime) maxTime = point.time;
        }
        this.minTime = minTime;
        this.maxTime = maxTime;
        this.geoCache = buildGeoScalarField(this.renderPoints);
      }
      this.requestPaint();
    }

    clear() {
      this.renderPoints = [];
      this.geoCache = null;
      if (this.canvas) {
        const ctx = this.canvas.getContext('2d');
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
    }

    setDisplayMode(mode) {
      const valid = ['both', 'heatmap', 'contours'];
      this.displayMode = valid.includes(mode) ? mode : 'both';
      this.requestPaint();
    }

    beginInteraction() {
      this.isInteracting = true;
    }

    endInteraction() {
      this.isInteracting = false;
      if (!this.getProjection()) return;
      this.paint();
      requestAnimationFrame(() => {
        if (!this.isInteracting) this.paint();
      });
    }

    requestPaint() {
      if (this.getProjection()) this.paint();
    }

    draw() {
      this.paint();
    }

    buildScalarField(cornerLatLng, W, H, SCALE, rW, rH, fillHeatmap) {
      const scalarField = new Array(rW * rH).fill(null);
      if (!this._off) this._off = document.createElement('canvas');
      this._off.width = rW;
      this._off.height = rH;

      const oCtx = this._off.getContext('2d');
      let img = null;
      let d = null;
      if (fillHeatmap) {
        img = oCtx.createImageData(rW, rH);
        d = img.data;
      }

      for (let py = 0; py < rH; py++) {
        for (let px = 0; px < rW; px++) {
          const cx = (px + 0.5) * SCALE;
          const cy = (py + 0.5) * SCALE;
          const { lat, lng } = latLngAtCanvasPoint(cornerLatLng, cx, cy, W, H);
          const value = sampleGeoField(this.geoCache, lat, lng);
          if (value === null) continue;

          scalarField[py * rW + px] = value;
          if (!fillHeatmap) continue;
          const color = travelTimeToColor(value, this.minTime, this.maxTime);
          if (color.a === 0) continue;
          const idx = (py * rW + px) * 4;
          d[idx] = color.r;
          d[idx + 1] = color.g;
          d[idx + 2] = color.b;
          d[idx + 3] = color.a;
        }
      }

      return { scalarField, img };
    }

    paint() {
      const projection = this.getProjection();
      if (!projection || !this.renderPoints.length || !this.geoCache) return;

      const bounds = this.getMap().getBounds();
      if (!bounds) return;

      const sw = projection.fromLatLngToDivPixel(bounds.getSouthWest());
      const ne = projection.fromLatLngToDivPixel(bounds.getNorthEast());

      const L = Math.floor(sw.x);
      const T = Math.floor(ne.y);
      const W = Math.ceil(ne.x - sw.x);
      const H = Math.ceil(sw.y - ne.y);
      if (W <= 0 || H <= 0) return;

      this.canvas.style.left = L + 'px';
      this.canvas.style.top = T + 'px';
      this.canvas.style.width = W + 'px';
      this.canvas.style.height = H + 'px';
      if (this.canvas.width !== W || this.canvas.height !== H) {
        this.canvas.width = W;
        this.canvas.height = H;
      }

      const boundsNe = bounds.getNorthEast();
      const boundsSw = bounds.getSouthWest();
      const cornerLatLng = {
        tl: { lat: boundsNe.lat(), lng: boundsSw.lng() },
        tr: { lat: boundsNe.lat(), lng: boundsNe.lng() },
        bl: { lat: boundsSw.lat(), lng: boundsSw.lng() },
        br: { lat: boundsSw.lat(), lng: boundsNe.lng() },
      };

      const targetPixels = this.isInteracting ? TARGET_PIXELS_INTERACT : TARGET_PIXELS_IDLE;
      const dynamicScale = Math.ceil(Math.sqrt((W * H) / targetPixels));
      const SCALE = Math.max(MIN_RENDER_SCALE, dynamicScale);
      const rW = Math.ceil(W / SCALE);
      const rH = Math.ceil(H / SCALE);

      const showHeatmap = this.displayMode === 'both' || this.displayMode === 'heatmap';
      const showContours = this.displayMode === 'both' || this.displayMode === 'contours';

      const { scalarField, img } = this.buildScalarField(
        cornerLatLng, W, H, SCALE, rW, rH, showHeatmap
      );

      const ctx = this.canvas.getContext('2d', { alpha: true });
      ctx.clearRect(0, 0, W, H);

      if (showHeatmap && img) {
        this._off.getContext('2d').putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = this.isInteracting ? 'medium' : 'high';
        ctx.drawImage(this._off, 0, 0, W, H);
      }

      if (showContours && this.maxTime > this.minTime) {
        const bandCount = 5;
        const levels = [];
        for (let i = 1; i < bandCount; i++) {
          levels.push(lerp(this.minTime, this.maxTime, i / bandCount));
        }
        drawContourLines(ctx, scalarField, rW, rH, levels, SCALE, this.minTime, this.maxTime);
      }
    }

    onRemove() {
      this.canvas?.parentNode?.removeChild(this.canvas);
    }
  }

  return new TransitHeatmap(googleMap);
}

// ── Dark map style ─────────────────────────────────────────────────────────

const DARK_MAP_STYLE = [
  { elementType: 'geometry',             stylers: [{ color: '#212121' }] },
  { elementType: 'labels.icon',          stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill',     stylers: [{ color: '#757575' }] },
  { elementType: 'labels.text.stroke',   stylers: [{ color: '#212121' }] },
  { featureType: 'administrative',       elementType: 'geometry',           stylers: [{ color: '#757575' }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#bdbdbd' }] },
  { featureType: 'poi.park',             elementType: 'geometry',           stylers: [{ color: '#181818' }] },
  { featureType: 'road',                 elementType: 'geometry.fill',      stylers: [{ color: '#2c2c2c' }] },
  { featureType: 'road',                 elementType: 'labels.text.fill',   stylers: [{ color: '#8a8a8a' }] },
  { featureType: 'road.arterial',        elementType: 'geometry',           stylers: [{ color: '#373737' }] },
  { featureType: 'road.highway',         elementType: 'geometry',           stylers: [{ color: '#3c3c3c' }] },
  { featureType: 'transit',              elementType: 'labels.text.fill',   stylers: [{ color: '#757575' }] },
  { featureType: 'water',                elementType: 'geometry',           stylers: [{ color: '#000000' }] },
  { featureType: 'water',                elementType: 'labels.text.fill',   stylers: [{ color: '#3d3d3d' }] },
];
