import express from "express";
import { createServer } from "node:http";
import { Server as SocketIO } from "socket.io";
import cookieParser from "cookie-parser";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 3000);
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || "";
const SESSION_TTL_DAYS = 30;
const COOKIE_NAME = "sg_session";
const OWNER_PHONE = process.env.OWNER_PHONE || "";   // set to your phone digits
const STAFF_PHONES = (process.env.STAFF_PHONES || OWNER_PHONE)
  .split(",").map(s => s.trim()).filter(Boolean);

// ─── MongoDB ──────────────────────────────────────────────────────────────────
let _client = null;
async function getDb() {
  if (!_client) {
    _client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    await _client.connect();
  }
  return _client.db();
}
async function coll(name) {
  const db = await getDb();
  return db.collection(name);
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────
function normalizePhone(input) {
  return String(input || "").replace(/[^\d]/g, "");
}

async function findAllUserDocsByPhone(phone) {
  const digits = normalizePhone(phone);
  if (!digits) return [];
  const users = await coll("users");
  return users.find({
    $or: [
      { phone: digits },
      { _id: `${digits}@s.whatsapp.net` },
      { _id: `${digits}@c.us` },
      { _id: `${digits}@lid` },
      { aliased_phone: digits },
    ],
  }).toArray();
}

function userScore(u) {
  const isLid = String(u._id).endsWith("@lid") ? 1 : 0;
  return (
    isLid * 1e16 +
    (Number(u.level) || 0) * 1e9 +
    (Number(u.xp) || 0) * 1e3 +
    (Number(u.balance) || 0) +
    (u.web_password_hash ? 1 : 0)
  );
}

async function findCanonicalUserByPhone(phone) {
  const candidates = await findAllUserDocsByPhone(phone);
  if (!candidates.length) return null;
  candidates.sort((a, b) => userScore(b) - userScore(a));
  return candidates[0];
}

async function consolidateUser(phone) {
  const digits = normalizePhone(phone);
  if (!digits) return null;
  const docs = await findAllUserDocsByPhone(digits);
  if (!docs.length) return null;
  docs.sort((a, b) => userScore(b) - userScore(a));
  const canonical = docs[0];
  const canonicalId = String(canonical._id);
  if (docs.length === 1) {
    if (canonical.phone !== digits) {
      const users = await coll("users");
      await users.updateOne({ _id: canonical._id }, { $set: { phone: digits } });
      canonical.phone = digits;
    }
    return canonical;
  }
  const num = (v) => (typeof v === "number" ? v : Number(v) || 0);
  const merged = {
    level: Math.max(1, ...docs.map((d) => num(d.level))),
    xp: Math.max(0, ...docs.map((d) => num(d.xp))),
    balance: Math.max(0, ...docs.map((d) => num(d.balance))),
    bank: Math.max(0, ...docs.map((d) => num(d.bank))),
    gems: Math.max(0, ...docs.map((d) => num(d.gems))),
    last_daily: Math.max(0, ...docs.map((d) => num(d.last_daily))),
    phone: digits,
    premium: docs.some((d) => Boolean(d.premium)),
    role: canonical.role || docs.find((d) => d.role && d.role !== "user")?.role || "user",
    registered: docs.some((d) => Number(d.registered) === 1 || d.registered === true) ? 1 : 0,
    web_password_hash: canonical.web_password_hash || docs.find((d) => d.web_password_hash)?.web_password_hash,
  };
  const users = await coll("users");
  const inv = await coll("inventory");
  const setMerged = {
    level: merged.level, xp: merged.xp, balance: merged.balance,
    bank: merged.bank, gems: merged.gems, last_daily: merged.last_daily,
    phone: digits, premium: merged.premium, role: merged.role,
    registered: merged.registered, aliased_phone: digits,
  };
  if (merged.web_password_hash) setMerged.web_password_hash = merged.web_password_hash;
  await users.updateOne({ _id: canonical._id }, { $set: setMerged });
  for (const d of docs) {
    if (String(d._id) === canonicalId) continue;
    await users.updateOne({ _id: d._id }, { $set: { ...setMerged, aliased_to: canonicalId } });
    const dupInv = await inv.find({ user_id: String(d._id) }).toArray();
    for (const it of dupInv) {
      const qty = Number(it.quantity) || 1;
      await inv.updateOne(
        { user_id: canonicalId, item: String(it.item) },
        { $inc: { quantity: qty }, $setOnInsert: { user_id: canonicalId, item: String(it.item) } },
        { upsert: true }
      );
      await inv.deleteOne({ user_id: String(d._id), item: String(it.item) });
    }
  }
  return { ...canonical, ...setMerged };
}

async function mirrorWrite(phone, update) {
  const digits = normalizePhone(phone);
  if (!digits) return;
  const docs = await findAllUserDocsByPhone(digits);
  if (docs.length <= 1) return;
  const users = await coll("users");
  await users.updateMany({ _id: { $in: docs.map((d) => d._id) } }, update);
}

async function createSession(userId) {
  const sessions = await coll("web_sessions");
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 3600 * 1000);
  await sessions.insertOne({ _id: token, user_id: userId, created_at: now, expires_at: expires });
  return token;
}

