// Cœur du calcul GAL — indépendant de Netlify (testable en local).
// Le client réseau, le stockage et le journal sont injectés.

export const CLAN_TAG = "GAL";
export const API = "https://api.openfront.io";

export const PERIODS = {
  all: { ms: null, label: "depuis le début", pages: 1, count: 400 },
  "30d": { ms: 30 * 24 * 3600 * 1000, label: "30 derniers jours", pages: 8, count: 100 },
  "24h": { ms: 24 * 3600 * 1000, label: "24 dernières heures", pages: 3, count: 100 }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* Client OpenFront : peu de requêtes en parallèle, pause sur 429      */
/* ------------------------------------------------------------------ */
export class OpenFrontClient {
  constructor({ base = API, maxParallel = 4, gapMs = 110, deadline = Infinity, fetchImpl = fetch } = {}) {
    this.base = base;
    this.maxParallel = maxParallel;
    this.gapMs = gapMs;
    this.deadline = deadline;
    this.fetchImpl = fetchImpl;
    this.active = 0;
    this.nextSlot = 0;
    this.blockedUntil = 0;
    this.waiters = [];
    this.requests = 0;
    this.rateLimited = 0;
  }

  async acquire() {
    for (;;) {
      const wait = this.blockedUntil - Date.now();
      if (wait > 0) { await sleep(wait); continue; }
      if (this.active >= this.maxParallel) { await new Promise((resolve) => this.waiters.push(resolve)); continue; }
      break;
    }
    this.active++;
    const now = Date.now();
    const slot = Math.max(this.nextSlot, now);
    this.nextSlot = slot + this.gapMs;
    if (slot > now) await sleep(slot - now);
  }

  release() {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }

  async get(path, { tries = 4, until = Infinity } = {}) {
    const url = path.startsWith("http") ? path : this.base + path;
    const limit = Math.min(until, this.deadline);
    let last;
    for (let attempt = 0; attempt < tries; attempt++) {
      if (Date.now() > limit) {
        const error = new Error("Temps imparti dépassé");
        error.timeout = true;
        throw error;
      }
      await this.acquire();
      let response;
      try {
        this.requests++;
        response = await this.fetchImpl(url, { signal: AbortSignal.timeout(20000), headers: { Accept: "application/json" } });
      } catch (error) {
        this.release();
        last = error;
        await sleep(600 * (attempt + 1));
        continue;
      }
      this.release();
      if (response.status === 429) {
        this.rateLimited++;
        const retryAfter = Number.parseFloat(response.headers.get("Retry-After")) || 0;
        this.blockedUntil = Date.now() + Math.max(retryAfter * 1000, 1500 * (attempt + 1));
        last = new Error("OpenFront limite les requêtes (429)");
        continue;
      }
      if (response.status === 404) {
        const error = new Error("404");
        error.status = 404;
        throw error;
      }
      if (response.status >= 500) {
        last = new Error("HTTP " + response.status);
        await sleep(900 * (attempt + 1));
        continue;
      }
      if (!response.ok) throw new Error("HTTP " + response.status);
      try {
        return await response.json();
      } catch (error) {
        last = new Error("Réponse OpenFront illisible");
      }
    }
    const error = new Error(last?.message || "OpenFront ne répond pas");
    error.busy = true;
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Formules (identiques à l'index d'origine)                           */
/* ------------------------------------------------------------------ */
const fmtN = (n) => (Math.round(n * 100) / 100).toFixed(2).replace(".", ",");
const diff = (teams) => Math.max(1, Math.sqrt(teams - 1));

function teamsOf(game) {
  const size = { Duos: 2, Trios: 3, Quads: 4 }[game.playerTeams];
  if (size && game.totalPlayers) return Math.max(2, Math.ceil(game.totalPlayers / size));
  const n = Number.parseInt(game.playerTeams, 10);
  return n >= 2 ? n : 2;
}

export function clanScore(won, teams, total, clanCount) {
  const t = Math.max(2, teams);
  const avg = Math.max(1, total / t);
  const ratio = clanCount / avg;
  return won ? ratio * diff(t) : ratio / diff(t);
}

function sessionId(x) {
  for (const key of ["gameId", "gameID", "game", "game_id", "id"]) {
    if (typeof x?.[key] === "string" && x[key].length >= 6) return x[key];
  }
  return null;
}

function sumLeaves(node, acc) {
  if (!node || typeof node !== "object") return acc;
  if ("wins" in node && !Array.isArray(node) && typeof node.wins !== "object") {
    acc.wins += Number(node.wins) || 0;
    acc.losses += Number(node.losses) || 0;
    return acc;
  }
  Object.values(node).forEach((value) => sumLeaves(value, acc));
  return acc;
}

// Même règle partout (classement ALL, liste des membres, fiche joueur) : `stats.total` d'abord.
export function statsFromObject(obj) {
  if (!obj) return null;
  const total = obj.stats?.total || obj.player?.stats?.total || obj.total;
  if (total && (total.wins != null || total.losses != null)) {
    const wins = Number(total.wins) || 0;
    const losses = Number(total.losses) || 0;
    const games = wins + losses;
    return { wins, losses, games, rate: games > 0 ? Math.round((wins / games) * 100) : 0 };
  }
  const acc = sumLeaves(obj.stats || obj.player?.stats || obj, { wins: 0, losses: 0 });
  if (!acc.wins && !acc.losses) return null;
  const games = acc.wins + acc.losses;
  return { wins: acc.wins, losses: acc.losses, games, rate: games > 0 ? Math.round((acc.wins / games) * 100) : 0 };
}

const emptyStats = { wins: 0, losses: 0, games: 0, rate: 0 };

function normMember(raw) {
  const stats = statsFromObject(raw) || emptyStats;
  return {
    publicId: raw.publicId,
    username: raw.username || raw.publicId,
    role: raw.role || "",
    wins: stats.wins,
    losses: stats.losses
  };
}

const winsLine = (wins) => wins + (wins > 1 ? " victoires" : " victoire");

function fillMissing(list, members, period) {
  const have = new Set(list.map((player) => player.publicId));
  const extra = [];
  members.forEach((member) => {
    if (have.has(member.publicId)) return;
    if (period === "all") {
      const games = member.wins + member.losses;
      extra.push({
        name: member.username, publicId: member.publicId, value: member.wins, games,
        main: winsLine(member.wins),
        sub: "ratio " + (games ? Math.round((member.wins / games) * 100) : 0) + " % · " + games + " parties"
      });
    } else {
      extra.push({ name: member.username, publicId: member.publicId, value: 0, games: 0, main: "+0,00 pts", sub: "aucune partie" });
    }
  });
  return list.concat(extra).sort((a, b) =>
    b.value - a.value || b.games - a.games || String(a.name).localeCompare(String(b.name)));
}

const byActivity = (a, b) => (b.wins + b.losses) - (a.wins + a.losses);

/* ------------------------------------------------------------------ */
/* Étapes de calcul                                                    */
/* ------------------------------------------------------------------ */
export async function fetchMembers(client) {
  const first = await client.get(`/public/clan/${CLAN_TAG}/members?limit=50&page=1`);
  let raw = first.results || [];
  const pages = Math.min(Math.ceil((first.total || raw.length) / 50), 10);
  let complete = true;
  for (let page = 2; page <= pages; page++) {
    try {
      const data = await client.get(`/public/clan/${CLAN_TAG}/members?limit=50&page=${page}`);
      raw = raw.concat(data.results || []);
    } catch (error) {
      complete = false;
      break;
    }
  }
  const seen = new Set();
  const members = raw.filter((m) => m && m.publicId && !seen.has(m.publicId) && seen.add(m.publicId)).map(normMember);
  return { members, complete };
}

// Classement ALL : victoires totales. Si la fiche d'un joueur est indisponible, on garde les totaux de la liste des membres.
export async function computeAll(client, members, until) {
  const config = PERIODS.all;
  const sorted = members.slice().sort(byActivity).slice(0, config.count);
  const list = [];
  const details = {};
  let index = 0;
  let timedOut = false;
  let fallbacks = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (index < sorted.length) {
      if (Date.now() > until) { timedOut = true; return; }
      const member = sorted[index++];
      let stats = null;
      let name = member.username;
      try {
        const data = await client.get("/public/player/" + encodeURIComponent(member.publicId), { tries: 3, until });
        stats = statsFromObject(data);
        name = data.player?.username || data.username || name;
      } catch (error) {
        if (error.timeout) { timedOut = true; return; }
        fallbacks++;
      }
      if (!stats) {
        const games = member.wins + member.losses;
        stats = { wins: member.wins, losses: member.losses, games, rate: games > 0 ? Math.round((member.wins / games) * 100) : 0 };
      }
      details[member.publicId] = { name, ...stats };
      if (stats.games > 0) {
        list.push({
          name, publicId: member.publicId, value: stats.wins, games: stats.games,
          main: winsLine(stats.wins), sub: "ratio " + stats.rate + " % · " + stats.games + " parties"
        });
      }
    }
  }));
  list.sort((a, b) => b.value - a.value || b.games - a.games);
  return { list, details, complete: !timedOut, fallbacks };
}

