require("dotenv").config();

const express = require("express");

const helmet = require("helmet");

const cors = require("cors");

const rateLimit = require("express-rate-limit");

const fs = require("fs");

const path = require("path");

const crypto = require("crypto");

const {ethers: ethers} = require("ethers");

const PORT = process.env.PORT || process.env.CHAIN_PORT || 3002;

const ADMIN_KEY = process.env.ADMIN_KEY || "";

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;

const CONTRACT_ADDRESS = process.env.DROPALPHA_CONTRACT_ADDRESS || "0x435D62839ce479fD479E87A8607f7fFdbdEe8bA3";

const POLL_INTERVAL_MS = Number(process.env.CHAIN_POLL_INTERVAL_MS || 15e3);

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

const RPC_URL = process.env.RPC_URL || (ALCHEMY_API_KEY ? `https://robinhood-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}` : "https://rpc.mainnet.chain.robinhood.com");

const REWARD_QUEUE_PATH = path.join(__dirname, "reward-queue.json");

function loadRewardQueue() {
  try {
    return JSON.parse(fs.readFileSync(REWARD_QUEUE_PATH, "utf8"));
  } catch (e) {
    return [];
  }
}

function saveRewardQueue(queue) {
  try {
    atomicWrite(REWARD_QUEUE_PATH, JSON.stringify(queue, null, 2));
  } catch (e) {
    console.error("[Rewards] failed to persist queue:", e.message);
  }
}

function isValidAddress(addr) {
  return typeof addr === "string" && /^0x[a-fA-F0-9]{40}$/.test(addr);
}

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidXHandle(handle) {
  return typeof handle === "string" && /^[A-Za-z0-9_]{1,15}$/.test(handle);
}

function csvSafe(v) {
  const s = String(v ?? "");
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function atomicWrite(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

let fileLock = Promise.resolve();

function withFiles(fn) {
  const run = fileLock.then(fn, fn);
  fileLock = run.then(() => {}, () => {});
  return run;
}

const ERC20_TRANSFER_ABI = [ "event Transfer(address indexed from, address indexed to, uint256 value)", "function balanceOf(address owner) view returns (uint256)", "function decimals() view returns (uint8)" ];

const BLOCKSCOUT_BASE = process.env.BLOCKSCOUT_BASE || "https://robinhoodchain.blockscout.com";

if (!ALCHEMY_API_KEY && !process.env.RPC_URL) {
  console.warn("[Chain] No ALCHEMY_API_KEY — using public Robinhood RPC.");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);

const contract = new ethers.Contract(CONTRACT_ADDRESS, ERC20_TRANSFER_ABI, provider);

let latestSnapshot = {
  block: null,
  holderCount: null
};

const PLAYERS_PATH = path.join(__dirname, "players.json");

let tokenDecimals = null;

function loadPlayers() {
  try {
    return JSON.parse(fs.readFileSync(PLAYERS_PATH, "utf8"));
  } catch (e) {
    return {};
  }
}

function savePlayers(players) {
  try {
    atomicWrite(PLAYERS_PATH, JSON.stringify(players, null, 2));
  } catch (e) {
    console.error("[Leaderboard] failed to persist players:", e.message);
  }
}

function todayUTC() {
  return (new Date).toISOString().slice(0, 10);
}

function yesterdayUTC() {
  return new Date(Date.now() - 864e5).toISOString().slice(0, 10);
}

async function getDropaBalance(wallet) {
  if (tokenDecimals === null) {
    tokenDecimals = await contract.decimals();
  }
  const raw = await contract.balanceOf(wallet);
  return Number(ethers.formatUnits(raw, tokenDecimals));
}

function computeScore(player) {
  const gamePoints = Math.max(0, Math.min(Number(player.bestScore) || 0, 1e6));
  const stageCap = Math.max(0, Math.min(Number(player.highestStage) || 0, 18));
  return {
    balancePoints: 0,
    gamePoints: gamePoints + stageCap * 10,
    checkinPoints: 0,
    total: gamePoints + stageCap * 10
  };
}

const HOLDER_BADGE_THRESHOLD = Number(process.env.HOLDER_BADGE_THRESHOLD || 1e3);

function computeBadges(player) {
  const badges = [];
  if ((player.cachedBalance || 0) >= HOLDER_BADGE_THRESHOLD) {
    badges.push({
      id: "verified_holder",
      label: "Verified Holder",
      icon: "🟡"
    });
  }
  if ((player.checkinStreak || 0) >= 30) {
    badges.push({
      id: "streak_30",
      label: "30-Day Flame",
      icon: "🔥"
    });
  } else if ((player.checkinStreak || 0) >= 7) {
    badges.push({
      id: "streak_7",
      label: "7-Day Flame",
      icon: "🔥"
    });
  }
  const stage = player.highestStage || 0;
  if (stage >= 18) {
    badges.push({
      id: "palace_reached",
      label: "Reached the Palace",
      icon: "👑"
    });
  } else if (stage >= 9) {
    badges.push({
      id: "wanderer",
      label: "Wanderer (3 stations)",
      icon: "🥾"
    });
  } else if (stage >= 3) {
    badges.push({
      id: "explorer",
      label: "Explorer (1 station)",
      icon: "🧭"
    });
  }
  return badges;
}

async function getRealHolderCount() {
  const url = `${BLOCKSCOUT_BASE}/api/v2/tokens/${CONTRACT_ADDRESS}/counters`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; DROPALAND/1.0; +https://dropaalpha.xyz)",
      Referer: BLOCKSCOUT_BASE + "/"
    }
  });
  if (!res.ok) throw new Error("Blockscout responded " + res.status);
  const data = await res.json();
  const count = Number(data.token_holders_count);
  if (!Number.isFinite(count)) throw new Error("Blockscout returned a non-numeric holder count");
  return count;
}