async function getSession(token) {
  if (!token) return null;
  const sessions = await coll("web_sessions");
  const s = await sessions.findOne({ _id: token });
  if (!s) return null;
  if (s.expires_at && s.expires_at.getTime() < Date.now()) {
    await sessions.deleteOne({ _id: token });
    return null;
  }
  return s;
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true, secure: true, sameSite: "lax",
    maxAge: SESSION_TTL_DAYS * 24 * 3600 * 1000, path: "/",
  });
}

function readToken(req) {
  return (req.cookies && req.cookies[COOKIE_NAME]) || "";
}

async function requireAuth(req, res, next) {
  const token = readToken(req);
  const session = await getSession(token);
  if (!session) { res.status(401).json({ error: "unauthorized" }); return; }
  const users = await coll("users");
  let user = await users.findOne({ _id: session.user_id });
  if (!user) { res.status(401).json({ error: "unauthorized" }); return; }
  if (user.aliased_to && user.aliased_to !== user._id) {
    const aliased = await users.findOne({ _id: String(user.aliased_to) });
    if (aliased) user = aliased;
  }
  if (user.phone) consolidateUser(String(user.phone)).catch(() => {});
  req.user = user;
  req.sessionToken = token;
  next();
}

async function requireStaff(req, res, next) {
  await requireAuth(req, res, () => {
    const u = req.user;
    const role = String(u.role || "user");
    const phone = String(u.phone || normalizePhone(String(u._id).split("@")[0]));
    const isStaff =
      role === "owner" || role === "admin" || role === "staff" || role === "mod" ||
      STAFF_PHONES.includes(phone);
    if (!isStaff) { res.status(403).json({ error: "forbidden" }); return; }
    next();
  });
}

function userPayload(u) {
  const phone = u.phone || normalizePhone(String(u._id).split("@")[0] || "");
  const isStaff =
    ["owner", "admin", "staff", "mod"].includes(String(u.role || "user")) ||
    STAFF_PHONES.includes(phone);
  return {
    id: String(u._id),
    phone,
    name: u.name || "",
    level: Number(u.level) || 1,
    xp: Number(u.xp) || 0,
    balance: Number(u.balance) || 0,
    bank: Number(u.bank) || 0,
    bank_max: Number(u.bank_max) || 100000,
    gems: Number(u.gems) || 0,
    premium: Boolean(u.premium),
    role: String(u.role || "user"),
    is_staff: isStaff,
    profile_bg: u.profile_bg || "",
    bio: u.bio || "",
  };
}

// ─── Daily rewards ────────────────────────────────────────────────────────────
const DAILY_POOLS = {
  coins:  [200, 300, 500, 750, 1000],
  gems:   [0, 0, 1, 2, 5],
  xp:     [50, 75, 100, 150, 200],
  items:  [null, null, "Mystery Box", "Potion", "Rare Candy", null, null],
};
function rollDaily(streak = 0) {
  const idx = Math.min(streak, DAILY_POOLS.coins.length - 1);
  const coins = DAILY_POOLS.coins[idx];
  const gems = DAILY_POOLS.gems[idx];
  const xp = DAILY_POOLS.xp[idx];
  const pool = DAILY_POOLS.items;
  const item = pool[Math.floor(Math.random() * pool.length)];
  return { coins, gems, xp, item };
}