export async function computeWindow(client, members, period, until, log = () => {}) {
  const config = PERIODS[period];
  const cutoff = new Date(Date.now() - config.ms);
  const end = new Date();
  const sorted = members.slice().sort(byActivity).slice(0, config.count);
  const sessions = new Map();
  const sessionUrl = (page) =>
    `/public/clan/${CLAN_TAG}/sessions?start=${encodeURIComponent(cutoff.toISOString())}` +
    `&end=${encodeURIComponent(end.toISOString())}&limit=50&page=${page}`;
  const addSessions = (data) => (data.results || []).forEach((session) => {
    const id = sessionId(session);
    if (!id) return;
    sessions.set(id, {
      won: !!session.hasWon,
      score: clanScore(!!session.hasWon, Number(session.numTeams) || 2,
        Number(session.totalPlayerCount) || 0, Number(session.clanPlayerCount) || 1)
    });
  });

  let timedOut = false;
  try {
    const first = await client.get(sessionUrl(1), { tries: 3, until });
    addSessions(first);
    const pages = Math.min(Math.ceil((first.total || 0) / 50), 200);
    let nextPage = 2;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (nextPage <= pages) {
        if (Date.now() > until) { timedOut = true; return; }
        const page = nextPage++;
        try { addSessions(await client.get(sessionUrl(page), { tries: 3, until })); }
        catch (error) { if (error.timeout) { timedOut = true; return; } }
      }
    }));
  } catch (error) {
    if (error.timeout) timedOut = true;
    log(`sessions du clan indisponibles (${period}) : ${error.message}`);
  }

  const memberGames = new Map();
  const pooled = new Map();
  let index = 0;
  let skipped = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (index < sorted.length) {
      if (Date.now() > until) { timedOut = true; return; }
      const member = sorted[index++];
      try {
        const games = [];
        let cursor = null;
        for (let page = 0; page < config.pages; page++) {
          const url = "/public/player/" + encodeURIComponent(member.publicId) +
            "/games?filter=team&type=public" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
          const data = await client.get(url, { tries: 3, until });
          const results = data.results || [];
          let old = false;
          for (const game of results) {
            if (new Date(game.start) < cutoff) { old = true; break; }
            if ((game.clanTag || "").toUpperCase() === CLAN_TAG || sessions.has(game.gameId)) games.push(game);
          }
          if (old || !data.nextCursor || !results.length) break;
          cursor = data.nextCursor;
        }
        games.forEach((game) => pooled.set(game.gameId, (pooled.get(game.gameId) || 0) + 1));
        memberGames.set(member.publicId, { name: member.username, publicId: member.publicId, games });
      } catch (error) {
        if (error.timeout) { timedOut = true; return; }
        skipped++;
      }
    }
  }));

  const out = [];
  memberGames.forEach((member) => {
    let gained = 0, lost = 0, wins = 0, count = 0;
    member.games.forEach((game) => {
      const session = sessions.get(game.gameId);
      let won, score;
      if (session) {
        won = session.won;
        score = session.score;
      } else if (sessions.size === 0) {
        won = game.result === "victory";
        score = clanScore(won, teamsOf(game), game.totalPlayers || 0, pooled.get(game.gameId) || 1);
      } else {
        return;
      }
      count++;
      if (won) { gained += score; wins++; } else lost += score;
    });
    if (!count) return;
    const balance = gained - lost;
    out.push({
      name: member.name, publicId: member.publicId, value: balance, games: count,
      main: (balance < 0 ? "−" : "+") + fmtN(Math.abs(balance)) + " pts",
      sub: "+" + fmtN(gained) + " / −" + fmtN(lost) + " · " + wins + "V/" + count + "P"
    });
  });
  out.sort((a, b) => b.value - a.value || b.games - a.games);
  return { list: out, complete: !timedOut && skipped === 0, skipped };
}

