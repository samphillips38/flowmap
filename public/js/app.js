// ── Constants ──────────────────────────────────────────────────────────────

const LOCATION_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#06b6d4'];
const DEST_BATCH = 25; // Distance Matrix API max destinations per request
const HEATMAP_HISTORY_KEY = 'transitHeatmapHistoryV1';
const MAX_HISTORY_ITEMS = 20;

// ── State ──────────────────────────────────────────────────────────────────

let googleMap, heatmapOverlay, matrixService;
let combineMode = 'sum';
let locations = [];
let nextId = 1;
let markers = [];
let samplingCenter = null;
let samplingRadiusKm = 8;
let samplingTargetPoints = 200;
let samplingMode = 'radius';
let samplingBounds = { ...LONDON_BOUNDS };
let samplingEditMode = true;
let samplingCircle = null;
let samplingRectangle = null;
let samplingCenterMarker = null;
let samplingPreviewDots = [];
let samplingAreaVisible = true;
let mapClickListener = null;
let syncingSamplingVisuals = false;
let suppressMapClickUntil = 0;
let heatmapHistory = [];
let latestHeatmapData = null;
let selectedHeatmapLocationIdxs = [];

function newLocation() {
  return {
    id: nextId++,
    name: '',
    coords: null,
    weight: 1,
    transport: 'TRANSIT',
    departTime: '09:00',
    departDay: '1',
    maxTravelMins: null,
  };
}

// ── Entry point (Google Maps callback) ────────────────────────────────────

window.initApp = function () {
  googleMap = new google.maps.Map(document.getElementById('map'), {
    center: { lat: 51.505, lng: -0.09 },
    zoom: 11,
    styles: DARK_MAP_STYLE,
    disableDefaultUI: false,
    zoomControl: true,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
  });

  heatmapOverlay = createTransitHeatmap(googleMap);
  matrixService   = new google.maps.DistanceMatrixService();

  googleMap.addListener('idle', () => {
    heatmapOverlay.draw();
  });

  addLocation();
  initSamplingDefaults();
  setupEventListeners();
  renderLocationList();
  updateSearchBtn();
  loadHeatmapHistory();
  renderHistoryList();
  updateSamplingPreview();
};

// ── UI event wiring ────────────────────────────────────────────────────────

function setupEventListeners() {
  document.getElementById('add-location-btn').addEventListener('click', () => {
    if (locations.length < 6) { addLocation(); }
  });

  document.getElementById('combine-mode').addEventListener('click', e => {
    const btn = e.target.closest('.segment-btn');
    if (!btn) return;
    const nextMode = btn.dataset.value;
    if (!nextMode || nextMode === combineMode) return;
    setSegmentedValue('combine-mode', nextMode);
    combineMode = nextMode;
    renderLocationList();
    if (latestHeatmapData?.timesMatrix?.length) {
      renderHeatmapViewControls();
      applySelectedHeatmapLocations();
      return;
    }
    clearResults();
  });

  document.getElementById('heatmap-view-controls').addEventListener('click', e => {
    const cell = e.target.closest('.heatmap-location-cell');
    if (!cell) return;
    const locationIdx = Number.parseInt(cell.dataset.locationIdx, 10);
    if (!Number.isFinite(locationIdx)) return;

    const isSelected = selectedHeatmapLocationIdxs.includes(locationIdx);
    if (!isSelected) {
      selectedHeatmapLocationIdxs.push(locationIdx);
    } else {
      const remaining = selectedHeatmapLocationIdxs.filter(idx => idx !== locationIdx);
      if (!remaining.length) {
        return;
      }
      selectedHeatmapLocationIdxs = remaining;
    }

    selectedHeatmapLocationIdxs.sort((a, b) => a - b);
    renderHeatmapViewControls();
    applySelectedHeatmapLocations();
  });

  document.getElementById('sampling-space-mode').addEventListener('click', e => {
    const btn = e.target.closest('.segment-btn');
    if (!btn) return;
    const nextMode = btn.dataset.value;
    if (!nextMode || nextMode === samplingMode) return;
    setSegmentedValue('sampling-space-mode', nextMode);
    samplingMode = nextMode;
    toggleSamplingModeUI();
    updateSamplingPreview();
    clearResults();
  });

  document.getElementById('sampling-density').addEventListener('input', e => {
    samplingTargetPoints = parseInt(e.target.value, 10);
    document.getElementById('sampling-density-display').textContent = `${samplingTargetPoints}`;
    updateSamplingPreview();
    clearResults();
  });

  document.getElementById('sampling-radius-km').addEventListener('input', e => {
    samplingRadiusKm = parseFloat(e.target.value);
    document.getElementById('sampling-radius-display').textContent = `${samplingRadiusKm.toFixed(1)} km`;
    updateSamplingPreview();
    clearResults();
  });

  document.getElementById('sampling-visibility-toggle').addEventListener('click', e => {
    const btn = e.target.closest('.segment-btn');
    if (!btn) return;
    const visibilityValue = btn.dataset.value;
    if (!visibilityValue) return;
    setSegmentedValue('sampling-visibility-toggle', visibilityValue);
    samplingAreaVisible = visibilityValue === 'show';
    toggleSamplingModeUI();
  });

  document.getElementById('history-list').addEventListener('click', e => {
    const button = e.target.closest('.history-btn');
    if (!button) return;
    const id = button.dataset.id;
    if (!id) return;
    if (button.classList.contains('load')) {
      loadHistoryEntry(id);
      return;
    }
    if (button.classList.contains('delete')) {
      deleteHistoryEntry(id);
    }
  });

  document.getElementById('search-btn').addEventListener('click', runSearch);
}