// ─── Auction in-memory store ──────────────────────────────────────────────────
// auctionId → { id, card, startingBid, currentBid, highestBidder, endsAt, createdBy, status }
const auctionStore = new Map();
let auctionSeq = 0;

// ─── Express app + Socket.io ──────────────────────────────────────────────────
const app = express();
const httpServer = createServer(app);
const io = new SocketIO(httpServer, {
  cors: { origin: true, credentials: true },
  path: "/socket.io",
});

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/api/healthz", (_req, res) => res.json({ ok: true }));

// ─── Public routes ────────────────────────────────────────────────────────────
app.get("/api/public/stats", async (_req, res) => {
  try {
    const users = await coll("users");
    const inv = await coll("inventory");
    const cards = await coll("cards");
    const [userCount, cardCount, invCount] = await Promise.all([
      users.countDocuments({ is_bot: { $ne: true } }),
      cards.countDocuments({}),
      inv.countDocuments({}),
    ]);
    res.json({ users: userCount, cards: cardCount, trades: invCount });
  } catch (err) {
    res.json({ users: 0, cards: 0, trades: 0 });
  }
});

app.get("/api/public/cards", async (req, res) => {
  try {
    const cards = await coll("cards");
    const inv = await coll("inventory");
    const { page = "1", limit = "20", search = "", tier = "" } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
    const filter = {};
    if (search) filter.name = { $regex: search, $options: "i" };
    if (tier) filter.tier = tier;
    const [docs, total] = await Promise.all([
      cards.find(filter).skip((pageNum - 1) * limitNum).limit(limitNum).toArray(),
      cards.countDocuments(filter),
    ]);
    const names = docs.map((d) => String(d.name || ""));
    const grouped = await inv.aggregate([
      { $match: { item: { $in: names } } },
      { $group: { _id: "$item", count: { $sum: 1 } } },
    ]).toArray();
    const ownerCounts = new Map(grouped.map((g) => [String(g._id), g.count]));
    res.json({
      cards: docs.map((d) => ({
        id: String(d._id),
        name: String(d.name || ""),
        tier: String(d.tier || "T1"),
        series: String(d.series || ""),
        image_url: d.image_url || "",
        owners: ownerCounts.get(String(d.name || "")) || 0,
      })),
      total,
      page: pageNum,
    });
  } catch (err) {
    res.status(500).json({ error: "cards_failed" });
  }
});

app.get("/api/public/cards/:id/image", async (req, res) => {
  try {
    const cards = await coll("cards");
    let filter;
    try { filter = ObjectId.isValid(req.params.id) ? { _id: new ObjectId(req.params.id) } : { name: req.params.id }; }
    catch { filter = { name: req.params.id }; }
    const card = await cards.findOne(filter);
    if (!card || !card.image_url) { res.status(404).json({ error: "not_found" }); return; }
    res.redirect(card.image_url);
  } catch {
    res.status(500).json({ error: "image_failed" });
  }
});

app.get("/api/public/leaderboard", async (_req, res) => {
  try {
    const users = await coll("users");
    const inv = await coll("inventory");
    const top = await users.find({ is_bot: { $ne: true }, level: { $exists: true } })
      .sort({ level: -1, xp: -1 }).limit(50).toArray();
    const ids = top.map((u) => String(u._id));
    const grouped = await inv.aggregate([
      { $match: { user_id: { $in: ids } } },
      { $group: { _id: "$user_id", count: { $sum: "$quantity" } } },
    ]).toArray();
    const cardCount = new Map(grouped.map((g) => [String(g._id), g.count]));
    res.json({
      entries: top.map((u, i) => ({
        rank: i + 1,
        id: String(u._id),
        name: u.name || "Trainer",
        level: Number(u.level) || 1,
        xp: Number(u.xp) || 0,
        balance: Number(u.balance) || 0,
        gems: Number(u.gems) || 0,
        premium: Boolean(u.premium),
        role: String(u.role || "user"),
        card_count: cardCount.get(String(u._id)) || 0,
      })),
    });
  } catch {
    res.status(500).json({ error: "leaderboard_failed" });
  }
});

