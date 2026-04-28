# 🌑 Shadow Garden — Deploy on Render

Hi! This folder is your **whole website in a box**. Just 3 things live here:

```
shadow-garden/
├─ server.mjs   ← the entire backend in ONE file
├─ public/      ← the website (already built, just pictures + html)
├─ package.json ← tells Node "run server.mjs when you start"
├─ render.yaml  ← Render reads this and sets everything up for you
└─ .env.example ← list of secrets you need to fill in
```

That's it. No `npm install` needed, no build step. Render literally just runs
`node server.mjs` and your site is live.

---

## 🚀 Deploy in 4 baby steps

### Step 1 — Put this folder on GitHub
Make a brand-new empty repo on github.com. Upload **everything inside this
folder** (the `server.mjs` file, the `public` folder, `package.json`,
`render.yaml`, `.env.example`, `.gitignore`).
Don't upload `node_modules` or any `.env` file (the `.gitignore` already
protects you).

### Step 2 — Create a new Web Service on Render
1. Log in at <https://dashboard.render.com>
2. Click **New +** → **Web Service**
3. Connect your GitHub repo
4. Render will read `render.yaml` automatically. You'll see:
   - Runtime: **Node**
   - Build command: *(empty)*
   - Start command: `node server.mjs`
   - Health check: `/api/healthz`
5. Click **Create Web Service**.

### Step 3 — Add your MongoDB password
On the Render service page → **Environment** tab → add this one secret:

| Key            | Value                                                  |
| -------------- | ------------------------------------------------------ |
| `MONGODB_URI`  | your full `mongodb+srv://...` string from MongoDB Atlas |

The other variables (`NODE_ENV`, `MONGODB_DB`, `SESSION_SECRET`) are already
set up by `render.yaml` — `SESSION_SECRET` is auto-generated for you.

### Step 4 — Whitelist Render in MongoDB Atlas
In <https://cloud.mongodb.com> → **Network Access** → **Add IP Address** →
**Allow access from anywhere** (`0.0.0.0/0`). Render's IPs change, so this is
the easy way.

Done. Render will deploy and give you a URL like
`https://shadow-garden.onrender.com`. Open it — that's your site. 🎉

---

## 🧪 Run it on your computer first (optional)

```bash
# 1. Make a file called  .env  in this folder
cp .env.example .env
# 2. Edit .env and paste your MONGODB_URI
# 3. Start
PORT=3000 node --env-file=.env server.mjs
# 4. Open  http://localhost:3000
```

---

## ❓ FAQ

**Q: Do I need to run `npm install`?**
No. Everything is already bundled into `server.mjs`. Render's free Node
runtime has Node 20, that's all you need.

**Q: Where do I edit the code?**
You don't — this is the production build. Edit the original Replit project,
re-export, and replace the `server.mjs` and `public/` files here.

**Q: My WhatsApp bot writes to MongoDB. Will the website see that data?**
Yes — both apps point at the same `MONGODB_URI`. Sign up on the website with
the **same phone number** you use in the bot and your Pokémon, cards, coins
and inventory all show up automatically.

**Q: I changed my Mongo password / cluster.**
Update `MONGODB_URI` in Render → Environment, and click **Manual Deploy →
Restart**.