// ── Location management ────────────────────────────────────────────────────

function addLocation(render = true) {
  locations.push(newLocation());
  if (render) { renderLocationList(); updateSearchBtn(); }
}

function applyStateWithoutClearing(entry) {
  combineMode = entry.combineMode || 'sum';
  setSegmentedValue('combine-mode', combineMode);
  latestHeatmapData = null;
  selectedHeatmapLocationIdxs = [];

  locations = (entry.locations || []).map((loc, idx) => ({
    id: idx + 1,
    name: loc.name || '',
    coords: loc.coords ? { ...loc.coords } : null,
    weight: Number.isFinite(loc.weight) && loc.weight > 0 ? loc.weight : 1,
    transport: loc.transport || 'TRANSIT',
    departTime: loc.departTime || '09:00',
    departDay: typeof loc.departDay === 'string' ? loc.departDay : '1',
    maxTravelMins: Number.isFinite(loc.maxTravelMins) && loc.maxTravelMins > 0 ? loc.maxTravelMins : null,
  }));
  if (!locations.length) locations.push(newLocation());
  nextId = Math.max(...locations.map(l => l.id)) + 1;
  renderLocationList();
  refreshMarkers();
  updateSearchBtn();

  samplingMode = entry.samplingMode || 'radius';
  samplingTargetPoints = Number.isFinite(entry.samplingTargetPoints) ? entry.samplingTargetPoints : samplingTargetPoints;
  samplingRadiusKm = Number.isFinite(entry.samplingRadiusKm) ? entry.samplingRadiusKm : samplingRadiusKm;
  samplingCenter = entry.samplingCenter ? { ...entry.samplingCenter } : samplingCenter;
  samplingBounds = entry.samplingBounds ? { ...entry.samplingBounds } : samplingBounds;
  samplingAreaVisible = entry.samplingAreaVisible !== false;

  document.getElementById('sampling-density').value = String(samplingTargetPoints);
  document.getElementById('sampling-density-display').textContent = `${samplingTargetPoints}`;
  document.getElementById('sampling-radius-km').value = String(samplingRadiusKm);
  document.getElementById('sampling-radius-display').textContent = `${samplingRadiusKm.toFixed(1)} km`;
  setSegmentedValue('sampling-space-mode', samplingMode);
  setSegmentedValue('sampling-visibility-toggle', samplingAreaVisible ? 'show' : 'hide');
  toggleSamplingModeUI();
}

function removeLocation(id) {
  locations = locations.filter(l => l.id !== id);
  renderLocationList();
  updateSearchBtn();
  refreshMarkers();
}

function setCoords(id, coords) {
  const loc = locations.find(l => l.id === id);
  if (!loc) return;
  loc.coords = coords;
  loc.name   = coords.name;
  updateSearchBtn();
  refreshMarkers();
}

function setWeight(id, weight) {
  const loc = locations.find(l => l.id === id);
  if (!loc) return;
  loc.weight = Number.isFinite(weight) && weight > 0 ? weight : 1;
  if (combineMode === 'weighted-sum' && latestHeatmapData?.timesMatrix?.length) {
    applySelectedHeatmapLocations();
  }
}

function setLocationConfig(id, key, value) {
  const loc = locations.find(l => l.id === id);
  if (!loc) return;
  loc[key] = value;
}

function refreshMarkers() {
  markers.forEach(m => m.setMap(null));
  markers = [];

  locations.forEach((loc, i) => {
    if (!loc.coords) return;
    const color = LOCATION_COLORS[i % LOCATION_COLORS.length];

    const marker = new google.maps.Marker({
      position: { lat: loc.coords.lat, lng: loc.coords.lng },
      map: googleMap,
      title: loc.name,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 8,
        fillColor: color,
        fillOpacity: 1,
        strokeColor: '#ffffff',
        strokeWeight: 2,
      },
      zIndex: 100,
    });
    markers.push(marker);
  });
}