app.get("/api/public/pokemons", async (req, res) => {
  try {
    const pokemons = await coll("pokemons");
    const { search = "", type = "" } = req.query;
    const filter = {};
    if (search) filter.name = { $regex: search, $options: "i" };
    if (type) filter.types = type;
    const docs = await pokemons.find(filter).limit(100).toArray();
    res.json({
      pokemons: docs.map((p) => ({
        id: Number(p.id) || Number(p._id) || 0,
        name: String(p.name || ""),
        types: Array.isArray(p.types) ? p.types : [],
        sprite: p.sprite || `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${p.id || p._id}.png`,
      })),
    });
  } catch {
    res.status(500).json({ error: "pokemons_failed" });
  }
});

app.get("/api/public/shop", async (_req, res) => {
  try {
    const shop = await coll("shop_items");
    const items = await shop.find({}).limit(50).toArray();
    res.json({
      items: items.map((i) => ({
        id: String(i._id),
        name: String(i.name || ""),
        emoji: i.emoji || "🎁",
        price: Number(i.price) || 0,
        description: String(i.description || ""),
      })),
    });
  } catch {
    res.status(500).json({ error: "shop_failed" });
  }
});

// ─── Public auctions ──────────────────────────────────────────────────────────
app.get("/api/public/auctions", (_req, res) => {
  const now = Date.now();
  const active = [...auctionStore.values()].filter(
    (a) => a.status === "active" && a.endsAt > now
  );
  res.json({ auctions: active });
});

// ─── Auth routes ──────────────────────────────────────────────────────────────
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { phone, password, name } = req.body || {};
    const digits = normalizePhone(phone);
    if (!digits || digits.length < 8) { res.status(400).json({ error: "invalid_phone" }); return; }
    if (!password || String(password).length < 6) { res.status(400).json({ error: "weak_password" }); return; }
    let canonical = await consolidateUser(digits);
    if (canonical?.web_password_hash) { res.status(409).json({ error: "account_exists" }); return; }
    const hash = await bcrypt.hash(String(password), 10);
    const users = await coll("users");
    let userId;
    if (canonical) {
      userId = String(canonical._id);
      await users.updateOne({ _id: canonical._id }, {
        $set: { web_password_hash: hash, phone: digits, aliased_phone: digits, registered: 1, ...(name ? { name: String(name) } : {}) }
      });
    } else {
      userId = `${digits}@s.whatsapp.net`;
      await users.updateOne({ _id: userId }, {
        $setOnInsert: {
          _id: userId, phone: digits, aliased_phone: digits,
          name: name || "", level: 1, xp: 0, balance: 0, bank: 0, bank_max: 100000,
          gems: 0, premium: false, role: "user", is_bot: false, registered: 1,
          web_password_hash: hash, web_created_at: new Date(),
        }
      }, { upsert: true });
    }
    canonical = await consolidateUser(digits);
    const token = await createSession(String(canonical?._id || userId));
    setSessionCookie(res, token);
    res.json({ user: canonical ? userPayload(canonical) : null });
  } catch (err) {
    res.status(500).json({ error: "signup_failed" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { phone, password } = req.body || {};
    const digits = normalizePhone(phone);
    if (!digits || !password) { res.status(400).json({ error: "invalid_credentials" }); return; }
    const canonical = await consolidateUser(digits) || await findCanonicalUserByPhone(digits);
    if (!canonical?.web_password_hash) { res.status(401).json({ error: "invalid_credentials" }); return; }
    const ok = await bcrypt.compare(String(password), canonical.web_password_hash);
    if (!ok) { res.status(401).json({ error: "invalid_credentials" }); return; }
    const token = await createSession(String(canonical._id));
    setSessionCookie(res, token);
    res.json({ user: userPayload(canonical) });
  } catch {
    res.status(500).json({ error: "login_failed" });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  const token = readToken(req);
  if (token) {
    const sessions = await coll("web_sessions");
    await sessions.deleteOne({ _id: token });
  }
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ user: userPayload(req.user) });
});

