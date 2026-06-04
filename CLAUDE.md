# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Setup

```bash
cp .env.example .env   # add Google Maps API key and JWT_SECRET
npm install
npm run dev            # nodemon — auto-restarts on changes
```

Open `http://localhost:3000` (not `file://` — the server injects the API key).

Enable these APIs in Google Cloud Console for the key:
- Maps JavaScript API
- Distance Matrix API
- Places API

## Commands

```bash
npm start    # node server.js
npm run dev  # nodemon server.js
```

No build step. `public/` is served as static files; `index.html` is served via a GET `/` route that injects the API key.

## Architecture

```
server.js          — Express: GET / injects API key; /api auth + runs; serves /public static
lib/db.js          — SQLite users + saved runs
lib/auth.js        — JWT httpOnly session cookies
routes/api.js      — Register, login, logout, run history CRUD
public/
  index.html       — UI structure; loads map.js, auth.js, app.js, then Google Maps (callback=initApp)
  css/style.css    — Dark theme + .pac-container overrides for Places Autocomplete dropdown
  js/
    map.js         — Grid generation, colour scale, TransitHeatmap (OverlayView) factory
    auth.js        — Sign in UI, cloud history API client
    app.js         — window.initApp, state, Distance Matrix orchestration, UI events
```

### Startup sequence

The Google Maps `<script>` tag loads async with `callback=initApp`. `window.initApp` (defined in `app.js`) runs after the API is ready and:
1. Creates the `google.maps.Map` with a dark style
2. Calls `createTransitHeatmap(map)` from `map.js` — this is a factory function because `google.maps.OverlayView` must be subclassed *after* the API loads
3. Wires up all event listeners

### Heatmap data flow

1. User searches → `google.maps.places.Autocomplete` (one instance per location input, created in `renderLocationList()`)
2. "Show travel times" → `fetchTimesMatrix()` in `app.js`:
   - 192 grid points over Greater London (16×12 in `map.js:generateGrid()`)
   - Batched in groups of 25 destinations via `google.maps.DistanceMatrixService`
   - 150 ms delay between batches to avoid rate limits
3. **Single mode**: each grid point coloured by its travel time from the one origin
4. **House hunt mode**: each grid point coloured by the **max** travel time across all origins (worst commute anyone would face — minimising this finds the fairest place to live)
5. `TransitHeatmap.setData(points)` builds a geographic scalar field once, then `draw()` / `paint()` sample it onto a canvas aligned via `OverlayView.getProjection()`. Contours are skipped while dragging; `idle` triggers a final high-quality paint.

### Cost

Distance Matrix API is billed per element (origin × destination). One query costs:
- Single location: 192 elements ≈ $0.96
- 3 locations: 576 elements ≈ $2.88

Google provides $200/month free credit.