function renderLocationList() {
  const list = document.getElementById('locations-list');
  list.innerHTML = '';

  locations.forEach((loc, i) => {
    const color = LOCATION_COLORS[i % LOCATION_COLORS.length];
    const label = `Location ${i + 1}`;
    const canRemove = locations.length > 1;

    const item = document.createElement('div');
    item.className = 'location-item';
    item.innerHTML = `
      <div class="location-label-row">
        <div class="location-dot" style="background:${color}"></div>
        <span class="location-name-label">${label}</span>
        ${canRemove ? `<button class="remove-btn" data-id="${loc.id}" title="Remove">×</button>` : ''}
      </div>
      <input
        class="location-input${loc.coords ? ' confirmed' : ''}"
        type="text"
        placeholder="Search for an address…"
        value="${loc.name || ''}"
        autocomplete="off"
        spellcheck="false"
      >
      <details class="location-advanced">
        <summary>Advanced</summary>
        <div class="location-config-grid">
          <div class="field">
            <label>Transport</label>
            <select class="location-transport">
              <option value="TRANSIT" ${loc.transport === 'TRANSIT' ? 'selected' : ''}>Transit</option>
              <option value="WALKING" ${loc.transport === 'WALKING' ? 'selected' : ''}>Walking</option>
              <option value="BICYCLING" ${loc.transport === 'BICYCLING' ? 'selected' : ''}>Cycling</option>
              <option value="DRIVING" ${loc.transport === 'DRIVING' ? 'selected' : ''}>Driving</option>
            </select>
          </div>
          <div class="field">
            <label>Max time (min)</label>
            <input class="location-max-time" type="number" min="1" step="1" placeholder="No cap" value="${loc.maxTravelMins ?? ''}">
          </div>
          <div class="field">
            <label>Departure time</label>
            <input class="location-depart-time" type="time" value="${loc.departTime}">
          </div>
          <div class="field">
            <label>Departure day</label>
            <select class="location-depart-day">
              <option value="1" ${loc.departDay === '1' ? 'selected' : ''}>Monday</option>
              <option value="2" ${loc.departDay === '2' ? 'selected' : ''}>Tuesday</option>
              <option value="3" ${loc.departDay === '3' ? 'selected' : ''}>Wednesday</option>
              <option value="4" ${loc.departDay === '4' ? 'selected' : ''}>Thursday</option>
              <option value="5" ${loc.departDay === '5' ? 'selected' : ''}>Friday</option>
              <option value="6" ${loc.departDay === '6' ? 'selected' : ''}>Saturday</option>
              <option value="0" ${loc.departDay === '0' ? 'selected' : ''}>Sunday</option>
            </select>
          </div>
        </div>
      </details>
    `;

    const input = item.querySelector('.location-input');

    // Google Places Autocomplete — restricted to London area
    const ac = new google.maps.places.Autocomplete(input, {
      componentRestrictions: { country: 'gb' },
      bounds: new google.maps.LatLngBounds(
        new google.maps.LatLng(LONDON_BOUNDS.south, LONDON_BOUNDS.west),
        new google.maps.LatLng(LONDON_BOUNDS.north, LONDON_BOUNDS.east)
      ),
      strictBounds: false,
      fields: ['geometry', 'name', 'formatted_address'],
    });

    ac.addListener('place_changed', () => {
      const place = ac.getPlace();
      if (!place.geometry) return;
      const name = place.name || place.formatted_address;
      input.value = name;
      input.classList.add('confirmed');
      setCoords(loc.id, {
        name,
        lat: place.geometry.location.lat(),
        lng: place.geometry.location.lng(),
      });
    });

    // Clear confirmed state if user edits the value
    input.addEventListener('input', () => {
      if (loc.coords) {
        loc.coords = null;
        loc.name   = '';
        input.classList.remove('confirmed');
        updateSearchBtn();
        refreshMarkers();
      }
    });

    item.querySelector('.remove-btn')?.addEventListener('click', e => {
      removeLocation(parseInt(e.currentTarget.dataset.id, 10));
    });

    item.querySelector('.location-transport')?.addEventListener('change', e => {
      setLocationConfig(loc.id, 'transport', e.currentTarget.value);
      clearResults();
    });

    item.querySelector('.location-depart-time')?.addEventListener('change', e => {
      setLocationConfig(loc.id, 'departTime', e.currentTarget.value);
      clearResults();
    });

    item.querySelector('.location-depart-day')?.addEventListener('change', e => {
      setLocationConfig(loc.id, 'departDay', e.currentTarget.value);
      clearResults();
    });

    item.querySelector('.location-max-time')?.addEventListener('input', e => {
      const val = parseInt(e.currentTarget.value, 10);
      setLocationConfig(loc.id, 'maxTravelMins', Number.isFinite(val) && val > 0 ? val : null);
      clearResults();
    });

    list.appendChild(item);
  });
}