// ─── Me routes ────────────────────────────────────────────────────────────────
app.get("/api/me/profile", requireAuth, async (req, res) => {
  try {
    const u = req.user;
    const userId = String(u._id);
    const inv = await coll("inventory");
    const cards = await coll("cards");
    const rpg = await coll("rpg_characters");
    const [invDocs, character] = await Promise.all([
      inv.find({ user_id: userId }).toArray(),
      rpg.findOne({ _id: userId }),
    ]);
    const cardNames = await cards.find({}, { projection: { name: 1, tier: 1 } }).toArray();
    const nameToTier = new Map(cardNames.map((c) => [String(c.name || ""), String(c.tier || "T1")]));
    const ownedCards = [], items = [];
    for (const i of invDocs) {
      const qty = Number(i.quantity) || 1;
      if (nameToTier.has(String(i.item))) {
        ownedCards.push({ name: String(i.item), tier: nameToTier.get(String(i.item)), quantity: qty });
      } else {
        items.push({ item: String(i.item), quantity: qty });
      }
    }
    res.json({
      user: {
        id: userId, phone: u.phone || "", name: u.name || "",
        level: Number(u.level) || 1, xp: Number(u.xp) || 0,
        balance: Number(u.balance) || 0, bank: Number(u.bank) || 0,
        bank_max: Number(u.bank_max) || 100000, gems: Number(u.gems) || 0,
        premium: Boolean(u.premium), role: String(u.role || "user"),
        bio: String(u.bio || ""), last_daily: Number(u.last_daily) || 0,
        profile_bg: u.profile_bg || "",
        is_staff: userPayload(u).is_staff,
      },
      character: character ? {
        class: String(character.class || ""), hp: Number(character.hp) || 0,
        max_hp: Number(character.max_hp) || 0, attack: Number(character.attack) || 0,
        defense: Number(character.defense) || 0, speed: Number(character.speed) || 0,
        level: Number(character.level) || 1, xp: Number(character.xp) || 0,
        dungeon_floor: Number(character.dungeon_floor) || 0,
      } : null,
      cards: ownedCards.sort((a, b) => a.tier.localeCompare(b.tier) || a.name.localeCompare(b.name)),
      items: items.sort((a, b) => a.item.localeCompare(b.item)),
    });
  } catch (err) {
    res.status(500).json({ error: "profile_failed" });
  }
});

// Enhanced daily with streak, gems, items
app.post("/api/me/daily", requireAuth, async (req, res) => {
  try {
    const users = await coll("users");
    const u = req.user;
    const last = Number(u.last_daily) || 0;
    const now = Date.now();
    const ONE_DAY = 24 * 3600 * 1000;
    if (last && now - last < ONE_DAY) {
      res.status(429).json({ error: "already_claimed", next_in_ms: ONE_DAY - (now - last) });
      return;
    }
    const streak = (last && now - last < 2 * ONE_DAY) ? (Number(u.daily_streak) || 0) + 1 : 1;
    const reward = rollDaily(streak - 1);
    const inc = { balance: reward.coins, xp: reward.xp };
    if (reward.gems) inc.gems = reward.gems;
    await users.updateOne({ _id: u._id }, { $inc: inc, $set: { last_daily: now, daily_streak: streak } });
    if (u.phone) await mirrorWrite(String(u.phone), { $inc: inc, $set: { last_daily: now, daily_streak: streak } });
    if (reward.item) {
      const inv = await coll("inventory");
      await inv.updateOne(
        { user_id: String(u._id), item: reward.item },
        { $inc: { quantity: 1 }, $setOnInsert: { user_id: String(u._id), item: reward.item } },
        { upsert: true }
      );
    }
    res.json({ reward: reward.coins, gems: reward.gems, xp: reward.xp, item: reward.item, streak });
  } catch {
    res.status(500).json({ error: "daily_failed" });
  }
});