async function pollChain() {
  try {
    const currentBlock = await provider.getBlockNumber();
    latestSnapshot.block = currentBlock;
  } catch (err) {
    console.error("[Chain] block poll failed:", err.message);
  }
  try {
    latestSnapshot.holderCount = await getRealHolderCount();
  } catch (err) {
    console.error("[Chain] holder poll failed:", err.message);
  }
}

const app = express();

app.use(helmet());

app.use(cors(ALLOWED_ORIGINS.length > 0 ? {
  origin: ALLOWED_ORIGINS
} : {
  origin: false
}));

app.use(express.json({
  limit: "10kb"
}));

app.use(express.urlencoded({
  extended: true,
  limit: "10kb"
}));

app.use("/api/", rateLimit({
  windowMs: 60 * 1e3,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
}));

app.use("/api/reward-submit", rateLimit({
  windowMs: 60 * 60 * 1e3,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false
}));

if (process.env.TRUST_PROXY) {
  app.set("trust proxy", 1);
}

const SESSION_SECRET = process.env.JWT_SECRET || process.env.ADMIN_KEY || "";

const nonces = new Map;

function adminOk(req) {
  const provided = String(req.headers["x-admin-key"] || req.query.key || req.body?.key || "");
  if (!ADMIN_KEY || !provided) return false;
  const a = Buffer.from(String(provided).padEnd(64, "\0"));
  const b = Buffer.from(String(ADMIN_KEY).padEnd(64, "\0"));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function makeToken(wallet) {
  const exp = Date.now() + 7 * 24 * 3600 * 1e3;
  const payload = Buffer.from(JSON.stringify({
    w: String(wallet).toLowerCase(),
    exp: exp
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET || "dev-only").update(payload).digest("base64url");
  return payload + "." + sig;
}

function readToken(token) {
  if (!token || !SESSION_SECRET) return null;
  const parts = String(token).split(".");
  if (parts.length !== 2) return null;
  const expect = crypto.createHmac("sha256", SESSION_SECRET).update(parts[0]).digest("base64url");
  const a = Buffer.from(expect);
  const b = Buffer.from(parts[1]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!data || data.exp < Date.now() || !isValidAddress(data.w)) return null;
    return String(data.w).toLowerCase();
  } catch (e) {
    return null;
  }
}

function requireWallet(req, res, next) {
  const hdr = String(req.headers.authorization || "");
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  const wallet = readToken(token);
  if (!wallet) {
    return res.status(401).json({
      ok: false,
      error: "sign-in required"
    });
  }
  req.wallet = wallet;
  next();
}

app.get("/api/auth/nonce", (req, res) => {
  const wallet = String(req.query.wallet || "").toLowerCase();
  if (!isValidAddress(wallet)) return res.status(400).json({
    ok: false,
    error: "Invalid wallet address."
  });
  const nonce = crypto.randomBytes(16).toString("hex");
  nonces.set(wallet, {
    nonce: nonce,
    exp: Date.now() + 5 * 60 * 1e3
  });
  res.json({
    ok: true,
    message: "DROPALAND login\n" + wallet + "\nnonce:" + nonce
  });
});

app.post("/api/auth/verify", (req, res) => {
  const wallet = String(req.body?.wallet || "").toLowerCase();
  const sig = String(req.body?.sig || "");
  const rec = nonces.get(wallet);
  if (!isValidAddress(wallet) || !rec || rec.exp < Date.now()) {
    return res.status(400).json({
      ok: false,
      error: "nonce expired"
    });
  }
  if (!SESSION_SECRET) {
    return res.status(503).json({
      ok: false,
      error: "JWT_SECRET not set"
    });
  }
  let recovered;
  try {
    recovered = ethers.verifyMessage("DROPALAND login\n" + wallet + "\nnonce:" + rec.nonce, sig);
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: "bad signature"
    });
  }
  if (recovered.toLowerCase() !== wallet) {
    return res.status(401).json({
      ok: false,
      error: "not owner"
    });
  }
  nonces.delete(wallet);
  res.json({
    ok: true,
    token: makeToken(wallet)
  });
});