function renderHeatmapViewControls() {
  const section = document.getElementById('legend-heatmap-view');
  const controls = document.getElementById('heatmap-view-controls');
  if (!section || !controls) return;

  if (!latestHeatmapData || !latestHeatmapData.timesMatrix?.length || locations.length <= 1) {
    section.classList.add('hidden');
    controls.innerHTML = '';
    return;
  }

  const validIdxs = locations.map((_, idx) => idx);
  selectedHeatmapLocationIdxs = selectedHeatmapLocationIdxs.filter(idx => validIdxs.includes(idx));
  if (!selectedHeatmapLocationIdxs.length) {
    selectedHeatmapLocationIdxs = [...validIdxs];
  }

  controls.innerHTML = locations.map((loc, idx) => {
    const selectedClass = selectedHeatmapLocationIdxs.includes(idx) ? ' selected' : '';
    const color = LOCATION_COLORS[idx % LOCATION_COLORS.length];
    const label = loc.name?.trim() ? loc.name.trim() : `Location ${idx + 1}`;
    const weightEditor = combineMode === 'weighted-sum'
      ? `
        <div class="heatmap-location-weight">
          <label for="legend-weight-${loc.id}">Weight</label>
          <input
            id="legend-weight-${loc.id}"
            class="legend-weight-input"
            type="number"
            min="0.1"
            step="0.1"
            value="${loc.weight}"
            data-location-id="${loc.id}"
          >
        </div>
      `
      : '';
    return `
      <button type="button" class="heatmap-location-cell${selectedClass}" data-location-idx="${idx}">
        <div class="heatmap-location-header">
          <span class="heatmap-location-dot" style="background:${color};"></span>
          <span class="heatmap-location-label">${label}</span>
          <span class="heatmap-location-state" aria-hidden="true">Selected</span>
        </div>
        ${weightEditor}
      </button>
    `;
  }).join('');
  bindLegendWeightInputs();
  section.classList.remove('hidden');
}

function bindLegendWeightInputs() {
  const controls = document.getElementById('heatmap-view-controls');
  if (!controls) return;
  controls.querySelectorAll('.legend-weight-input').forEach(input => {
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('change', e => {
      const locationId = Number.parseInt(e.currentTarget.dataset.locationId, 10);
      const value = parseFloat(e.currentTarget.value);
      if (!Number.isFinite(locationId)) return;
      setWeight(locationId, value);
    });
  });
}

function renderLegendCombineControls() {
  const section = document.getElementById('legend-combine-mode');
  if (!section) return;
  const hasLiveData = Boolean(latestHeatmapData?.timesMatrix?.length);
  section.classList.toggle('hidden', !hasLiveData);
  setSegmentedValue('combine-mode', combineMode);
}

function buildHeatmapForSelection() {
  if (!latestHeatmapData || !latestHeatmapData.timesMatrix?.length) return [];
  const selectedLocs = selectedHeatmapLocationIdxs
    .filter(idx => Number.isFinite(idx) && locations[idx])
    .map(idx => ({ idx, loc: locations[idx] }));
  if (!selectedLocs.length) return [];

  return latestHeatmapData.grid.map((pt, pointIdx) => {
    const row = latestHeatmapData.timesMatrix[pointIdx] || [];
    const selectedTimes = selectedLocs.map(item => row[item.idx] ?? null);
    const selectedLocConfigs = selectedLocs.map(item => item.loc);
    const hasData = selectedTimes.some(time => time !== null);
    return {
      ...pt,
      time: hasData ? combineTimes(selectedTimes, selectedLocConfigs, combineMode) : null,
    };
  });
}

function applySelectedHeatmapLocations() {
  const selectedPoints = buildHeatmapForSelection();
  if (!selectedPoints?.length) return;
  heatmapOverlay.setData(selectedPoints);
  showLegend({
    selectedCount: selectedHeatmapLocationIdxs.length,
    totalCount: locations.length,
  });
}

// ── Search button state ────────────────────────────────────────────────────

function updateSearchBtn() {
  const btn = document.getElementById('search-btn');
  const ready = locations.length >= 1 && locations.every(l => l.coords);
  const loading = !document.getElementById('loading').classList.contains('hidden');
  btn.disabled = !ready;
  if (loading) btn.disabled = true;
  btn.textContent = ready ? 'Show travel times' : 'Select location(s) first';
}

function initSamplingDefaults() {
  const center = googleMap.getCenter();
  samplingCenter = { name: 'Default center', lat: center.lat(), lng: center.lng() };
  samplingMode = getSegmentedValue('sampling-space-mode') || 'radius';
  samplingTargetPoints = parseInt(document.getElementById('sampling-density').value, 10);
  samplingRadiusKm = parseFloat(document.getElementById('sampling-radius-km').value);
  samplingAreaVisible = (getSegmentedValue('sampling-visibility-toggle') || 'show') === 'show';
  document.getElementById('sampling-density-display').textContent = `${samplingTargetPoints}`;
  document.getElementById('sampling-radius-display').textContent = `${samplingRadiusKm.toFixed(1)} km`;
  setSegmentedValue('sampling-space-mode', samplingMode);
  setSegmentedValue('sampling-visibility-toggle', samplingAreaVisible ? 'show' : 'hide');
  initSamplingVisuals();
  toggleSamplingModeUI();
}

