// ── Constants ──────────────────────────────────────────────────────────────

const LOCATION_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#06b6d4'];
const DEST_BATCH = 25; // Distance Matrix API max destinations per request
const HEATMAP_HISTORY_KEY = 'transitHeatmapHistoryV1';
const MAX_HISTORY_ITEMS = 20;
const HEATMAP_DISPLAY_MODES = ['both', 'heatmap', 'contours'];
// Horizontal double-arrow for the sampling-radius drag handle (SVG path, y-up).
const SAMPLING_RADIUS_HANDLE_PATH =
  'M -1 0 L -0.45 -0.38 L -0.45 -0.14 L 0.45 -0.14 L 0.45 -0.38 L 1 0 L 0.45 0.38 L 0.45 0.14 L -0.45 0.14 L -0.45 0.38 Z';
const SAMPLING_RADIUS_HANDLE_SCALE = 10;

// ── State ──────────────────────────────────────────────────────────────────

let googleMap, heatmapOverlay, matrixService, directionsService;
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
let samplingRadiusMarker = null;
let samplingRadiusDragging = false;
let samplingPreviewDots = [];
let samplingAreaVisible = true;
let mapClickListener = null;
let probeMapClickListener = null;
let probeMarker = null;
let probeCoords = null;
let probeFetchToken = 0;
let syncingSamplingVisuals = false;
let suppressMapClickUntil = 0;
let heatmapHistory = [];
let latestHeatmapData = null;
let selectedHeatmapLocationIdxs = [];
let mobileInputsCollapsed = false;
let mobileLegendOpen = false;
let historySheetOpen = false;
let mapToastTimeout = null;
let sheetDrag = { active: false, sheet: null, startY: 0, offsetY: 0, onClose: null, fromHandle: false };
const SHEET_DISMISS_THRESHOLD_PX = 72;
let heatmapDisplayMode = 'both';

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

window.initApp = async function () {
  await Auth.init();

  googleMap = new google.maps.Map(document.getElementById('map'), {
    center: { lat: 51.505, lng: -0.09 },
    zoom: 11,
    styles: DARK_MAP_STYLE,
    disableDefaultUI: false,
    zoomControl: !isMapFirstLayout(),
    zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_CENTER },
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
  });

  heatmapOverlay = createTransitHeatmap(googleMap);
  heatmapOverlay.setDisplayMode(heatmapDisplayMode);
  matrixService     = new google.maps.DistanceMatrixService();
  directionsService = new google.maps.DirectionsService();

  googleMap.addListener('dragstart', () => heatmapOverlay.beginInteraction());
  googleMap.addListener('zoom_changed', () => heatmapOverlay.beginInteraction());
  googleMap.addListener('idle', () => heatmapOverlay.endInteraction());

  addLocation();
  initSamplingDefaults();
  setupEventListeners();
  renderLocationList();
  updateSearchBtn();
  await refreshHeatmapHistory();
  updateSamplingPreview();
  initializeMobileUi();
};

window.onAuthReady = refreshHeatmapHistory;

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

  document.getElementById('heatmap-display-mode').addEventListener('click', e => {
    const btn = e.target.closest('.segment-btn');
    if (!btn) return;
    const mode = btn.dataset.value;
    if (!mode || !HEATMAP_DISPLAY_MODES.includes(mode)) return;
    applyHeatmapDisplayMode(mode);
  });

  document.getElementById('history-list').addEventListener('click', e => {
    const button = e.target.closest('.history-btn');
    if (!button) return;
    const id = button.dataset.id;
    if (!id) return;
    if (button.classList.contains('load')) {
      loadHistoryEntry(id);
      closeHistorySheet();
      return;
    }
    if (button.classList.contains('delete')) {
      deleteHistoryEntry(id);
    }
  });

  document.getElementById('history-open-btn')?.addEventListener('click', toggleHistorySheet);
  document.getElementById('history-open-btn-mobile')?.addEventListener('click', toggleHistorySheet);
  document.getElementById('probe-times-close')?.addEventListener('click', clearProbePin);
  document.getElementById('probe-times-list')?.addEventListener('click', e => {
    const toggle = e.target.closest('.probe-times-toggle');
    if (!toggle || toggle.disabled) return;
    const card = toggle.closest('.probe-times-card');
    const details = card?.querySelector('.probe-route-details');
    if (!details) return;
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    details.classList.toggle('hidden', expanded);
    card.classList.toggle('expanded', !expanded);
  });

  document.getElementById('search-btn').addEventListener('click', runSearch);
  document.getElementById('toggle-inputs-btn')?.addEventListener('click', toggleMobileInputs);
  document.getElementById('toggle-legend-btn')?.addEventListener('click', toggleMobileLegend);
  document.getElementById('mobile-sheet-backdrop')?.addEventListener('click', closeMobileOverlay);
  setupSheetTransitionListener();
  setupLegendTransitionListener();
  setupHistoryTransitionListener();
  setupMobileScrollLock();
  setupMobileSheetSwipe();
  window.addEventListener('resize', applyMobileUiState);
}

