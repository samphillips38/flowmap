# flowmap

Flowmap is a London commute heatmap that visualizes public transit travel times from one or more origins using Google Maps and the Distance Matrix API.

## Run locally

1. Copy environment variables:
   - `cp .env.example .env`
2. Set `GOOGLE_MAPS_API_KEY` in `.env`.
3. Install dependencies:
   - `npm install`
4. Start the app:
   - `npm run dev`
5. Open `http://localhost:3000`.

## Deploy on Railway

1. Create a new Railway project and link this repository.
2. Set environment variables in Railway:
   - `GOOGLE_MAPS_API_KEY` (required)
   - `PORT` (optional; Railway provides this automatically)
3. Deploy.

Railway detects this Node app automatically and starts it with `npm start`.