function toggleSamplingModeUI() {
  const radiusControls = document.getElementById('sampling-radius-controls');
  radiusControls.classList.toggle('hidden', samplingMode !== 'radius');
  if (!samplingCircle || !samplingRectangle || !samplingCenterMarker) return;

  const areaVisible = samplingAreaVisible && samplingEditMode;
  samplingCenterMarker.setVisible(areaVisible && samplingMode === 'radius');
  samplingCircle.setVisible(areaVisible && samplingMode === 'radius');
  samplingRectangle.setVisible(areaVisible && samplingMode === 'bounds');
  samplingRectangle.setEditable(samplingEditMode && samplingMode === 'bounds');
  samplingRectangle.setDraggable(samplingEditMode && samplingMode === 'bounds');
  if (samplingMode === 'bounds') {
    samplingRectangle.setBounds({
      north: samplingBounds.north,
      south: samplingBounds.south,
      east: samplingBounds.east,
      west: samplingBounds.west,
    });
  }
  if (mapClickListener) {
    google.maps.event.removeListener(mapClickListener);
    mapClickListener = null;
  }
  updateSamplingPreview();
}

function initSamplingVisuals() {
  samplingCenterMarker = new google.maps.Marker({
    map: googleMap,
    position: samplingCenter,
    visible: false,
    draggable: true,
    title: 'Sampling center',
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 7,
      fillColor: '#38bdf8',
      fillOpacity: 1,
      strokeColor: '#ffffff',
      strokeWeight: 2,
    },
    zIndex: 160,
  });

  samplingCenterMarker.addListener('dragend', () => {
    const pos = samplingCenterMarker.getPosition();
    samplingCenter = { lat: pos.lat(), lng: pos.lng() };
    updateSamplingPreview();
    clearResults();
  });

  samplingCircle = new google.maps.Circle({
    map: googleMap,
    visible: false,
    strokeColor: '#38bdf8',
    strokeOpacity: 0.95,
    strokeWeight: 2,
    fillColor: '#38bdf8',
    fillOpacity: 0.08,
    editable: false,
    draggable: false,
    clickable: false,
  });

  samplingCircle.addListener('radius_changed', () => {
    if (syncingSamplingVisuals) return;
    if (!samplingEditMode || samplingMode !== 'radius') return;
    samplingRadiusKm = Math.max(1, samplingCircle.getRadius() / 1000);
    document.getElementById('sampling-radius-km').value = samplingRadiusKm.toFixed(1);
    document.getElementById('sampling-radius-display').textContent = `${samplingRadiusKm.toFixed(1)} km`;
    updateSamplingPreview();
    clearResults();
  });

  samplingCircle.addListener('center_changed', () => {
    if (syncingSamplingVisuals) return;
    if (!samplingEditMode || samplingMode !== 'radius') return;
    const center = samplingCircle.getCenter();
    samplingCenter = { lat: center.lat(), lng: center.lng() };
    samplingCenterMarker.setPosition(center);
    updateSamplingPreview();
    clearResults();
  });

  samplingCircle.addListener('mousedown', () => {
    suppressMapClickUntil = Date.now() + 400;
  });

  samplingRectangle = new google.maps.Rectangle({
    map: googleMap,
    visible: false,
    strokeColor: '#38bdf8',
    strokeOpacity: 0.95,
    strokeWeight: 2,
    fillColor: '#38bdf8',
    fillOpacity: 0.08,
    editable: false,
    draggable: false,
  });

  samplingRectangle.addListener('bounds_changed', () => {
    if (syncingSamplingVisuals) return;
    if (!samplingEditMode || samplingMode !== 'bounds') return;
    const b = samplingRectangle.getBounds();
    if (!b) return;
    samplingBounds = {
      south: b.getSouthWest().lat(),
      west: b.getSouthWest().lng(),
      north: b.getNorthEast().lat(),
      east: b.getNorthEast().lng(),
    };
    updateSamplingPreview();
    clearResults();
  });

  samplingRectangle.addListener('mousedown', () => {
    suppressMapClickUntil = Date.now() + 400;
  });
}

function clearSamplingPreviewDots() {
  samplingPreviewDots.forEach(dot => dot.setMap(null));
  samplingPreviewDots = [];
}

function getSamplingLayout(bounds, targetPoints) {
  const latSpan = Math.max(0.001, bounds.north - bounds.south);
  const lngSpan = Math.max(0.001, bounds.east - bounds.west);
  const aspect = lngSpan / latSpan;
  const cols = Math.max(4, Math.round(Math.sqrt(targetPoints * aspect)));
  const rows = Math.max(4, Math.round(targetPoints / cols));
  return { cols, rows };
}

