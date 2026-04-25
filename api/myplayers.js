var _internalHandler;
// netlify/functions/myplayers.js
// Returns stats for a fixed watchlist of players for today's games

const API = 'https://statsapi.mlb.com/api/v1';

const MY_PLAYERS = [
  'Mike Trout',
  'Aaron Judge',
  'Bobby Witt Jr.',
  'Freddie Freeman',
  'Luis Arraez',
  'Juan Soto',
  'Trea Turner',
  'Kevin McGonigle',
  'Shohei Ohtani',
  'Ronald Acuna Jr.'
];

const PARK_FACTORS = {
  'Coors Field':1.17,'Fenway Park':1.10,'Great American Ball Park':1.09,
  'Wrigley Field':1.04,'Citizens Bank Park':1.03,'Dodger Stadium':1.03,
  'Minute Maid Park':1.02,'Daikin Park':1.02,'Globe Life Field':1.00,
  'Truist Park':1.00,'Rogers Centre':1.00,'Oracle Park':1.01,
  'Yankee Stadium':0.98,'Kauffman Stadium':0.98,'Progressive Field':0.97,
  'Tropicana Field':0.97,'Nationals Park':0.96,'Angel Stadium':0.95,
  'Petco Park':0.94,'T-Mobile Park':0.93,'Sutter Health Park':0.96,
  'Guaranteed Rate Field':0.98,'Rate Field':0.98,'Comerica Park':0.98,
  'Target Field':0.99,'Oriole Park at Camden Yards':0.98,'Citi Field':0.97,
  'Busch Stadium':0.99,'American Family Field':0.99,'PNC Park':0.98,
  'loanDepot park':0.94,'Chase Field':1.00,'George M. Steinbrenner Field':0.98
};

function parkFactor(venueName) {
  if (!venueName) return 1.0;
  if (PARK_FACTORS[venueName]) return PARK_FACTORS[venueName];
  const lower = venueName.toLowerCase();
  for (const k of Object.keys(PARK_FACTORS)) {
    if (lower.indexOf(k.toLowerCase()) >= 0) return PARK_FACTORS[k];
  }
  return 1.0;
}