app.get("/api/chain-state", (req, res) => {
  res.json({
    ok: true,
    ...latestSnapshot
  });
});

app.post("/api/reward-submit", requireWallet, (req, res) => {
  const wallet = req.wallet;
  const {email: email, xHandle: xHandle, tasks: tasks, company: company, progress: progress} = req.body || {};
  if (typeof company === "string" && company.trim().length > 0) {
    return res.json({
      ok: true,
      message: "Submitted for review."
    });
  }
  if (!isValidAddress(wallet)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid wallet address."
    });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid email address."
    });
  }
  if (!isValidXHandle(xHandle)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid X handle."
    });
  }
  const safeTasks = {
    followed: Boolean(tasks?.followed),
    reposted: Boolean(tasks?.reposted),
    commented: Boolean(tasks?.commented)
  };
  if (!safeTasks.followed || !safeTasks.reposted || !safeTasks.commented) {
    return res.status(400).json({
      ok: false,
      error: "All tasks must be completed first."
    });
  }
  const safeProgress = {
    levelsCompleted: Array.isArray(progress?.levelsCompleted) ? progress.levelsCompleted.slice(0, 200).filter(n => Number.isFinite(n)) : [],
    highestStage: Number.isFinite(progress?.highestStage) ? progress.highestStage : 0
  };
  return withFiles(() => {
    const queue = loadRewardQueue();
    queue.push({
      id: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
      wallet: wallet,
      email: email,
      xHandle: xHandle,
      tasksSelfReported: safeTasks,
      progress: safeProgress,
      verdict: "pending",
      submittedAt: (new Date).toISOString(),
      ip: req.ip
    });
    saveRewardQueue(queue);
    res.json({
      ok: true,
      message: "Submitted for review. Rewards are distributed manually in batches — this is not an instant payout."
    });
  });
});

app.get("/health", (req, res) => res.json({
  ok: true
}));

app.post("/api/checkin", requireWallet, async (req, res) => {
  const wallet = req.wallet;
  let balance = null, at = null;
  try {
    balance = await getDropaBalance(wallet);
    at = (new Date).toISOString();
  } catch (e) {
    console.warn("[Leaderboard] balance read failed for", wallet, e.message);
  }
  return withFiles(() => {
    const players = loadPlayers();
    const player = players[wallet] || {
      checkinStreak: 0,
      totalCheckins: 0,
      lastCheckInDate: null,
      highestStage: 0,
      bestScore: 0,
      cachedBalance: 0,
      cachedBalanceAt: null
    };
    const today = todayUTC();
    if (player.lastCheckInDate === today) {
      return res.status(409).json({
        ok: false,
        error: "Already checked in today. Come back tomorrow."
      });
    }
    player.checkinStreak = player.lastCheckInDate === yesterdayUTC() ? player.checkinStreak + 1 : 1;
    player.totalCheckins += 1;
    player.lastCheckInDate = today;
    if (balance != null) {
      player.cachedBalance = balance;
      player.cachedBalanceAt = at;
    }
    players[wallet] = player;
    savePlayers(players);
    res.json({
      ok: true,
      streak: player.checkinStreak,
      totalCheckins: player.totalCheckins,
      score: computeScore(player),
      badges: computeBadges(player)
    });
  });
});