function resetSheetDragStyles() {
  ['sidebar', 'legend', 'history-sheet'].forEach(id => {
    const sheet = document.getElementById(id);
    if (!sheet) return;
    sheet.classList.remove('sheet-dragging');
    sheet.style.removeProperty('transform');
  });
  sheetDrag = { active: false, sheet: null, startY: 0, offsetY: 0, onClose: null, fromHandle: false };
}

function getSheetScrollEl(sheet) {
  return sheet.querySelector('.legend-sheet-body, .history-sheet-body') || sheet;
}

function canStartSheetDrag(sheet, target) {
  if (target.closest('.sidebar-header, .legend-sheet-header, .history-sheet-header, .sheet-grab')) return true;
  return getSheetScrollEl(sheet).scrollTop <= 0;
}

function finishSheetDrag(sheet) {
  if (!sheetDrag.active || sheetDrag.sheet !== sheet) return;
  const shouldClose = sheetDrag.offsetY >= SHEET_DISMISS_THRESHOLD_PX;
  sheet.classList.remove('sheet-dragging');
  sheet.style.removeProperty('transform');
  const onClose = sheetDrag.onClose;
  sheetDrag = { active: false, sheet: null, startY: 0, offsetY: 0, onClose: null, fromHandle: false };
  if (shouldClose && onClose) onClose();
}

function setupMobileSheetSwipe() {
  const configs = [
    {
      id: 'sidebar',
      isOpen: () => !mobileInputsCollapsed,
      close: () => {
        mobileInputsCollapsed = true;
        applyMobileUiState();
      },
    },
    {
      id: 'legend',
      isOpen: () => mobileLegendOpen,
      close: () => {
        mobileLegendOpen = false;
        applyMobileUiState();
      },
    },
    {
      id: 'history-sheet',
      isOpen: () => historySheetOpen,
      close: () => {
        historySheetOpen = false;
        applyMobileUiState();
      },
    },
  ];

  configs.forEach(({ id, isOpen, close }) => {
    const sheet = document.getElementById(id);
    if (!sheet || sheet.dataset.swipeListener) return;
    sheet.dataset.swipeListener = '1';

    sheet.addEventListener('touchstart', e => {
      if (!isMapFirstLayout() || !isOpen() || e.touches.length !== 1) return;
      if (!canStartSheetDrag(sheet, e.target)) return;

      sheetDrag = {
        active: true,
        sheet,
        startY: e.touches[0].clientY,
        offsetY: 0,
        onClose: close,
        fromHandle: Boolean(e.target.closest('.sidebar-header, .legend-sheet-header, .history-sheet-header, .sheet-grab')),
      };
    }, { passive: true });

    sheet.addEventListener('touchmove', e => {
      if (!sheetDrag.active || sheetDrag.sheet !== sheet || e.touches.length !== 1) return;

      const dy = e.touches[0].clientY - sheetDrag.startY;
      if (dy <= 0) {
        sheetDrag.offsetY = 0;
        sheet.classList.remove('sheet-dragging');
        sheet.style.removeProperty('transform');
        return;
      }

      if (!sheetDrag.fromHandle && getSheetScrollEl(sheet).scrollTop > 0) {
        sheetDrag.active = false;
        sheet.classList.remove('sheet-dragging');
        sheet.style.removeProperty('transform');
        return;
      }

      sheetDrag.offsetY = dy;
      sheet.classList.add('sheet-dragging');
      sheet.style.transform = `translateY(${dy}px)`;
      e.preventDefault();
    }, { passive: false });

    sheet.addEventListener('touchend', () => finishSheetDrag(sheet), { passive: true });
    sheet.addEventListener('touchcancel', () => finishSheetDrag(sheet), { passive: true });
  });
}

function setupMobileScrollLock() {
  if (document.body.dataset.scrollLock) return;
  document.body.dataset.scrollLock = '1';

  document.addEventListener('touchmove', e => {
    if (!isMapFirstLayout()) return;
    if (e.target.closest('#map, #sidebar, #legend, #history-sheet, #probe-times-panel, .pac-container')) return;
    e.preventDefault();
  }, { passive: false });
}

function isMapFirstLayout() {
  return window.matchMedia('(max-width: 980px)').matches;
}

function hasMobileKeyContent() {
  return Boolean(latestHeatmapData?.timesMatrix?.length);
}

function applyMapControlOptions() {
  if (!googleMap) return;
  googleMap.setOptions({ zoomControl: !isMapFirstLayout() });
}

function initializeMobileUi() {
  mobileInputsCollapsed = isMapFirstLayout();
  mobileLegendOpen = false;
  historySheetOpen = false;
  applyMobileUiState();
}

function setupSheetTransitionListener() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar || sidebar.dataset.sheetListener) return;
  sidebar.dataset.sheetListener = '1';
  sidebar.addEventListener('transitionend', e => {
    if (e.propertyName !== 'transform' || !isMapFirstLayout()) return;
    updateMapPadding();
    triggerMapResize();
  });
}

function setupLegendTransitionListener() {
  const legend = document.getElementById('legend');
  if (!legend || legend.dataset.sheetListener) return;
  legend.dataset.sheetListener = '1';
  legend.addEventListener('transitionend', e => {
    if (e.propertyName !== 'transform' || !isMapFirstLayout()) return;
    updateMapPadding();
    triggerMapResize();
  });
}

