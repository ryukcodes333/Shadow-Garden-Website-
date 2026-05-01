# Shadow Garden — Website v2

## Requirements
- Node.js 18 or higher (https://nodejs.org/)
- MongoDB Atlas free cluster (https://www.mongodb.com/atlas)

## Quick Start (Local)

1. Copy `.env.example` → `.env` and fill in your values
2. Run: `node server.mjs`
3. Open: http://localhost:3000

No `npm install` needed — everything is bundled.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| MONGO_URI | Yes | MongoDB connection string |
| PORT | No | Server port (default: 3000) |
| OWNER_PHONE | No | Owner phone digits (e.g. 2348012345678) |
| STAFF_PHONES | No | Comma-separated staff phone digits |

## Deploy to Render

1. Create a new **Web Service** on Render
2. Upload / connect this project
3. Set **Build Command**: *(leave blank)*
4. Set **Start Command**: `node server.mjs`
5. Add environment variables from `.env.example`
6. Deploy!

## Features
- Daily rewards with 5-tier streak system
- Real-time auction house (staff only creates auctions)
- Live card trading market between players
- Profile background customization
- Pokémon party/PC management
- Global leaderboard, card gallery, shop
- Socket.io for real-time updates