async function fetchJson(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeName(n) {
  return String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Look up player by name via /people/search - returns list of candidates
async function lookupPlayer(name) {
  const encoded = encodeURIComponent(name);
  const url = `${API}/people/search?names=${encoded}&sportIds=1&active=true`;
  try {
    const data = await fetchJson(url, 4000);
    const people = data.people || [];
    if (!people.length) return null;
    // Prefer exact normalized match
    const wanted = normalizeName(name);
    for (const p of people) {
      if (normalizeName(p.fullName) === wanted) return p;
    }
    return people[0];
  } catch (e) {
    return null;
  }
}

async function getTodaysGames() {
  const d = new Date();
  const dateStr = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  const url = `${API}/schedule?sportId=1&date=${dateStr}&hydrate=probablePitcher,team,venue`;
  const data = await fetchJson(url);
  const games = [];
  for (const dateObj of (data.dates || [])) {
    for (const g of (dateObj.games || [])) {
      const home = g.teams && g.teams.home;
      const away = g.teams && g.teams.away;
      if (!home || !away) continue;
      games.push({
        gamePk: g.gamePk,
        gameTime: g.gameDate,
        venue: (g.venue && g.venue.name) || '',
        awayTeamId: away.team && away.team.id,
        awayTeamName: (away.team && away.team.name) || '',
        awayTeamAbbr: (away.team && away.team.abbreviation) || '',
        awayPitcherId: away.probablePitcher && away.probablePitcher.id,
        awayPitcherName: (away.probablePitcher && away.probablePitcher.fullName) || 'TBD',
        homeTeamId: home.team && home.team.id,
        homeTeamName: (home.team && home.team.name) || '',
        homeTeamAbbr: (home.team && home.team.abbreviation) || '',
        homePitcherId: home.probablePitcher && home.probablePitcher.id,
        homePitcherName: (home.probablePitcher && home.probablePitcher.fullName) || 'TBD'
      });
    }
  }
  return games;
}

async function getPersonWithTeam(personId) {
  const url = `${API}/people/${personId}?hydrate=currentTeam`;
  try {
    const data = await fetchJson(url, 3500);
    const p = (data.people || [])[0];
    if (!p) return null;
    return {
      id: p.id,
      fullName: p.fullName,
      currentTeamId: p.currentTeam && p.currentTeam.id,
      currentTeamName: p.currentTeam && p.currentTeam.name,
      primaryPosition: p.primaryPosition && p.primaryPosition.abbreviation
    };
  } catch (e) {
    return null;
  }
}

async function getSeasonStats(personId, season) {
  const url = `${API}/people/${personId}/stats?stats=season&group=hitting&season=${season}`;
  try {
    const data = await fetchJson(url, 3500);
    for (const s of (data.stats || [])) {
      const splits = s.splits || [];
      if (splits.length && splits[0].stat) {
        const stat = splits[0].stat;
        return {
          avg: parseFloat(stat.avg || '0') || 0,
          atBats: parseInt(stat.atBats || '0', 10) || 0,
          hits: parseInt(stat.hits || '0', 10) || 0,
          ops: parseFloat(stat.ops || '0') || 0
        };
      }
    }
  } catch (e) {}
  return { avg: 0, atBats: 0, hits: 0, ops: 0 };
}

async function getBvP(batterId, pitcherId) {
  const url = `${API}/people/${batterId}/stats?stats=vsPlayer&group=hitting&opposingPlayerId=${pitcherId}&sportId=1`;
  try {
    const data = await fetchJson(url, 3500);
    for (const s of (data.stats || [])) {
      if (s.type && (s.type.displayName === 'vsPlayerTotal' || s.type.displayName === 'vsPlayer')) {
        const splits = s.splits || [];
        if (splits.length && splits[0].stat) {
          const stat = splits[0].stat;
          return {
            ab: parseInt(stat.atBats || '0', 10) || 0,
            hits: parseInt(stat.hits || '0', 10) || 0,
            avg: parseFloat(stat.avg || '0') || 0
          };
        }
      }
    }
  } catch (e) {}
  return { ab: 0, hits: 0, avg: 0 };
}

async function getPitcherStats(pitcherId, season) {
  const url = `${API}/people/${pitcherId}/stats?stats=season&group=pitching&season=${season}`;
  try {
    const data = await fetchJson(url, 3500);
    for (const s of (data.stats || [])) {
      const splits = s.splits || [];
      if (splits.length && splits[0].stat) {
        const stat = splits[0].stat;
        return {
          era: parseFloat(stat.era || '0') || 0,
          whip: parseFloat(stat.whip || '0') || 0,
          baa: parseFloat(stat.avg || '0') || 0
        };
      }
    }
  } catch (e) {}
  return { era: 0, whip: 0, baa: 0 };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

_internalHandler = async function() {
  const t0 = Date.now();
  try {
    const season = new Date().getFullYear();

    // Step 1: Parallel — look up each player's personId AND get today's games
    const [lookupResults, games] = await Promise.all([
      mapLimit(MY_PLAYERS, 10, name => lookupPlayer(name)),
      getTodaysGames()
    ]);

    // Step 2: For each player who was found, get their currentTeam info
    const playerInfos = await mapLimit(lookupResults, 10, async (p, i) => {
      if (!p) return { requestedName: MY_PLAYERS[i], found: false };
      const info = await getPersonWithTeam(p.id);
      if (!info) return { requestedName: MY_PLAYERS[i], found: false };
      return { requestedName: MY_PLAYERS[i], found: true, ...info };
    });

    // Step 3: Map each player to today's game (if any)
    const results = [];
    const statFetches = []; // parallel stat lookups

    playerInfos.forEach((pi) => {
      if (!pi.found) {
        results.push({
          requestedName: pi.requestedName,
          found: false,
          status: 'Player not found in MLB (possibly minor leagues or retired)'
        });
        return;
      }

      const g = games.find(gm => gm.homeTeamId === pi.currentTeamId || gm.awayTeamId === pi.currentTeamId);
      const entry = {
        requestedName: pi.requestedName,
        found: true,
        personId: pi.id,
        name: pi.fullName,
        teamName: pi.currentTeamName,
        position: pi.primaryPosition
      };

      if (!g) {
        entry.playing = false;
        entry.status = 'No game today';
        results.push(entry);
        return;
      }

      const isHome = g.homeTeamId === pi.currentTeamId;
      const teamAbbr = isHome ? g.homeTeamAbbr : g.awayTeamAbbr;
      const oppAbbr = isHome ? g.awayTeamAbbr : g.homeTeamAbbr;
      const oppPitcherId = isHome ? g.awayPitcherId : g.homePitcherId;
      const oppPitcherName = isHome ? g.awayPitcherName : g.homePitcherName;
      const parkFac = parkFactor(g.venue);

      entry.playing = true;
      entry.teamAbbr = teamAbbr;
      entry.oppTeam = oppAbbr;
      entry.isHome = isHome;
      entry.venue = g.venue;
      entry.gameTime = g.gameTime;
      entry.parkFactor = parkFac;
      entry.opposingPitcher = oppPitcherName;
      entry.opposingPitcherId = oppPitcherId;
      entry.gamePk = g.gamePk;

      // Queue up the stat fetches for later parallel execution
      statFetches.push({ entry, oppPitcherId });
      results.push(entry);
    });

    // Step 4: Parallel fetch season + BvP + pitcher stats for everyone playing
    const pitcherIds = new Set();
    statFetches.forEach(sf => { if (sf.oppPitcherId) pitcherIds.add(sf.oppPitcherId); });
    const pitcherIdArr = Array.from(pitcherIds);

    const seasonTasks = statFetches.map(sf => () => getSeasonStats(sf.entry.personId, season));
    const bvpTasks = statFetches.map(sf => () => sf.oppPitcherId ? getBvP(sf.entry.personId, sf.oppPitcherId) : Promise.resolve({ ab:0, hits:0, avg:0 }));
    const pitcherTasks = pitcherIdArr.map(pid => () => getPitcherStats(pid, season));

    const allTasks = [...seasonTasks, ...bvpTasks, ...pitcherTasks];
    const allResults = await mapLimit(allTasks, 15, t => t());

    const seasonResults = allResults.slice(0, seasonTasks.length);
    const bvpResults = allResults.slice(seasonTasks.length, seasonTasks.length + bvpTasks.length);
    const pitcherResults = allResults.slice(seasonTasks.length + bvpTasks.length);

    const pitcherStatsMap = {};
    pitcherIdArr.forEach((pid, i) => { pitcherStatsMap[pid] = pitcherResults[i]; });

    // Step 5: Glue back into entries and compute hit probabilities
    statFetches.forEach((sf, i) => {
      const e = sf.entry;
      const season = seasonResults[i];
      const bvp = bvpResults[i];
      e.seasonAvg = season.avg;
      e.seasonAb = season.atBats;
      e.seasonHits = season.hits;
      e.seasonOps = season.ops;
      e.bvpAb = bvp.ab;
      e.bvpHits = bvp.hits;
      e.bvpAvg = bvp.avg;
      e.pitcherStats = sf.oppPitcherId ? pitcherStatsMap[sf.oppPitcherId] : null;

      // Hit probability
      let blended = season.avg;
      if (bvp.ab >= 10) blended = 0.6 * season.avg + 0.4 * bvp.avg;
      else if (bvp.ab >= 5) blended = 0.8 * season.avg + 0.2 * bvp.avg;
      const adjusted = blended * e.parkFactor;
      const perAB = Math.min(0.99, Math.max(0.01, adjusted));
      e.hitProb = Math.round((1 - Math.pow(1 - perAB, 4)) * 100);
    });

    // Sort playing players by hitProb desc; not-playing players at bottom
    results.sort((a, b) => {
      if (a.playing && !b.playing) return -1;
      if (!a.playing && b.playing) return 1;
      if (!a.found && b.found) return 1;
      if (a.found && !b.found) return -1;
      if (a.playing && b.playing) return (b.hitProb || 0) - (a.hitProb || 0);
      return 0;
    });

    const elapsed = Date.now() - t0;
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
      body: JSON.stringify({
        ok: true,
        generatedAt: new Date().toISOString(),
        elapsedMs: elapsed,
        players: results
      })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: false,
        error: e.message || String(e),
        elapsedMs: Date.now() - t0
      })
    };
  }
};


export default async function handler(req, res) {
  try {
    const result = await _internalHandler();
    const statusCode = result.statusCode || 200;
    const headers = result.headers || { 'Content-Type': 'application/json' };
    
    // Set headers
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }
    
    res.status(statusCode).send(result.body);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