function setupHistoryTransitionListener() {
  const sheet = document.getElementById('history-sheet');
  if (!sheet || sheet.dataset.sheetListener) return;
  sheet.dataset.sheetListener = '1';
  sheet.addEventListener('transitionend', e => {
    if (e.propertyName !== 'transform') return;
    if (isMapFirstLayout()) {
      updateMapPadding();
      triggerMapResize();
    }
  });
}

function closeMobileOverlay() {
  if (!isMapFirstLayout()) return;
  let changed = false;
  if (!mobileInputsCollapsed) {
    mobileInputsCollapsed = true;
    changed = true;
  }
  if (mobileLegendOpen) {
    mobileLegendOpen = false;
    changed = true;
  }
  if (historySheetOpen) {
    historySheetOpen = false;
    changed = true;
  }
  if (changed) applyMobileUiState();
}

function updateMapPadding() {
  if (!googleMap) return;

  if (!isMapFirstLayout()) {
    googleMap.setOptions({ padding: { top: 0, right: 0, bottom: 0, left: 0 } });
    return;
  }

  const toolbar = document.querySelector('.mobile-map-bar');
  const toolbarH = toolbar?.offsetHeight ?? 52;
  const top = 14;
  const right = 56;

  let bottom = toolbarH + 14;
  if (!mobileInputsCollapsed) {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
      bottom = Math.max(bottom, sidebar.offsetHeight + 16);
    }
  }
  if (mobileLegendOpen) {
    const legend = document.getElementById('legend');
    if (legend && !legend.classList.contains('hidden')) {
      bottom = Math.max(bottom, legend.offsetHeight + 16);
    }
  }
  if (historySheetOpen) {
    const historySheet = document.getElementById('history-sheet');
    if (historySheet) {
      bottom = Math.max(bottom, historySheet.offsetHeight + 16);
    }
  }

  googleMap.setOptions({
    padding: { top, right, bottom, left: 14 },
  });
}

function triggerMapResize() {
  if (!googleMap) return;
  setTimeout(() => google.maps.event.trigger(googleMap, 'resize'), 230);
}

function enterMapViewMode() {
  if (!isMapFirstLayout()) return;
  mobileInputsCollapsed = true;
  mobileLegendOpen = false;
  historySheetOpen = false;
  applyMobileUiState();
}

function toggleMobileInputs() {
  if (!isMapFirstLayout()) return;
  mobileInputsCollapsed = !mobileInputsCollapsed;
  if (!mobileInputsCollapsed) {
    mobileLegendOpen = false;
    historySheetOpen = false;
  }
  applyMobileUiState();
}

function toggleMobileLegend() {
  if (!isMapFirstLayout() || !hasMobileKeyContent()) return;
  mobileLegendOpen = !mobileLegendOpen;
  if (mobileLegendOpen) {
    mobileInputsCollapsed = true;
    historySheetOpen = false;
    ensureLegendVisibleForMobile();
  }
  applyMobileUiState();
}

function openHistorySheet() {
  renderHistoryList();
  historySheetOpen = true;
  if (isMapFirstLayout()) {
    mobileInputsCollapsed = true;
    mobileLegendOpen = false;
  }
  applyMobileUiState();
}

function closeHistorySheet() {
  historySheetOpen = false;
  applyMobileUiState();
}

function toggleHistorySheet() {
  if (historySheetOpen) {
    closeHistorySheet();
    return;
  }
  openHistorySheet();
}

function hideMapToast() {
  const el = document.getElementById('map-toast');
  if (!el) return;
  el.classList.add('hidden');
  clearTimeout(mapToastTimeout);
}

function showMapToast(message, type) {
  const el = document.getElementById('map-toast');
  if (!el) return;
  el.textContent = message;
  el.className = `map-toast ${type}`;
  clearTimeout(mapToastTimeout);
  mapToastTimeout = setTimeout(() => hideMapToast(), 4500);
}

function shouldUseMapToast() {
  return isMapFirstLayout() && mobileInputsCollapsed;
}

function ensureLegendVisibleForMobile() {
  const legend = document.getElementById('legend');
  if (!legend) return;
  if (legend.classList.contains('hidden')) {
    renderLegendCombineControls();
    renderHeatmapViewControls();
    showLegend();
  }
}

function ensureLegendVisibleForDesktop() {
  const legend = document.getElementById('legend');
  if (!legend) return;
  if (legend.classList.contains('hidden')) {
    renderLegendCombineControls();
    renderHeatmapViewControls();
    showLegend();
  }
}

function applyHistorySheetUi(mapContainer, historyBtn) {
  mapContainer.classList.toggle('history-sheet-open', historySheetOpen);
  historyBtn?.setAttribute('aria-expanded', String(historySheetOpen));
  if (historySheetOpen) {
    document.getElementById('history-open-btn')?.classList.add('active');
  } else {
    document.getElementById('history-open-btn')?.classList.remove('active');
  }
}