async function computeHint(client, period, until) {
  try {
    if (period !== "all") {
      const end = new Date();
      const start = new Date(Date.now() - PERIODS[period].ms);
      const data = await client.get(`/public/clan/${CLAN_TAG}?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`, { tries: 2, until });
      const clan = data.clan || {};
      return "GAL · " + PERIODS[period].label + " — " + (clan.games ?? 0) + " parties, " + (clan.wins ?? 0) + "V / " + (clan.losses ?? 0) + "D";
    }
    const leaderboard = await client.get("/public/clans/leaderboard", { tries: 2, until });
    const index = (leaderboard.clans || []).findIndex((clan) => (clan.clanTag || "").toUpperCase() === CLAN_TAG);
    return index >= 0 ? "GAL · ALL — rang #" + (index + 1) + " du classement des clans" : "GAL · ALL";
  } catch (error) {
    return "GAL · " + PERIODS[period].label;
  }
}

/* ---------- Info clan : cartes structurées (le navigateur les affiche) ---------- */
const INFO_LABELS = {
  name: "Nom", clanName: "Nom", tag: "Tag", clanTag: "Tag", description: "Description",
  createdAt: "Création", created: "Création", updatedAt: "Mise à jour",
  memberCount: "Membres", members: "Membres", games: "Parties", wins: "Victoires", losses: "Défaites",
  weightedWins: "Victoires pondérées", weightedLosses: "Défaites pondérées",
  weightedWLRatio: "Ratio pondéré", ratio: "Ratio", winRate: "Taux de victoire",
  leader: "Chef", owner: "Chef", isOpen: "Ouvert", open: "Ouvert", rank: "Rang", score: "Score",
  totalPlayers: "Joueurs", language: "Langue", country: "Pays", region: "Région",
  level: "Niveau", boosts: "Boosts", activeBoosts: "Boosts actifs", color: "Couleur"
};
const prettyKey = (key) => INFO_LABELS[key] ||
  key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());