app.post("/api/game-score", requireWallet, async (req, res) => {
  const wallet = req.wallet;
  const highestStage = Number(req.body?.highestStage);
  const bestScore = Number(req.body?.bestScore);
  if (!Number.isFinite(highestStage)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid stage value."
    });
  }
  const stage = Math.max(0, Math.min(highestStage, 18));
  const scoreIn = Number.isFinite(bestScore) ? Math.max(0, Math.min(bestScore, 1e6)) : 0;
  let balance = null, at = null;
  try {
    balance = await getDropaBalance(wallet);
    at = (new Date).toISOString();
  } catch (e) {
    console.warn("[Leaderboard] balance read failed for", wallet, e.message);
  }
  return withFiles(() => {
    const players = loadPlayers();
    const player = players[wallet] || {
      checkinStreak: 0,
      totalCheckins: 0,
      lastCheckInDate: null,
      highestStage: 0,
      bestScore: 0,
      cachedBalance: 0,
      cachedBalanceAt: null
    };
    player.highestStage = Math.max(player.highestStage || 0, stage);
    player.bestScore = Math.max(player.bestScore || 0, scoreIn);
    if (balance != null) {
      player.cachedBalance = balance;
      player.cachedBalanceAt = at;
    }
    players[wallet] = player;
    savePlayers(players);
    res.json({
      ok: true,
      score: computeScore(player),
      badges: computeBadges(player)
    });
  });
});

app.get("/api/leaderboard", (req, res) => {
  const players = loadPlayers();
  const rows = Object.entries(players).map(([wallet, p]) => ({
    wallet: wallet,
    streak: p.checkinStreak || 0,
    totalCheckins: p.totalCheckins || 0,
    highestStage: p.highestStage || 0,
    balance: p.cachedBalance || 0,
    score: computeScore(p),
    badges: computeBadges(p)
  })).sort((a, b) => b.score.total - a.score.total).slice(0, 100).map((row, i) => ({
    rank: i + 1,
    medal: i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : null,
    ...row
  }));
  res.json({
    ok: true,
    leaderboard: rows
  });
});