app.post("/api/me/shop/buy", requireAuth, async (req, res) => {
  try {
    const { itemId } = req.body || {};
    if (!itemId) { res.status(400).json({ error: "missing_item" }); return; }
    const shop = await coll("shop_items");
    let filter;
    try { filter = ObjectId.isValid(String(itemId)) ? { _id: new ObjectId(String(itemId)) } : { _id: String(itemId) }; }
    catch { res.status(400).json({ error: "bad_item" }); return; }
    const item = await shop.findOne(filter);
    if (!item) { res.status(404).json({ error: "item_not_found" }); return; }
    const users = await coll("users");
    const u = req.user;
    const balance = Number(u.balance) || 0;
    const price = Number(item.price) || 0;
    if (balance < price) { res.status(402).json({ error: "insufficient_balance", balance, price }); return; }
    const inv = await coll("inventory");
    const updated = await users.findOneAndUpdate(
      { _id: u._id, balance: { $gte: price } },
      { $inc: { balance: -price } },
      { returnDocument: "after" }
    );
    if (!updated) { res.status(402).json({ error: "insufficient_balance" }); return; }
    await inv.updateOne(
      { user_id: String(u._id), item: String(item.name) },
      { $inc: { quantity: 1 }, $setOnInsert: { user_id: String(u._id), item: String(item.name) } },
      { upsert: true }
    );
    if (u.phone) await mirrorWrite(String(u.phone), { $inc: { balance: -price } });
    res.json({ ok: true, new_balance: Number(updated.balance) || 0, item: { name: item.name, emoji: item.emoji || "🎁" } });
  } catch {
    res.status(500).json({ error: "buy_failed" });
  }
});

app.post("/api/me/relink", requireAuth, async (req, res) => {
  try {
    const u = req.user;
    const phone = String(u.phone || "");
    if (!phone) { res.status(400).json({ error: "no_phone" }); return; }
    const before = await findAllUserDocsByPhone(phone);
    const canonical = await consolidateUser(phone);
    res.json({
      canonical_id: canonical?._id || u._id,
      merged_doc_count: before.length,
      docs: before.map((d) => ({ id: String(d._id), level: Number(d.level) || 0 })),
      user: { level: Number(canonical?.level) || 1, balance: Number(canonical?.balance) || 0 },
    });
  } catch {
    res.status(500).json({ error: "relink_failed" });
  }
});

// Profile background (custom URL or preset)
app.patch("/api/me/profile-bg", requireAuth, async (req, res) => {
  try {
    const u = req.user;
    const { bg } = req.body || {};
    if (typeof bg !== "string") { res.status(400).json({ error: "missing_bg" }); return; }
    const safe = bg.slice(0, 512);
    const users = await coll("users");
    await users.updateOne({ _id: u._id }, { $set: { profile_bg: safe } });
    if (u.phone) await mirrorWrite(String(u.phone), { $set: { profile_bg: safe } });
    res.json({ profile_bg: safe });
  } catch {
    res.status(500).json({ error: "bg_update_failed" });
  }
});

// Update bio
app.patch("/api/me/bio", requireAuth, async (req, res) => {
  try {
    const u = req.user;
    const { bio } = req.body || {};
    const safe = String(bio || "").slice(0, 200);
    const users = await coll("users");
    await users.updateOne({ _id: u._id }, { $set: { bio: safe } });
    res.json({ bio: safe });
  } catch {
    res.status(500).json({ error: "bio_update_failed" });
  }
});

// Pokemon list
const ALLOWED_BACKGROUNDS = new Set(["void","sakura","city","ocean","forest","lab","shrine","stadium","shadow"]);

app.get("/api/me/pokemons", requireAuth, async (req, res) => {
  try {
    const u = req.user;
    const phone = String(u.phone || "");
    const allDocs = phone ? await findAllUserDocsByPhone(phone) : [];
    const docs = allDocs.length ? allDocs : [u];
    const parseList = (raw) => {
      if (!raw) return [];
      let v = raw;
      if (typeof v === "string") { try { v = JSON.parse(v); } catch { return []; } }
      return Array.isArray(v) ? v : [];
    };
    const items = [], seen = new Set();
    for (const doc of docs) {
      for (const [slot, payload] of [["party", doc.pokemon_party], ["pc", doc.pokemon_pc]]) {
        const list = parseList(payload);
        for (let i = 0; i < list.length; i++) {
          const p = list[i];
          const id = Number(p.id) || 0;
          if (!id) continue;
          const key = `${slot}:${id}:${Number(p.level)||1}:${i}`;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({
            key: `${slot}-${i}-${id}`, slot, id,
            name: String(p.name || `pokemon-${id}`),
            nickname: String(p.nickname || ""),
            level: Number(p.level) || 1,
            xp: Number(p.xp) || 0,
            hp: Number(p.hp) || 0,
            max_hp: Number(p.maxHp ?? p.max_hp) || 0,
            shiny: Boolean(p.shiny),
            moves: Array.isArray(p.moves) ? p.moves.map(String).slice(0, 4) : [],
            types: Array.isArray(p.types) ? p.types.map(String) : [],
            sprite: typeof p.sprite === "string" && p.sprite
              ? p.sprite
              : `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`,
            caught_at: typeof p.caught_at === "number" ? p.caught_at : 0,
          });
        }
      }
    }
    items.sort((a, b) => a.slot !== b.slot ? (a.slot === "party" ? -1 : 1) : b.level - a.level);
    res.json({ items });
  } catch {
    res.status(500).json({ error: "pokemons_failed" });
  }
});

