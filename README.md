# Shadow Garden — Render package

This folder is everything Render needs. Just point a Web Service here:

**Build command:** `npm install`  (no-op — server.mjs is pre-bundled)
**Start command:** `npm start`

Required environment variables:

- `MONGODB_URI`   — MongoDB Atlas connection string
- `MONGODB_DB`    — database name (use `test`)
- `SESSION_SECRET` — any long random string
- `PORT`          — set automatically by Render

The bundle serves the React site from `./public` and the API under `/api/*`.