function fmtVal(value) {
  if (typeof value === "boolean") return value ? "Oui" : "Non";
  if (typeof value === "number") return (Number.isInteger(value) ? value : Math.round(value * 1000) / 1000).toLocaleString("fr-FR");
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Paris" });
  }
  return String(value);
}

function flatten(obj, prefix = "", out = [], depth = 0) {
  Object.entries(obj || {}).forEach(([key, value]) => {
    if (value === null || value === undefined || value === "") return;
    const label = (prefix ? prefix + " · " : "") + prettyKey(key);
    if (Array.isArray(value)) {
      if (value.every((item) => typeof item !== "object")) {
        out.push([label, value.length > 8 ? value.length + " éléments" : (value.length ? value.map(fmtVal).join(", ") : "0")]);
      } else out.push([label, value.length + " éléments"]);
    } else if (typeof value === "object") {
      if (depth < 2) flatten(value, label, out, depth + 1);
    } else out.push([label, fmtVal(value)]);
  });
  return out;
}

export async function computeClanInfo(client, members, until) {
  const soft = (promise) => promise.catch(() => null);
  const now = new Date();
  const hour = 3600 * 1000;
  const win = (ms) => `/public/clan/${CLAN_TAG}?start=` +
    encodeURIComponent(new Date(now.getTime() - ms).toISOString()) + "&end=" + encodeURIComponent(now.toISOString());
  const opts = { tries: 3, until };
  const [detail, leaderboard, w24, w7, w30] = await Promise.all([
    soft(client.get(`/public/clan/${CLAN_TAG}`, opts)),
    soft(client.get("/public/clans/leaderboard", opts)),
    soft(client.get(win(24 * hour), opts)),
    soft(client.get(win(7 * 24 * hour), opts)),
    soft(client.get(win(30 * 24 * hour), opts))
  ]);
  const cards = [];
  const clan = detail ? (detail.clan || detail) : null;
  if (clan) cards.push({ title: "Général", rows: flatten(clan) });
  if (leaderboard && Array.isArray(leaderboard.clans)) {
    const index = leaderboard.clans.findIndex((item) => (item.clanTag || item.tag || "").toUpperCase() === CLAN_TAG);
    const rows = [];
    if (index >= 0) {
      rows.push(["Rang", "#" + (index + 1) + " / " + leaderboard.clans.length]);
      flatten(leaderboard.clans[index]).forEach((row) => rows.push(row));
    } else rows.push(["Rang", "hors du classement (" + leaderboard.clans.length + " clans)"]);
    cards.push({ title: "Classement des clans", rows });
  }
  const activity = [];
  [["24 heures", w24], ["7 jours", w7], ["30 jours", w30]].forEach(([label, data]) => {
    if (!data) return;
    const c = data.clan || data;
    const games = Number(c.games) || 0, wins = Number(c.wins) || 0, losses = Number(c.losses) || 0;
    let value = games + " parties · " + wins + "V / " + losses + "D · " + (games ? Math.round((wins / games) * 100) : 0) + " %";
    if (c.weightedWins != null) value += " · " + fmtVal(Number(c.weightedWins)) + " pts pondérés";
    activity.push([label, value]);
  });
  if (activity.length) cards.push({ title: "Activité du clan", rows: activity });
  if (members.length) {
    const rows = [["Membres", String(members.length)]];
    const roles = {};
    members.forEach((m) => { const role = String(m.role || "membre"); roles[role] = (roles[role] || 0) + 1; });
    Object.entries(roles).forEach(([role, count]) => rows.push(["Rôle · " + prettyKey(role), String(count)]));
    const named = (regex) => members.filter((m) => regex.test(String(m.role || ""))).map((m) => m.username);
    const leaders = named(/lead|owner|chef/i);
    const officers = named(/offic|admin|mod/i);
    if (leaders.length) rows.push(["Chef", leaders.join(", ")]);
    if (officers.length) rows.push(["Officiers", officers.slice(0, 8).join(", ") + (officers.length > 8 ? "…" : "")]);
    const sums = members.reduce((acc, m) => ({ w: acc.w + m.wins, l: acc.l + m.losses }), { w: 0, l: 0 });
    const totalGames = sums.w + sums.l;
    rows.push(["Victoires cumulées", sums.w.toLocaleString("fr-FR")]);
    rows.push(["Défaites cumulées", sums.l.toLocaleString("fr-FR")]);
    rows.push(["Parties cumulées", totalGames.toLocaleString("fr-FR")]);
    rows.push(["Ratio global", (totalGames ? Math.round((sums.w / totalGames) * 100) : 0) + " %"]);
    members.slice().sort((a, b) => b.wins - a.wins).slice(0, 3)
      .forEach((m, i) => rows.push(["Top " + (i + 1) + " victoires", m.username + " (" + m.wins + ")"]));
    cards.push({ title: "Membres", rows });
  }
  return { cards: cards.filter((card) => card.rows.length), reached: !!(detail || leaderboard || w24 || w7 || w30) };
}