// Move Pokémon between party and PC
app.post("/api/me/pokemons/move", requireAuth, async (req, res) => {
  try {
    const u = req.user;
    const { pokemonId, toSlot } = req.body || {};
    if (!pokemonId || !["party", "pc"].includes(toSlot)) {
      res.status(400).json({ error: "invalid_params" }); return;
    }
    const users = await coll("users");
    const doc = await users.findOne({ _id: u._id });
    const parseList = (raw) => {
      if (!raw) return [];
      try { const v = typeof raw === "string" ? JSON.parse(raw) : raw; return Array.isArray(v) ? v : []; }
      catch { return []; }
    };
    let party = parseList(doc.pokemon_party);
    let pc = parseList(doc.pokemon_pc);
    const [srcSlot, srcIdx] = pokemonId.split("-");
    const idx = parseInt(srcIdx);
    let pokemon;
    if (srcSlot === "party") {
      pokemon = party[idx];
      if (!pokemon) { res.status(404).json({ error: "not_found" }); return; }
      party = party.filter((_, i) => i !== idx);
      if (toSlot === "pc") pc.push(pokemon);
    } else {
      pokemon = pc[idx];
      if (!pokemon) { res.status(404).json({ error: "not_found" }); return; }
      pc = pc.filter((_, i) => i !== idx);
      if (toSlot === "party") party.push(pokemon);
    }
    await users.updateOne({ _id: u._id }, { $set: { pokemon_party: JSON.stringify(party), pokemon_pc: JSON.stringify(pc) } });
    res.json({ ok: true, party_count: party.length, pc_count: pc.length });
  } catch {
    res.status(500).json({ error: "move_failed" });
  }
});

app.get("/api/me/deck", requireAuth, async (req, res) => {
  try {
    const u = req.user;
    const userId = String(u._id);
    const decks = await coll("card_deck");
    const phone = String(u.phone || "");
    const altIds = [userId];
    if (phone) {
      const allDocs = await findAllUserDocsByPhone(phone);
      for (const d of allDocs) altIds.push(String(d._id));
    }
    const deck = await decks.findOne({ user_id: { $in: [...new Set(altIds)] } });
    res.json({
      cards: Array.isArray(deck?.cards) ? deck.cards : [],
      pokemons: Array.isArray(deck?.pokemons) ? deck.pokemons : [],
      background: deck?.background && ALLOWED_BACKGROUNDS.has(String(deck.background)) ? String(deck.background) : "void",
    });
  } catch {
    res.status(500).json({ error: "deck_failed" });
  }
});

app.patch("/api/me/deck", requireAuth, async (req, res) => {
  try {
    const u = req.user;
    const userId = String(u._id);
    const body = req.body || {};
    const set = { user_id: userId, updated_at: Date.now() };
    if (Array.isArray(body.cards)) set.cards = body.cards.map(String).slice(0, 12);
    if (Array.isArray(body.pokemons)) set.pokemons = body.pokemons.map(Number).filter((n) => isFinite(n) && n > 0).slice(0, 6);
    if (typeof body.background === "string") {
      if (!ALLOWED_BACKGROUNDS.has(body.background)) { res.status(400).json({ error: "bad_background" }); return; }
      set.background = body.background;
    }
    const decks = await coll("card_deck");
    await decks.updateOne({ user_id: userId }, { $set: set, $setOnInsert: { user_id: userId } }, { upsert: true });
    const updated = await decks.findOne({ user_id: userId });
    res.json({
      cards: Array.isArray(updated?.cards) ? updated.cards : [],
      pokemons: Array.isArray(updated?.pokemons) ? updated.pokemons : [],
      background: updated?.background && ALLOWED_BACKGROUNDS.has(String(updated.background)) ? String(updated.background) : "void",
    });
  } catch {
    res.status(500).json({ error: "deck_write_failed" });
  }
});