function applyMobileUiState() {
  const app = document.getElementById('app');
  const mapContainer = document.getElementById('map-container');
  const legend = document.getElementById('legend');
  const inputsBtn = document.getElementById('toggle-inputs-btn');
  const legendBtn = document.getElementById('toggle-legend-btn');
  const historyBtn = document.getElementById('history-open-btn-mobile');
  if (!app || !mapContainer || !legend || !inputsBtn || !legendBtn) return;

  resetSheetDragStyles();

  const mapFirst = isMapFirstLayout();
  applyMapControlOptions();
  applyHistorySheetUi(mapContainer, historyBtn);

  if (!mapFirst) {
    app.classList.remove('mobile-sidebar-collapsed');
    mapContainer.classList.remove('mobile-legend-open');
    document.getElementById('mobile-sheet-backdrop')?.classList.add('hidden');
    ensureLegendVisibleForDesktop();
    inputsBtn.setAttribute('aria-expanded', 'false');
    legendBtn.setAttribute('aria-expanded', 'false');
    legendBtn.classList.remove('hidden');
    updateMapPadding();
    triggerMapResize();
    return;
  }

  const showKey = hasMobileKeyContent();
  legendBtn.classList.toggle('hidden', !showKey);
  if (!showKey) mobileLegendOpen = false;

  app.classList.toggle('mobile-sidebar-collapsed', mobileInputsCollapsed);
  mapContainer.classList.toggle('mobile-legend-open', mobileLegendOpen && showKey);

  const backdrop = document.getElementById('mobile-sheet-backdrop');
  if (backdrop) {
    backdrop.classList.toggle('hidden', mobileInputsCollapsed && !mobileLegendOpen && !historySheetOpen);
  }

  if (mobileLegendOpen && showKey) {
    ensureLegendVisibleForMobile();
  } else if (!showKey) {
    legend.classList.add('hidden');
  }
  inputsBtn.setAttribute('aria-expanded', String(!mobileInputsCollapsed));
  legendBtn.setAttribute('aria-expanded', String(mobileLegendOpen && showKey));

  requestAnimationFrame(() => {
    updateMapPadding();
    triggerMapResize();
  });
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
  applyHeatmapDisplayMode(normalizeHeatmapDisplayMode(entry));

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

  const hasLiveData = Boolean(latestHeatmapData?.timesMatrix?.length);
  if (!hasLiveData) {
    section.classList.add('hidden');
    document.getElementById('legend-locations')?.classList.add('hidden');
    controls.innerHTML = '';
    return;
  }

  section.classList.remove('hidden');

  const locationsSection = document.getElementById('legend-locations');
  if (locations.length <= 1) {
    locationsSection?.classList.add('hidden');
    controls.innerHTML = '';
    return;
  }

  locationsSection?.classList.remove('hidden');

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
        </div>
        ${weightEditor}
      </button>
    `;
  }).join('');
  bindLegendWeightInputs();
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
  showLegend();
  enableProbeMode();
}

function hasActiveHeatmap() {
  return Boolean(latestHeatmapData?.timesMatrix?.length || latestHeatmapData?.grid?.length);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripHtml(html) {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el.textContent || '';
}

function describeTransitVehicle(type) {
  const labels = {
    BUS: 'Bus',
    SUBWAY: 'Tube',
    TRAIN: 'Train',
    TRAM: 'Tram',
    RAIL: 'Rail',
    FERRY: 'Ferry',
    CABLE_CAR: 'Cable car',
    GONDOLA_LIFT: 'Gondola',
    FUNICULAR: 'Funicular',
  };
  return labels[type] || 'Transit';
}

function parseRouteSteps(directionsResult) {
  const leg = directionsResult?.routes?.[0]?.legs?.[0];
  if (!leg) return null;

  const steps = (leg.steps || []).map(step => {
    if (step.travel_mode === 'TRANSIT' && step.transit) {
      const line = step.transit.line || {};
      const vehicle = describeTransitVehicle(line.vehicle?.type);
      const lineName = line.short_name || line.name || vehicle;
      return {
        mode: 'transit',
        label: lineName,
        vehicle,
        agency: line.agencies?.[0]?.name || '',
        from: step.transit.departure_stop?.name || '',
        to: step.transit.arrival_stop?.name || '',
        stops: step.transit.num_stops,
        duration: step.duration?.text || '',
        headsign: step.transit.headsign || '',
      };
    }

    const modeLabels = {
      WALKING: 'Walk',
      BICYCLING: 'Cycle',
      DRIVING: 'Drive',
    };
    return {
      mode: (step.travel_mode || 'unknown').toLowerCase(),
      label: modeLabels[step.travel_mode] || step.travel_mode,
      instructions: stripHtml(step.instructions || ''),
      duration: step.duration?.text || '',
    };
  });

  return {
    seconds: leg.duration?.value ?? null,
    distance: leg.distance?.text || '',
    steps,
    summary: buildRouteSummary(steps),
  };
}

function buildRouteSummary(steps) {
  const transitLabels = steps.filter(s => s.mode === 'transit').map(s => s.label);
  if (transitLabels.length) return transitLabels.join(' → ');
  const primary = steps.find(s => s.mode !== 'walking') || steps[0];
  if (!primary) return '';
  if (primary.instructions) {
    return primary.instructions.length > 72
      ? `${primary.instructions.slice(0, 69)}…`
      : primary.instructions;
  }
  return primary.label;
}

function renderRouteStepHtml(step) {
  if (step.mode === 'transit') {
    const headsign = step.headsign ? ` towards ${escapeHtml(step.headsign)}` : '';
    const stops = Number.isFinite(step.stops) ? `${step.stops} stop${step.stops === 1 ? '' : 's'}` : '';
    const via = step.from && step.to
      ? `<span class="probe-route-via">${escapeHtml(step.from)} → ${escapeHtml(step.to)}</span>`
      : '';
    return `
      <li class="probe-route-step probe-route-step-transit">
        <span class="probe-route-step-icon">${escapeHtml(step.vehicle)}</span>
        <div class="probe-route-step-body">
          <span class="probe-route-step-title">${escapeHtml(step.label)}${headsign}</span>
          ${via}
          <span class="probe-route-step-meta">${[stops, step.duration].filter(Boolean).join(' · ')}</span>
        </div>
      </li>
    `;
  }

  const text = step.instructions || step.label;
  return `
    <li class="probe-route-step probe-route-step-${step.mode}">
      <span class="probe-route-step-icon">${escapeHtml(step.label)}</span>
      <div class="probe-route-step-body">
        <span class="probe-route-step-title">${escapeHtml(text)}</span>
        ${step.duration ? `<span class="probe-route-step-meta">${escapeHtml(step.duration)}</span>` : ''}
      </div>
    </li>
  `;
}

function formatHistoryDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today · ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday · ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · ${time}`;
}