function updateSamplingPreview() {
  if (!samplingCenter) return;
  if (!samplingCircle || !samplingRectangle || !samplingCenterMarker) return;
  if (syncingSamplingVisuals) return;

  syncingSamplingVisuals = true;
  if (samplingMode === 'radius') {
    samplingCircle.setCenter(samplingCenter);
    samplingCircle.setRadius(samplingRadiusKm * 1000);
    samplingCenterMarker.setPosition(samplingCenter);
    const latRadius = samplingRadiusKm / 111.32;
    const lngRadius = samplingRadiusKm / Math.max(8, Math.abs(Math.cos((samplingCenter.lat * Math.PI) / 180) * 111.32));
    samplingBounds = {
      south: samplingCenter.lat - latRadius,
      north: samplingCenter.lat + latRadius,
      west: samplingCenter.lng - lngRadius,
      east: samplingCenter.lng + lngRadius,
    };
  }

  if (samplingMode === 'bounds') {
    const currentBounds = samplingRectangle.getBounds();
    if (!samplingEditMode || !currentBounds) {
      samplingRectangle.setBounds({
        north: samplingBounds.north,
        south: samplingBounds.south,
        east: samplingBounds.east,
        west: samplingBounds.west,
      });
    }
  }

  clearSamplingPreviewDots();
  if (!samplingEditMode || !samplingAreaVisible) {
    syncingSamplingVisuals = false;
    return;
  }

  const layout = getSamplingLayout(samplingBounds, samplingTargetPoints);
  const previewGrid = generateGrid(samplingBounds, {
    cols: layout.cols,
    rows: layout.rows,
    center: samplingMode === 'radius' ? samplingCenter : null,
    radiusMeters: samplingMode === 'radius' ? samplingRadiusKm * 1000 : null,
  });

  samplingPreviewDots = previewGrid.map(p => new google.maps.Circle({
    map: googleMap,
    center: { lat: p.lat, lng: p.lng },
    radius: 70,
    strokeOpacity: 0,
    fillColor: '#93c5fd',
    fillOpacity: 0.75,
    clickable: false,
    zIndex: 140,
  }));
  syncingSamplingVisuals = false;
}

// ── Distance Matrix calls ──────────────────────────────────────────────────