/* ------------------------------------------------------------------ */
/* Orchestration : calcule tout, publie section par section            */
/* ------------------------------------------------------------------ */
// storage = { get(key), set(key, value) } ; budgetMs = durée maximale du calcul complet
export async function refreshAll({ client, storage, budgetMs = 8 * 60 * 1000, log = console.log }) {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const hardStop = startedAtMs + budgetMs;
  client.deadline = hardStop;
  const prev = (await storage.get("data").catch(() => null)) || null;
  const stages = {};
  const data = {
    version: 2,
    clanTag: CLAN_TAG,
    members: prev?.members || [],
    tops: { ...(prev?.tops || {}) },
    claninfo: prev?.claninfo || null,
    playerDetails: { ...(prev?.playerDetails || {}) },
    generatedAt: prev?.generatedAt || null
  };
  const publish = async () => {
    data.generatedAt = new Date().toISOString();
    await storage.set("data", data);
  };
  const stage = async (name, budget, fn) => {
    const t0 = Date.now();
    const until = Math.min(hardStop, t0 + budget);
    try {
      const info = await fn(until);
      stages[name] = { ok: true, ms: Date.now() - t0, ...info };
      log(`[GAL] étape ${name} terminée en ${Math.round((Date.now() - t0) / 1000)} s`, JSON.stringify(info));
    } catch (error) {
      stages[name] = { ok: false, ms: Date.now() - t0, error: error?.message || String(error) };
      log(`[GAL] étape ${name} EN ÉCHEC :`, error?.stack || error?.message || error);
    }
  };

  // 1. membres (indispensable : sans eux on garde les anciennes données)
  const membersResult = await fetchMembers(client);
  if (!membersResult.members.length) throw new Error("OpenFront n'a retourné aucun membre pour GAL.");
  data.members = membersResult.members;
  data.membersAt = new Date().toISOString();
  membersResult.members.forEach((m) => {
    if (!data.playerDetails[m.publicId]) {
      const games = m.wins + m.losses;
      data.playerDetails[m.publicId] = { name: m.username, wins: m.wins, losses: m.losses, games, rate: games ? Math.round((m.wins / games) * 100) : 0 };
    }
  });
  stages.members = { ok: true, count: membersResult.members.length, complete: membersResult.complete };
  log("[GAL] membres :", membersResult.members.length);
  await publish();

  const keepOld = (period, fresh) => {
    const old = prev?.tops?.[period];
    if (fresh.partial && old && !old.partial && Array.isArray(old.players) && old.players.length) {
      data.tops[period] = { ...old, stale: true };
      return true;
    }
    return false;
  };

  // 2. info clan
  await stage("claninfo", 60 * 1000, async (until) => {
    const info = await computeClanInfo(client, data.members, until);
    if (info.reached || !data.claninfo) data.claninfo = { cards: info.cards, at: new Date().toISOString() };
    await publish();
    return { cards: info.cards.length };
  });

  // 3. classement ALL
  await stage("all", 150 * 1000, async (until) => {
    const result = await computeAll(client, data.members, until);
    Object.assign(data.playerDetails, result.details);
    const entry = {
      players: fillMissing(result.list, data.members, "all"),
      hint: await computeHint(client, "all", until + 15000),
      partial: !result.complete,
      at: new Date().toISOString()
    };
    const kept = keepOld("all", entry);
    if (!kept) data.tops.all = entry;
    await publish();
    return { players: entry.players.length, partial: entry.partial, keptPrevious: kept, fallbacks: result.fallbacks };
  });

  // 4. fenêtres 24 h puis 30 j
  for (const [period, budget] of [["24h", 110 * 1000], ["30d", 190 * 1000]]) {
    await stage(period, budget, async (until) => {
      const result = await computeWindow(client, data.members, period, until, log);
      const entry = {
        players: fillMissing(result.list, data.members, period),
        hint: await computeHint(client, period, until + 15000),
        partial: !result.complete,
        at: new Date().toISOString()
      };
      const kept = keepOld(period, entry);
      if (!kept) data.tops[period] = entry;
      await publish();
      return { players: entry.players.length, scored: result.list.length, partial: entry.partial, keptPrevious: kept, skipped: result.skipped };
    });
  }

  const finishedAt = new Date().toISOString();
  const failed = Object.entries(stages).filter(([, s]) => !s.ok).map(([name]) => name);
  const status = {
    state: "ready",
    startedAt, finishedAt, durationMs: Date.now() - startedAtMs,
    requests: client.requests, rateLimited: client.rateLimited,
    stages, failedStages: failed,
    message: failed.length ? "Étapes en échec : " + failed.join(", ") : ""
  };
  await storage.set("status", status);
  log("[GAL] calcul terminé", JSON.stringify({ ms: status.durationMs, requests: client.requests, rateLimited: client.rateLimited, failed }));
  return { data, status };
}