// ─── Auction routes ───────────────────────────────────────────────────────────
app.post("/api/auctions", requireStaff, async (req, res) => {
  try {
    const { card, startingBid = 500, durationMinutes = 60 } = req.body || {};
    if (!card) { res.status(400).json({ error: "missing_card" }); return; }
    const id = `auction-${++auctionSeq}-${Date.now()}`;
    const endsAt = Date.now() + Number(durationMinutes) * 60 * 1000;
    const auction = {
      id, card: String(card),
      startingBid: Number(startingBid),
      currentBid: Number(startingBid),
      highestBidder: null,
      highestBidderName: null,
      endsAt,
      createdBy: String(req.user._id),
      createdByName: String(req.user.name || "Staff"),
      status: "active",
      bids: [],
    };
    auctionStore.set(id, auction);
    io.emit("auction:new", auction);
    setTimeout(() => {
      const a = auctionStore.get(id);
      if (a && a.status === "active") {
        a.status = "ended";
        io.emit("auction:ended", { id: a.id, winner: a.highestBidder, winnerName: a.highestBidderName, finalBid: a.currentBid, card: a.card });
        auctionStore.set(id, a);
      }
    }, Number(durationMinutes) * 60 * 1000);
    res.json({ auction });
  } catch {
    res.status(500).json({ error: "auction_create_failed" });
  }
});

app.post("/api/auctions/:id/bid", requireAuth, async (req, res) => {
  try {
    const auction = auctionStore.get(req.params.id);
    if (!auction || auction.status !== "active" || auction.endsAt < Date.now()) {
      res.status(404).json({ error: "auction_not_found_or_ended" }); return;
    }
    const { amount } = req.body || {};
    const bid = Number(amount);
    if (!bid || bid <= auction.currentBid) {
      res.status(400).json({ error: "bid_too_low", minimum: auction.currentBid + 1 }); return;
    }
    const u = req.user;
    const balance = Number(u.balance) || 0;
    if (balance < bid) {
      res.status(402).json({ error: "insufficient_balance", balance, required: bid }); return;
    }
    auction.currentBid = bid;
    auction.highestBidder = String(u._id);
    auction.highestBidderName = String(u.name || u.phone || "Trainer");
    auction.bids.push({ bidder: String(u._id), name: auction.highestBidderName, amount: bid, at: Date.now() });
    auctionStore.set(req.params.id, auction);
    io.emit("auction:bid", {
      id: auction.id, card: auction.card,
      currentBid: bid, highestBidder: auction.highestBidder,
      highestBidderName: auction.highestBidderName, endsAt: auction.endsAt,
    });
    res.json({ ok: true, currentBid: bid });
  } catch {
    res.status(500).json({ error: "bid_failed" });
  }
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  const now = Date.now();
  const activeAuctions = [...auctionStore.values()].filter((a) => a.status === "active" && a.endsAt > now);
  socket.emit("auction:list", activeAuctions);
});

// ─── Static + SPA fallback ────────────────────────────────────────────────────
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR, { maxAge: "1d", index: false }));
app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`Shadow Garden v2 listening on port ${PORT}`);
  // Background: consolidate user docs
  if (MONGO_URI) {
    getDb().then(async () => {
      const users = await coll("users");
      const phones = await users.distinct("phone", { is_bot: { $ne: true }, phone: { $exists: true, $ne: "" } });
      let merged = 0;
      for (const p of phones) {
        const docs = await findAllUserDocsByPhone(String(p));
        if (docs.length > 1) { await consolidateUser(String(p)); merged++; }
      }
      console.log(`Consolidation done: ${phones.length} scanned, ${merged} merged`);
    }).catch((e) => console.error("DB init failed:", e.message));
  }
});
