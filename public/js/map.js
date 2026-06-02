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

// ── Canvas overlay ─────────────────────────────────────────────────────────

// Defined as a factory so the class is evaluated only after Google Maps loads.
function createTransitHeatmap(googleMap) {
  class TransitHeatmap extends google.maps.OverlayView {
    constructor(map) {
      super();
      this.points = []; // [{lat, lng, time}] — time in seconds, null = no data
      this.setMap(map);
    }

    onAdd() {
      this.canvas = document.createElement('canvas');
      this.canvas.style.cssText = 'position:absolute;pointer-events:none;';
      this.getPanes().overlayLayer.appendChild(this.canvas);
    }

    setData(points) {
      this.points = points;
      this.draw();
    }

    clear() {
      this.points = [];
      if (this.canvas) {
        const ctx = this.canvas.getContext('2d');
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
    }

    draw() {
      const projection = this.getProjection();
      if (!projection || !this.points.length) return;

      const bounds = this.getMap().getBounds();
      if (!bounds) return;

      const sw = projection.fromLatLngToDivPixel(bounds.getSouthWest());
      const ne = projection.fromLatLngToDivPixel(bounds.getNorthEast());

      const L = Math.round(sw.x);
      const T = Math.round(ne.y);
      const W = Math.round(ne.x - sw.x);
      const H = Math.round(sw.y - ne.y);

      this.canvas.style.left = L + 'px';
      this.canvas.style.top  = T + 'px';
      this.canvas.width  = W;
      this.canvas.height = H;

      const ctx = this.canvas.getContext('2d');
      ctx.clearRect(0, 0, W, H);

      // Project all data points into canvas pixel space
      const pts = this.points
        .filter(p => p.time !== null)
        .map(p => {
          const pos = projection.fromLatLngToDivPixel(new google.maps.LatLng(p.lat, p.lng));
          return { x: pos.x - L, y: pos.y - T, time: p.time };
        });
      if (!pts.length) return;
      const times = pts.map(p => p.time);
      const minTime = Math.min(...times);
      const maxTime = Math.max(...times);

      // Estimate grid column spacing in pixels so we know the IDW influence radius
      const pa = projection.fromLatLngToDivPixel(new google.maps.LatLng(this.points[0].lat, this.points[0].lng));
      const pb = projection.fromLatLngToDivPixel(new google.maps.LatLng(this.points[1].lat, this.points[1].lng));
      const spacing   = Math.max(10, Math.abs(pb.x - pa.x));
      const maxDistSq = (spacing * 2.5) ** 2; // ignore points beyond 2.5 cell-widths

      // Render at 1/SCALE resolution then upscale — smooth result, ~16× fewer pixels to compute
      const SCALE = 4;
      const rW = Math.ceil(W / SCALE);
      const rH = Math.ceil(H / SCALE);

      if (!this._off) this._off = document.createElement('canvas');
      this._off.width  = rW;
      this._off.height = rH;

      const oCtx = this._off.getContext('2d');
      const img  = oCtx.createImageData(rW, rH);
      const d    = img.data;

      for (let py = 0; py < rH; py++) {
        for (let px = 0; px < rW; px++) {
          // Centre of this low-res pixel in full-res canvas coordinates
          const cx = (px + 0.5) * SCALE;
          const cy = (py + 0.5) * SCALE;

          // Inverse-distance weighting: nearby points dominate
          let wSum = 0, tSum = 0;
          for (const p of pts) {
            const dx = cx - p.x, dy = cy - p.y;
            const dist2 = dx * dx + dy * dy;
            if (dist2 > maxDistSq) continue;       // too far — skip
            if (dist2 < 1) { wSum = 1; tSum = p.time; break; } // on top of point
            const w = 1 / dist2;
            wSum += w;
            tSum += p.time * w;
          }

          if (wSum === 0) continue; // no nearby data — leave transparent

          const color = travelTimeToColor(tSum / wSum, minTime, maxTime);
          if (color.a === 0) continue;
          const idx = (py * rW + px) * 4;
          d[idx] = color.r;
          d[idx + 1] = color.g;
          d[idx + 2] = color.b;
          d[idx + 3] = color.a;
        }
      }

      oCtx.putImageData(img, 0, 0);

      // Upscale with bilinear smoothing — hides the low-res grid entirely
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this._off, 0, 0, W, H);
    }

    onRemove() {
      this.canvas.parentNode?.removeChild(this.canvas);
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