function formatCombineModeLabel(mode) {
  const labels = {
    min: 'Min',
    max: 'Max',
    sum: 'Sum',
    'weighted-sum': 'Weighted',
  };
  return labels[mode] || mode;
}

function ensureProbeMarker() {
  if (probeMarker) return;
  probeMarker = new google.maps.Marker({
    map: null,
    draggable: true,
    title: 'Probe location',
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 9,
      fillColor: '#f8fafc',
      fillOpacity: 1,
      strokeColor: '#6366f1',
      strokeWeight: 3,
    },
    zIndex: 200,
  });
  probeMarker.addListener('dragend', () => {
    const pos = probeMarker.getPosition();
    if (!pos) return;
    updateProbePin({ lat: pos.lat(), lng: pos.lng() });
  });
  probeMarker.addListener('mousedown', () => {
    suppressMapClickUntil = Date.now() + 400;
  });
}

function showProbePanel() {
  const panel = document.getElementById('probe-times-panel');
  if (!panel) return;
  panel.classList.remove('hidden');
  document.getElementById('probe-times-hint')?.classList.remove('hidden');
}

function hideProbePanel() {
  document.getElementById('probe-times-panel')?.classList.add('hidden');
}

function renderProbeTimesList(rows, loading) {
  const list = document.getElementById('probe-times-list');
  const hint = document.getElementById('probe-times-hint');
  if (!list) return;

  if (loading) {
    hint?.classList.add('hidden');
    list.innerHTML = '<div class="probe-times-loading">Calculating routes…</div>';
    return;
  }

  hint?.classList.add('hidden');
  list.innerHTML = rows.map(row => {
    const {
      label,
      color,
      duration,
      summary,
      steps,
      unavailable,
      distance,
    } = row;
    const canExpand = !unavailable && steps?.length;
    const detailsHtml = canExpand
      ? `<ol class="probe-route-steps">${steps.map(renderRouteStepHtml).join('')}</ol>`
      : `<p class="probe-route-empty">${unavailable ? 'No route found for this mode.' : 'No route details available.'}</p>`;

    return `
      <div class="probe-times-card">
        <button
          type="button"
          class="probe-times-row probe-times-toggle"
          aria-expanded="false"
          ${canExpand ? '' : 'disabled'}
        >
          <span class="probe-times-dot" style="background:${color};"></span>
          <span class="probe-times-main">
            <span class="probe-times-label">${escapeHtml(label)}</span>
            ${summary ? `<span class="probe-times-summary">${escapeHtml(summary)}</span>` : ''}
          </span>
          <span class="probe-times-value${unavailable ? ' muted' : ''}">${escapeHtml(duration)}</span>
          ${canExpand ? '<span class="probe-times-chevron" aria-hidden="true"></span>' : ''}
        </button>
        <div class="probe-route-details hidden">
          ${distance ? `<div class="probe-route-distance">${escapeHtml(distance)}</div>` : ''}
          ${detailsHtml}
        </div>
      </div>
    `;
  }).join('');
}

