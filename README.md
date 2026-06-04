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

## Accounts and history

Sign in from the sidebar to save heatmap runs to your account. History syncs across browsers and devices when you use the same email and password.

- **Signed out:** runs are stored in this browser only (`localStorage`).
- **Signed in:** runs are stored on the server. Any local runs are merged into your account on first sign-in.

## Deploy on Railway

1. Create a new Railway project and link this repository.
2. Set environment variables in Railway:
   - `GOOGLE_MAPS_API_KEY` (required)
   - `JWT_SECRET` (required in production — at least 16 random characters)
   - `PORT` (optional; Railway provides this automatically)
3. Attach a **persistent volume** mounted at `/data` and set `DATA_DIR=/data` so accounts and saved runs survive redeploys.
4. Deploy.

Railway detects this Node app automatically and starts it with `npm start`.