async function runSearch() {
  clearResults();

  const sampling = buildSamplingConfig();
  if (!sampling.ok) {
    showError(sampling.error);
    return;
  }
  const grid = generateGrid(sampling.bounds, sampling.gridOptions);
  if (!grid.length) {
    showError('No sample points were generated. Increase radius or density.');
    return;
  }

  setLoading(true, `Querying ${grid.length} locations (${Math.ceil(grid.length / DEST_BATCH)} batches)…`);

  try {
    // timesMatrix[gridIdx] = [secondsFromOrigin0, secondsFromOrigin1, ...]
    const timesMatrix = await fetchTimesMatrix(locations, grid);

    latestHeatmapData = { grid, timesMatrix };
    selectedHeatmapLocationIdxs = locations.map((_, idx) => idx);
    renderLegendCombineControls();
    renderHeatmapViewControls();
    applySelectedHeatmapLocations();
    samplingAreaVisible = false;
    setSegmentedValue('sampling-visibility-toggle', 'hide');
    toggleSamplingModeUI();
    const combinedPoints = buildHeatmapForSelection();
    saveHistoryEntry({
      gridPoints: combinedPoints,
      reachableCount: combinedPoints.filter(p => p.time !== null).length,
      timesMatrix,
    });

    const reachableCount = combinedPoints.filter(p => p.time !== null).length;
    showSuccess(`Done. Computed combined scores for ${reachableCount} sampled areas.`);
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

async function fetchTimesMatrix(locationConfigs, gridPoints) {
  const timesMatrix = gridPoints.map(() => locationConfigs.map(() => null));
  const totalBatches = Math.ceil(gridPoints.length / DEST_BATCH);

  for (let originIdx = 0; originIdx < locationConfigs.length; originIdx++) {
    const loc = locationConfigs[originIdx];
    const travelMode = google.maps.TravelMode[loc.transport];
    const departureTime = buildDepartureTime(loc.departDay, loc.departTime);

    for (let start = 0; start < gridPoints.length; start += DEST_BATCH) {
      const batch = gridPoints.slice(start, start + DEST_BATCH);
      const batchIdx = Math.floor(start / DEST_BATCH) + 1;
      setLoadingText(`Location ${originIdx + 1}/${locationConfigs.length} - Batch ${batchIdx}/${totalBatches}...`);

      const request = {
        origins: [new google.maps.LatLng(loc.coords.lat, loc.coords.lng)],
        destinations: batch.map(p => new google.maps.LatLng(p.lat, p.lng)),
        travelMode,
      };

      if (travelMode === google.maps.TravelMode.TRANSIT) {
        request.transitOptions = {
          departureTime,
          modes: [
            google.maps.TransitMode.BUS,
            google.maps.TransitMode.RAIL,
            google.maps.TransitMode.SUBWAY,
            google.maps.TransitMode.TRAIN,
            google.maps.TransitMode.TRAM,
          ],
        };
      } else if (travelMode === google.maps.TravelMode.DRIVING) {
        request.drivingOptions = { departureTime };
      }

      await new Promise((resolve, reject) => {
        matrixService.getDistanceMatrix(request, (response, status) => {
          if (status !== 'OK') {
            reject(new Error(`Distance Matrix error: ${status}`));
            return;
          }

          batch.forEach((_, destIdx) => {
            const el = response.rows[0].elements[destIdx];
            if (el.status !== 'OK') return;
            let seconds = el.duration.value;
            if (Number.isFinite(loc.maxTravelMins) && loc.maxTravelMins > 0) {
              seconds = Math.min(seconds, loc.maxTravelMins * 60);
            }
            timesMatrix[start + destIdx][originIdx] = seconds;
          });
          resolve();
        });
      });

      if (start + DEST_BATCH < gridPoints.length) {
        await sleep(150);
      }
    }
  }

  return timesMatrix;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function combineTimes(times, locs, modeName) {
  const validEntries = times
    .map((time, idx) => ({ time, weight: locs[idx]?.weight ?? 1 }))
    .filter(entry => entry.time !== null);

  if (!validEntries.length) return null;

  if (modeName === 'min') return Math.min(...validEntries.map(e => e.time));
  if (modeName === 'sum') return validEntries.reduce((sum, e) => sum + e.time, 0);
  if (modeName === 'weighted-sum') {
    return validEntries.reduce((sum, e) => sum + (e.time * e.weight), 0);
  }
  return Math.max(...validEntries.map(e => e.time));
}

function buildSamplingConfig() {
  if (!samplingCenter) return { ok: false, error: 'Sampling center is missing.' };
  if (!Number.isFinite(samplingTargetPoints) || samplingTargetPoints < 20) {
    return { ok: false, error: 'Sampling density is invalid.' };
  }
  if (samplingMode === 'radius' && (!Number.isFinite(samplingRadiusKm) || samplingRadiusKm <= 0)) {
    return { ok: false, error: 'Sampling radius is invalid.' };
  }
  if (samplingBounds.north <= samplingBounds.south || samplingBounds.east <= samplingBounds.west) {
    return { ok: false, error: 'Sampling bounds are invalid.' };
  }
  const layout = getSamplingLayout(samplingBounds, samplingTargetPoints);
  return {
    ok: true,
    bounds: { ...samplingBounds },
    gridOptions: {
      cols: layout.cols,
      rows: layout.rows,
      center: samplingMode === 'radius' ? { ...samplingCenter } : null,
      radiusMeters: samplingMode === 'radius' ? samplingRadiusKm * 1000 : null,
    },
  };
}

function buildDepartureTime(dayOfWeek, timeStr) {
  const target = parseInt(dayOfWeek, 10); // 0=Sun … 6=Sat
  const now    = new Date();
  let daysAhead = target - now.getDay();
  if (daysAhead < 0) daysAhead += 7;

  const d = new Date(now);
  d.setDate(now.getDate() + daysAhead);
  const [h, m] = timeStr.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 7);
  return d;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function saveHistoryEntry({ gridPoints, reachableCount, timesMatrix = [] }) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    combineMode,
    locations: locations.map(loc => ({
      name: loc.name,
      coords: loc.coords ? { ...loc.coords } : null,
      weight: loc.weight,
      transport: loc.transport,
      departTime: loc.departTime,
      departDay: loc.departDay,
      maxTravelMins: loc.maxTravelMins,
    })),
    samplingMode,
    samplingTargetPoints,
    samplingRadiusKm,
    samplingCenter: samplingCenter ? { ...samplingCenter } : null,
    samplingBounds: { ...samplingBounds },
    samplingAreaVisible,
    reachableCount,
    gridPoints: gridPoints.map(p => ({ lat: p.lat, lng: p.lng, time: p.time })),
    timesMatrix: timesMatrix.map(row => row.map(value => (value === null ? null : Number(value)))),
  };

  heatmapHistory.unshift(entry);
  if (heatmapHistory.length > MAX_HISTORY_ITEMS) {
    heatmapHistory = heatmapHistory.slice(0, MAX_HISTORY_ITEMS);
  }
  persistHeatmapHistory();
  renderHistoryList();
}

function loadHeatmapHistory() {
  try {
    const raw = localStorage.getItem(HEATMAP_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    heatmapHistory = Array.isArray(parsed) ? parsed : [];
  } catch {
    heatmapHistory = [];
  }
}

function persistHeatmapHistory() {
  try {
    localStorage.setItem(HEATMAP_HISTORY_KEY, JSON.stringify(heatmapHistory));
  } catch {
    // Ignore storage quota/runtime issues.
  }
}

function renderHistoryList() {
  const list = document.getElementById('history-list');
  if (!list) return;
  list.innerHTML = '';

  if (!heatmapHistory.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'No saved heatmaps yet.';
    list.appendChild(empty);
    return;
  }

  heatmapHistory.forEach(entry => {
    const item = document.createElement('div');
    item.className = 'history-item';

    const when = new Date(entry.createdAt).toLocaleString();
    const locNames = (entry.locations || []).map(l => l.name).filter(Boolean).slice(0, 2);
    const namesSuffix = (entry.locations || []).length > 2 ? ` +${entry.locations.length - 2} more` : '';
    const locationLabel = locNames.length ? `${locNames.join(', ')}${namesSuffix}` : `${entry.locations?.length || 0} locations`;
    const samplingLabel = entry.samplingMode === 'radius'
      ? `Radius ${Number(entry.samplingRadiusKm || 0).toFixed(1)} km`
      : 'Rectangle';

    item.innerHTML = `
      <div class="history-title">${when}</div>
      <div class="history-meta">
        ${locationLabel}<br>
        Combine: ${entry.combineMode || 'sum'} | Sampling: ${samplingLabel} | Reachable: ${entry.reachableCount ?? 0}
      </div>
      <div class="history-actions">
        <button type="button" class="history-btn load" data-id="${entry.id}">Load</button>
        <button type="button" class="history-btn delete" data-id="${entry.id}">Delete</button>
      </div>
    `;

    list.appendChild(item);
  });
}

function loadHistoryEntry(id) {
  const entry = heatmapHistory.find(item => item.id === id);
  if (!entry) return;
  applyStateWithoutClearing(entry);
  latestHeatmapData = {
    grid: entry.gridPoints || [],
    timesMatrix: Array.isArray(entry.timesMatrix) ? entry.timesMatrix : [],
  };
  selectedHeatmapLocationIdxs = (entry.locations || []).map((_, idx) => idx);
  renderLegendCombineControls();
  renderHeatmapViewControls();
  if (latestHeatmapData.timesMatrix.length) {
    applySelectedHeatmapLocations();
  } else {
    heatmapOverlay.setData(entry.gridPoints || []);
    showLegend({ selectedCount: locations.length, totalCount: locations.length });
  }
  showSuccess('Loaded heatmap from history.');
}

function deleteHistoryEntry(id) {
  heatmapHistory = heatmapHistory.filter(entry => entry.id !== id);
  persistHeatmapHistory();
  renderHistoryList();
}

function getSegmentedValue(containerId) {
  const active = document.querySelector(`#${containerId} .segment-btn.active`);
  return active?.dataset.value ?? null;
}

function setSegmentedValue(containerId, value) {
  const buttons = document.querySelectorAll(`#${containerId} .segment-btn`);
  buttons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === value);
  });
}