async function fetchProbeRoute(pinCoords, loc) {
  if (!loc.coords) return null;

  const travelMode = google.maps.TravelMode[loc.transport];
  const departureTime = buildDepartureTime(loc.departDay, loc.departTime);
  const request = {
    origin: new google.maps.LatLng(pinCoords.lat, pinCoords.lng),
    destination: new google.maps.LatLng(loc.coords.lat, loc.coords.lng),
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

  return new Promise(resolve => {
    directionsService.route(request, (result, status) => {
      if (status !== 'OK') {
        resolve(null);
        return;
      }
      const parsed = parseRouteSteps(result);
      if (!parsed) {
        resolve(null);
        return;
      }
      if (Number.isFinite(parsed.seconds) && Number.isFinite(loc.maxTravelMins) && loc.maxTravelMins > 0) {
        parsed.seconds = Math.min(parsed.seconds, loc.maxTravelMins * 60);
      }
      resolve(parsed);
    });
  });
}

async function fetchProbeRoutes(pinCoords, locationConfigs) {
  const results = locationConfigs.map(() => null);

  for (let destIdx = 0; destIdx < locationConfigs.length; destIdx++) {
    results[destIdx] = await fetchProbeRoute(pinCoords, locationConfigs[destIdx]);
    if (destIdx < locationConfigs.length - 1) {
      await sleep(150);
    }
  }

  return results;
}

async function updateProbePin(coords) {
  probeCoords = { ...coords };
  ensureProbeMarker();
  probeMarker.setPosition(coords);
  probeMarker.setMap(googleMap);
  showProbePanel();

  const token = ++probeFetchToken;
  renderProbeTimesList([], true);

  try {
    const routes = await fetchProbeRoutes(coords, locations);
    if (token !== probeFetchToken) return;

    const rows = locations.map((loc, idx) => {
      const color = LOCATION_COLORS[idx % LOCATION_COLORS.length];
      const label = loc.name?.trim() ? loc.name.trim() : `Location ${idx + 1}`;
      const route = routes[idx];
      const seconds = route?.seconds ?? null;
      return {
        label,
        color,
        duration: seconds === null ? 'No route' : formatDuration(seconds),
        summary: route?.summary || '',
        steps: route?.steps || [],
        distance: route?.distance || '',
        unavailable: seconds === null,
      };
    });
    renderProbeTimesList(rows, false);
  } catch (err) {
    if (token !== probeFetchToken) return;
    renderProbeTimesList([{
      label: 'Error',
      color: '#ef4444',
      duration: err.message,
      unavailable: true,
    }], false);
  }
}

function onProbeMapClick(e) {
  if (!hasActiveHeatmap()) return;
  if (Date.now() < suppressMapClickUntil) return;
  if (!e?.latLng) return;
  updateProbePin({ lat: e.latLng.lat(), lng: e.latLng.lng() });
}

function enableProbeMode() {
  if (!hasActiveHeatmap()) return;
  showProbePanel();
  ensureProbeMarker();
  if (probeMapClickListener) return;
  probeMapClickListener = googleMap.addListener('click', onProbeMapClick);
}

function disableProbeMode() {
  probeFetchToken += 1;
  if (probeMapClickListener) {
    google.maps.event.removeListener(probeMapClickListener);
    probeMapClickListener = null;
  }
  if (probeMarker) {
    probeMarker.setMap(null);
  }
  probeCoords = null;
  hideProbePanel();
  document.getElementById('probe-times-list').innerHTML = '';
  document.getElementById('probe-times-hint')?.classList.remove('hidden');
}

function clearProbePin() {
  if (probeMarker) probeMarker.setMap(null);
  probeCoords = null;
  probeFetchToken += 1;
  document.getElementById('probe-times-list').innerHTML = '';
  document.getElementById('probe-times-hint')?.classList.remove('hidden');
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
  applyHeatmapDisplayMode(getSegmentedValue('heatmap-display-mode') || 'both');
  document.getElementById('sampling-density-display').textContent = `${samplingTargetPoints}`;
  document.getElementById('sampling-radius-display').textContent = `${samplingRadiusKm.toFixed(1)} km`;
  setSegmentedValue('sampling-space-mode', samplingMode);
  setSegmentedValue('sampling-visibility-toggle', samplingAreaVisible ? 'show' : 'hide');
  initSamplingVisuals();
  toggleSamplingModeUI();
}

function clampSamplingRadiusKm(km) {
  return Math.min(30, Math.max(1, km));
}

function getSamplingRadiusMetersPerDegLng(lat) {
  const lngRadians = (lat * Math.PI) / 180;
  return 111320 * Math.max(0.2, Math.cos(lngRadians));
}

function getSamplingRadiusHandlePosition() {
  const metersPerDegLng = getSamplingRadiusMetersPerDegLng(samplingCenter.lat);
  const offsetLng = (samplingRadiusKm * 1000) / metersPerDegLng;
  return { lat: samplingCenter.lat, lng: samplingCenter.lng + offsetLng };
}

function getRadialRadiusMetersFromLatLng(latLng) {
  const metersPerDegLng = getSamplingRadiusMetersPerDegLng(samplingCenter.lat);
  const deltaLng = latLng.lng() - samplingCenter.lng;
  return deltaLng * metersPerDegLng;
}

function syncSamplingRadiusHandlePosition() {
  if (!samplingRadiusMarker || samplingRadiusDragging || !samplingCenter) return;
  samplingRadiusMarker.setPosition(getSamplingRadiusHandlePosition());
}

function setSamplingRadiusFromHandlePosition(latLng) {
  const meters = getRadialRadiusMetersFromLatLng(latLng);
  samplingRadiusKm = clampSamplingRadiusKm(meters / 1000);
  document.getElementById('sampling-radius-km').value = samplingRadiusKm.toFixed(1);
  document.getElementById('sampling-radius-display').textContent = `${samplingRadiusKm.toFixed(1)} km`;
  updateSamplingPreview();
  clearResults();
  if (samplingRadiusMarker) {
    samplingRadiusMarker.setPosition(getSamplingRadiusHandlePosition());
  }
}

function toggleSamplingModeUI() {
  const radiusControls = document.getElementById('sampling-radius-controls');
  radiusControls.classList.toggle('hidden', samplingMode !== 'radius');
  if (!samplingCircle || !samplingRectangle || !samplingCenterMarker) return;

  const areaVisible = samplingAreaVisible && samplingEditMode;
  samplingCenterMarker.setVisible(areaVisible && samplingMode === 'radius');
  if (samplingRadiusMarker) {
    samplingRadiusMarker.setVisible(areaVisible && samplingMode === 'radius');
    samplingRadiusMarker.setDraggable(areaVisible && samplingMode === 'radius');
  }
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
    samplingRadiusKm = clampSamplingRadiusKm(samplingCircle.getRadius() / 1000);
    document.getElementById('sampling-radius-km').value = samplingRadiusKm.toFixed(1);
    document.getElementById('sampling-radius-display').textContent = `${samplingRadiusKm.toFixed(1)} km`;
    syncSamplingRadiusHandlePosition();
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

  samplingRadiusMarker = new google.maps.Marker({
    map: googleMap,
    position: getSamplingRadiusHandlePosition(),
    visible: false,
    draggable: true,
    title: 'Drag to adjust sampling radius',
    icon: {
      path: SAMPLING_RADIUS_HANDLE_PATH,
      scale: SAMPLING_RADIUS_HANDLE_SCALE,
      fillColor: '#38bdf8',
      fillOpacity: 0.95,
      strokeColor: '#ffffff',
      strokeWeight: 1.5,
    },
    zIndex: 165,
  });

  samplingRadiusMarker.addListener('dragstart', () => {
    samplingRadiusDragging = true;
    suppressMapClickUntil = Date.now() + 400;
  });

  samplingRadiusMarker.addListener('drag', () => {
    setSamplingRadiusFromHandlePosition(samplingRadiusMarker.getPosition());
  });

  samplingRadiusMarker.addListener('dragend', () => {
    setSamplingRadiusFromHandlePosition(samplingRadiusMarker.getPosition());
    samplingRadiusDragging = false;
  });

  samplingRadiusMarker.addListener('mousedown', () => {
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
    syncSamplingRadiusHandlePosition();
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
  hideMapToast();
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
    enterMapViewMode();
    collapseMobileSetupSections();
    showSuccess(`Done. ${reachableCount} areas with travel times.`);
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

function collapseMobileSetupSections() {
  if (!isMapFirstLayout()) return;
  document.getElementById('sampling-section')?.removeAttribute('open');
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

function buildHistoryEntry({ gridPoints, reachableCount, timesMatrix = [] }) {
  return {
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
    heatmapDisplayMode,
    reachableCount,
    gridPoints: gridPoints.map(p => ({ lat: p.lat, lng: p.lng, time: p.time })),
    timesMatrix: timesMatrix.map(row => row.map(value => (value === null ? null : Number(value)))),
  };
}

async function saveHistoryEntry({ gridPoints, reachableCount, timesMatrix = [] }) {
  const entry = buildHistoryEntry({ gridPoints, reachableCount, timesMatrix });

  heatmapHistory.unshift(entry);
  if (heatmapHistory.length > MAX_HISTORY_ITEMS) {
    heatmapHistory = heatmapHistory.slice(0, MAX_HISTORY_ITEMS);
  }

  if (Auth.isLoggedIn()) {
    try {
      await Auth.saveCloudRun(entry);
    } catch (err) {
      showError(`Saved locally only: ${err.message}`);
      persistHeatmapHistory();
    }
  } else {
    persistHeatmapHistory();
  }
  renderHistoryList();
}

function readLocalHeatmapHistory() {
  try {
    const raw = localStorage.getItem(HEATMAP_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadHeatmapHistory() {
  heatmapHistory = readLocalHeatmapHistory();
}

function persistHeatmapHistory() {
  if (Auth.isLoggedIn()) return;
  try {
    localStorage.setItem(HEATMAP_HISTORY_KEY, JSON.stringify(heatmapHistory));
  } catch {
    // Ignore storage quota/runtime issues.
  }
}

function clearLocalHeatmapHistory() {
  try {
    localStorage.removeItem(HEATMAP_HISTORY_KEY);
  } catch {
    // Ignore storage issues.
  }
}

async function refreshHeatmapHistory() {
  if (Auth.isLoggedIn()) {
    try {
      const local = readLocalHeatmapHistory();
      if (local.length) {
        heatmapHistory = await Auth.syncLocalRunsToCloud(local);
        clearLocalHeatmapHistory();
      } else {
        heatmapHistory = await Auth.fetchCloudRuns();
      }
    } catch (err) {
      showError(`Could not load cloud history: ${err.message}`);
      loadHeatmapHistory();
    }
  } else {
    loadHeatmapHistory();
  }
  renderHistoryList();
}

function renderHistoryList() {
  const list = document.getElementById('history-list');
  if (!list) return;
  list.innerHTML = '';

  if (!heatmapHistory.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = Auth.isLoggedIn()
      ? 'No saved heatmaps on your account yet.'
      : 'No saved heatmaps yet. Sign in to sync across devices.';
    list.appendChild(empty);
    return;
  }

  heatmapHistory.forEach(entry => {
    const item = document.createElement('div');
    item.className = 'history-item';

    const when = formatHistoryDate(entry.createdAt);
    const locs = entry.locations || [];
    const locationChips = locs.length
      ? locs.map((loc, idx) => {
        const color = LOCATION_COLORS[idx % LOCATION_COLORS.length];
        const name = loc.name?.trim() ? loc.name.trim() : `Location ${idx + 1}`;
        return `
          <span class="history-location-chip">
            <span class="history-location-dot" style="background:${color};"></span>
            <span>${escapeHtml(name)}</span>
          </span>
        `;
      }).join('')
      : '<span class="history-location-chip muted">No locations</span>';
    const samplingLabel = entry.samplingMode === 'radius'
      ? `${Number(entry.samplingRadiusKm || 0).toFixed(1)} km radius`
      : 'Rectangle area';

    item.innerHTML = `
      <div class="history-item-header">
        <time class="history-date">${escapeHtml(when)}</time>
        <span class="history-count">${locs.length} location${locs.length === 1 ? '' : 's'}</span>
      </div>
      <div class="history-locations">${locationChips}</div>
      <div class="history-tags">
        <span class="history-tag">${escapeHtml(formatCombineModeLabel(entry.combineMode || 'sum'))}</span>
        <span class="history-tag">${escapeHtml(samplingLabel)}</span>
        <span class="history-tag">${entry.reachableCount ?? 0} reachable</span>
      </div>
      <div class="history-actions">
        <button type="button" class="history-btn load" data-id="${entry.id}">Load heatmap</button>
        <button type="button" class="history-btn delete" data-id="${entry.id}" aria-label="Delete run">Delete</button>
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
    showLegend();
    enableProbeMode();
  }
  enterMapViewMode();
  showSuccess('Loaded heatmap from history.');
}

async function deleteHistoryEntry(id) {
  heatmapHistory = heatmapHistory.filter(entry => entry.id !== id);
  if (Auth.isLoggedIn()) {
    try {
      await Auth.deleteCloudRun(id);
    } catch (err) {
      showError(`Could not delete from account: ${err.message}`);
      await refreshHeatmapHistory();
      return;
    }
  } else {
    persistHeatmapHistory();
  }
  renderHistoryList();
}

function normalizeHeatmapDisplayMode(entry) {
  if (entry?.heatmapDisplayMode && HEATMAP_DISPLAY_MODES.includes(entry.heatmapDisplayMode)) {
    return entry.heatmapDisplayMode;
  }
  if (entry?.contourLinesVisible === false) return 'heatmap';
  return 'both';
}

function applyHeatmapDisplayMode(mode) {
  heatmapDisplayMode = HEATMAP_DISPLAY_MODES.includes(mode) ? mode : 'both';
  setSegmentedValue('heatmap-display-mode', heatmapDisplayMode);
  heatmapOverlay?.setDisplayMode(heatmapDisplayMode);
  updateLegendColorKey();
}

function heatmapShowsColorKey() {
  return heatmapDisplayMode === 'both'
    || heatmapDisplayMode === 'heatmap'
    || heatmapDisplayMode === 'contours';
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

function updateLegendColorKey() {
  const items = document.getElementById('legend-items');
  if (!items) return;

  const hasLiveData = Boolean(latestHeatmapData?.timesMatrix?.length);
  if (!hasLiveData || !heatmapShowsColorKey()) {
    items.classList.add('hidden');
    items.innerHTML = '';
    return;
  }

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
  items.classList.remove('hidden');
}

function showLegend() {
  updateLegendColorKey();
  document.getElementById('legend')?.classList.remove('hidden');
}

function clearResults() {
  hideMapToast();
  disableProbeMode();
  heatmapOverlay?.clear();
  latestHeatmapData = null;
  selectedHeatmapLocationIdxs = [];
  renderLegendCombineControls();
  renderHeatmapViewControls();
  const legend = document.getElementById('legend');
  if (isMapFirstLayout()) {
    legend.classList.add('hidden');
  } else {
    ensureLegendVisibleForDesktop();
  }
  document.getElementById('status-msg').className = 'status-msg hidden';
  document.getElementById('status-msg').textContent = '';
  if (isMapFirstLayout()) {
    mobileLegendOpen = false;
    applyMobileUiState();
  }
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
  if (shouldUseMapToast()) {
    showMapToast(msg, 'error');
    return;
  }
  const el = document.getElementById('status-msg');
  el.textContent = msg;
  el.className = 'status-msg error';
}

function showSuccess(msg) {
  if (shouldUseMapToast()) {
    showMapToast(msg, 'success');
    return;
  }
  const el = document.getElementById('status-msg');
  el.textContent = msg;
  el.className = 'status-msg success';
}