app.get("/admin/reward-queue", (req, res) => {
  if (!adminOk(req)) {
    return res.status(403).send("Forbidden — set ADMIN_KEY in .env and pass x-admin-key (or ?key=) to view this.");
  }
  const queue = loadRewardQueue();
  const key = encodeURIComponent(req.query.key);
  const walletCounts = {}, emailCounts = {}, xCounts = {};
  queue.forEach(e => {
    walletCounts[e.wallet] = (walletCounts[e.wallet] || 0) + 1;
    emailCounts[e.email] = (emailCounts[e.email] || 0) + 1;
    const x = String(e.xHandle || "").toLowerCase();
    if (x) xCounts[x] = (xCounts[x] || 0) + 1;
  });
  const verdictBadge = {
    approved: "✅ approved",
    rejected: "❌ rejected",
    pending: "⏳ pending"
  };
  const rows = queue.map((entry, i) => {
    const isDupWallet = walletCounts[entry.wallet] > 1;
    const isDupEmail = emailCounts[entry.email] > 1;
    const isDupX = xCounts[String(entry.xHandle || "").toLowerCase()] > 1;
    const verdict = entry.verdict || "pending";
    return `\n      <tr style="${verdict === "approved" ? "background:#0d2416;" : verdict === "rejected" ? "background:#2a0d0d;" : ""}">\n        <td>${i + 1}</td>\n        <td>@${escapeHtml(entry.xHandle || "")} ${isDupX ? '<span style="color:#ff8a4a;">⚠️ dup</span>' : ""}</td>\n        <td>${escapeHtml(entry.email || "")} ${isDupEmail ? '<span style="color:#ff8a4a;">⚠️ dup</span>' : ""}</td>\n        <td style="font-family:monospace;font-size:12px;">${escapeHtml(entry.wallet || "")} ${isDupWallet ? '<span style="color:#ff8a4a;">⚠️ dup</span>' : ""}</td>\n        <td>${entry.tasksSelfReported?.followed ? "✓" : "—"}</td>\n        <td>${entry.tasksSelfReported?.reposted ? "✓" : "—"}</td>\n        <td>${entry.tasksSelfReported?.commented ? "✓" : "—"}</td>\n        <td>${entry.progress?.highestStage ?? 0}</td>\n        <td>${escapeHtml(entry.submittedAt || "")}</td>\n        <td>${verdictBadge[verdict]}</td>\n        <td>\n          <form method="POST" action="/admin/reward-queue/verdict" style="display:inline;">\n            <input type="hidden" name="id" value="${escapeHtml(entry.id)}">\n            <input type="hidden" name="key" value="${key}">\n            <input type="hidden" name="verdict" value="approved">\n            <button type="submit" style="background:#2f6a3a;color:#fff;border:0;padding:4px 8px;border-radius:3px;cursor:pointer;">Approve</button>\n          </form>\n          <form method="POST" action="/admin/reward-queue/verdict" style="display:inline;">\n            <input type="hidden" name="id" value="${escapeHtml(entry.id)}">\n            <input type="hidden" name="key" value="${key}">\n            <input type="hidden" name="verdict" value="rejected">\n            <button type="submit" style="background:#6a2f2f;color:#fff;border:0;padding:4px 8px;border-radius:3px;cursor:pointer;">Reject</button>\n          </form>\n        </td>\n      </tr>`;
  }).join("");
  const approvedCount = queue.filter(e => e.verdict === "approved").length;
  res.send(`\n    <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Reward Queue</title>\n    <style>\n      body{ font-family:monospace; background:#070912; color:#EAF0E6; padding:20px; }\n      table{ border-collapse:collapse; width:100%; font-size:13px; }\n      th,td{ border:1px solid #234; padding:6px 10px; text-align:left; }\n      th{ background:#0d1120; }\n      a.dl{ color:#FFD24C; }\n    </style></head><body>\n    <h2>Reward Queue (${queue.length} submissions, ${approvedCount} approved)</h2>\n    <p>Cross-check each handle against what Grok/X tells you, click Approve or Reject, then\n       <a class="dl" href="/admin/payment-list?key=${key}">download the final payment list (CSV)</a>.</p>\n    <table>\n      <tr><th>#</th><th>X Handle</th><th>Email</th><th>Wallet</th><th>Followed</th><th>Reposted</th><th>Commented</th><th>Highest Stage</th><th>Submitted At</th><th>Verdict</th><th>Action</th></tr>\n      ${rows}\n    </table>\n    </body></html>\n  `);
});

app.post("/admin/reward-queue/verdict", (req, res) => {
  if (!adminOk(req)) {
    return res.status(403).send("Forbidden.");
  }
  const {id: id, verdict: verdict} = req.body;
  if (![ "approved", "rejected", "pending" ].includes(verdict)) {
    return res.status(400).send("Invalid verdict.");
  }
  return withFiles(() => {
    const queue = loadRewardQueue();
    const entry = queue.find(e => e.id === id);
    if (entry) {
      entry.verdict = verdict;
      saveRewardQueue(queue);
    }
    res.redirect("/admin/reward-queue?key=" + encodeURIComponent(req.body.key || ""));
  });
});

app.get("/admin/payment-list", (req, res) => {
  if (!adminOk(req)) {
    return res.status(403).send("Forbidden.");
  }
  const queue = loadRewardQueue();
  const seen = new Set;
  const approved = queue.filter(e => {
    if (e.verdict !== "approved") return false;
    if (seen.has(e.wallet)) return false;
    seen.add(e.wallet);
    return true;
  });
  const csvLines = [ "wallet,xHandle,email" ];
  approved.forEach(e => {
    csvLines.push([ csvSafe(e.wallet), csvSafe(e.xHandle), csvSafe(e.email) ].join(","));
  });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="dropaland-payment-list.csv"');
  res.send(csvLines.join("\n"));
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

app.use((err, req, res, next) => {
  console.error("[Chain] unhandled error:", err);
  res.status(500).json({
    ok: false,
    error: "internal error"
  });
});

pollChain();

setInterval(pollChain, POLL_INTERVAL_MS);

app.listen(PORT, () => {
  console.log(`[Chain] Robinhood Chain bridge listening on http://localhost:${PORT}`);
  console.log(`[Chain] Watching DropAlpha contract ${CONTRACT_ADDRESS}`);
  if (!ADMIN_KEY) {
    console.warn("[Rewards] ADMIN_KEY not set in .env — /admin/reward-queue will refuse all requests until you set one.");
  }
});