// ── Legend ─────────────────────────────────────────────────────────────────

const LEGEND_BANDS = [
  { label: 'Very good', color: 'rgb(34,197,94)' },
  { label: 'Good', color: 'rgb(85,180,88)' },
  { label: 'Moderate', color: 'rgb(140,150,78)' },
  { label: 'Slow', color: 'rgb(195,108,72)' },
  { label: 'Very slow', color: 'rgb(239,68,68)' },
];

function showLegend({ selectedCount = locations.length, totalCount = locations.length } = {}) {
  const legend = document.getElementById('legend');
  const title  = document.getElementById('legend-title');
  const items  = document.getElementById('legend-items');
  const combineModeLabels = {
    min: 'Minimum',
    max: 'Maximum',
    sum: 'Sum',
    'weighted-sum': 'Weighted sum',
  };
  const modeLabel = combineModeLabels[combineMode] || 'Maximum';
  title.textContent = `Combined score (${modeLabel}) - ${selectedCount}/${totalCount} locations`;
  items.innerHTML = '';

  LEGEND_BANDS.forEach(({ label, color }) => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `
      <div class="legend-swatch" style="background:${color};"></div>
      <span>${label}</span>
    `;
    items.appendChild(item);
  });

  legend.classList.remove('hidden');
}

function clearResults() {
  heatmapOverlay?.clear();
  latestHeatmapData = null;
  selectedHeatmapLocationIdxs = [];
  renderLegendCombineControls();
  renderHeatmapViewControls();
  document.getElementById('legend').classList.add('hidden');
  document.getElementById('status-msg').className = 'status-msg hidden';
  document.getElementById('status-msg').textContent = '';
}

// ── UI state helpers ───────────────────────────────────────────────────────

function setLoading(on, text = 'Calculating travel times…') {
  const el = document.getElementById('loading');
  el.classList.toggle('hidden', !on);
  if (on) setLoadingText(text);
  updateSearchBtn();
}

function setLoadingText(text) {
  document.getElementById('loading-text').textContent = text;
}

function showError(msg) {
  const el = document.getElementById('status-msg');
  el.textContent = msg;
  el.className = 'status-msg error';
}

function showSuccess(msg) {
  const el = document.getElementById('status-msg');
  el.textContent = msg;
  el.className = 'status-msg success';
}
