var _internalHandler;
// netlify/functions/homeruns.js
// Ranked HR picks for today - who's most likely to hit a home run

const API = 'https://statsapi.mlb.com/api/v1';

// Park HR factors (home run friendliness, separate from hit factor)
const PARK_HR = {
  'Coors Field':1.26,'Great American Ball Park':1.15,'Citizens Bank Park':1.11,
  'Yankee Stadium':1.10,'Fenway Park':1.08,'Wrigley Field':1.05,
  'Truist Park':1.04,'Minute Maid Park':1.04,'Daikin Park':1.04,
  'Globe Life Field':1.03,'Nationals Park':1.03,'Rogers Centre':1.00,
  'Dodger Stadium':1.01,'Busch Stadium':0.98,'Target Field':0.98,
  'American Family Field':0.99,'Chase Field':1.00,'Progressive Field':0.98,
  'Kauffman Stadium':0.94,'Tropicana Field':0.95,'Comerica Park':0.98,
  'Rate Field':0.98,'Guaranteed Rate Field':0.98,'Citi Field':0.97,
  'Angel Stadium':0.93,'Oracle Park':0.92,'T-Mobile Park':0.91,
  'Petco Park':0.88,'loanDepot park':0.94,'PNC Park':0.98,
  'Oriole Park at Camden Yards':0.98,'Sutter Health Park':0.88,
  'George M. Steinbrenner Field':0.98
};

function hrFactor(venueName) {
  if (!venueName) return 1.0;
  if (PARK_HR[venueName]) return PARK_HR[venueName];
  const lower = venueName.toLowerCase();
  for (const k of Object.keys(PARK_HR)) {
    if (lower.indexOf(k.toLowerCase()) >= 0) return PARK_HR[k];
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

async function getTeamBattersWithStats(teamId, season) {
  const url = `${API}/teams/${teamId}/roster?rosterType=active&hydrate=person(stats(type=season,group=hitting,season=${season}))`;
  try {
    const data = await fetchJson(url);
    const roster = data.roster || [];
    const result = [];
    for (const p of roster) {
      if (!p.position || p.position.code === '1') continue;
      const person = p.person || {};
      let hr = 0, ab = 0, slg = 0, ops = 0, iso = 0, avg = 0;
      const ps = (person.stats || []);
      for (const block of ps) {
        if (block.group && block.group.displayName === 'hitting') {
          for (const s of (block.splits || [])) {
            if (s.stat) {
              hr = parseInt(s.stat.homeRuns || '0', 10) || 0;
              ab = parseInt(s.stat.atBats || '0', 10) || 0;
              slg = parseFloat(s.stat.slg || '0') || 0;
              ops = parseFloat(s.stat.ops || '0') || 0;
              avg = parseFloat(s.stat.avg || '0') || 0;
              iso = slg - avg;
            }
          }
        }
      }
      result.push({
        personId: person.id,
        name: person.fullName || 'Unknown',
        position: (p.position && p.position.abbreviation) || '',
        hr: hr, ab: ab, slg: slg, iso: iso, ops: ops, avg: avg,
        hrRate: ab > 0 ? hr / ab : 0
      });
    }
    return result;
  } catch (e) {
    return [];
  }
}

async function getPitcherHRStats(pitcherId, season) {
  const url = `${API}/people/${pitcherId}/stats?stats=season&group=pitching&season=${season}`;
  try {
    const data = await fetchJson(url, 3500);
    for (const s of (data.stats || [])) {
      const splits = s.splits || [];
      if (splits.length && splits[0].stat) {
        const stat = splits[0].stat;
        const hrsAllowed = parseInt(stat.homeRuns || '0', 10) || 0;
        const ip = parseFloat(stat.inningsPitched || '0') || 0;
        const era = parseFloat(stat.era || '0') || 0;
        return {
          era: era,
          hrPer9: ip > 0 ? (hrsAllowed * 9) / ip : 0,
          hrAllowed: hrsAllowed,
          ip: ip
        };
      }
    }
  } catch (e) {}
  return { era: 0, hrPer9: 0, hrAllowed: 0, ip: 0 };
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
    const games = await getTodaysGames();

    if (!games.length) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
        body: JSON.stringify({ ok: true, picks: [], games: [], pickCount: 0, gameCount: 0, message: 'No games scheduled today' })
      };
    }

    const teamIds = new Set();
    const pitcherIds = new Set();
    games.forEach(g => {
      if (g.awayTeamId) teamIds.add(g.awayTeamId);
      if (g.homeTeamId) teamIds.add(g.homeTeamId);
      if (g.awayPitcherId) pitcherIds.add(g.awayPitcherId);
      if (g.homePitcherId) pitcherIds.add(g.homePitcherId);
    });

    const teamIdArr = Array.from(teamIds);
    const pitcherIdArr = Array.from(pitcherIds);

    const [teamBattersArrays, pitcherStatsArr] = await Promise.all([
      mapLimit(teamIdArr, 10, id => getTeamBattersWithStats(id, season)),
      mapLimit(pitcherIdArr, 10, id => getPitcherHRStats(id, season))
    ]);

    const teamBatters = {};
    teamIdArr.forEach((id, i) => { teamBatters[id] = teamBattersArrays[i] || []; });
    const pitcherStats = {};
    pitcherIdArr.forEach((id, i) => { pitcherStats[id] = pitcherStatsArr[i] || { era:0, hrPer9:0 }; });

    // For HR picks, sort each team's roster by HR totals (desc), take top 10 with at least 20 ABs
    const teamTop10 = {};
    for (const tid of teamIdArr) {
      teamTop10[tid] = (teamBatters[tid] || [])
        .filter(b => b.ab >= 20)
        .sort((a, b) => b.hr - a.hr)
        .slice(0, 10);
    }

    // Build per-batter HR probability
    // Approach: batter season HR rate per AB, blended with park HR factor and pitcher HR/9 factor
    // Average pitcher HR/9 is roughly 1.2. If pitcher is at 1.8, they give up 50% more HRs.
    const LEAGUE_AVG_HR_PER_9 = 1.2;
    const picks = [];
    games.forEach(g => {
      const parkHR = hrFactor(g.venue);
      // Away batters vs home pitcher
      (teamTop10[g.awayTeamId] || []).forEach(b => {
        picks.push(buildHRPick(b, g.homePitcherId, g.homePitcherName, g.awayTeamAbbr, g.awayTeamName, g.homeTeamAbbr, false, g.gamePk, g.venue, parkHR, pitcherStats, LEAGUE_AVG_HR_PER_9));
      });
      (teamTop10[g.homeTeamId] || []).forEach(b => {
        picks.push(buildHRPick(b, g.awayPitcherId, g.awayPitcherName, g.homeTeamAbbr, g.homeTeamName, g.awayTeamAbbr, true, g.gamePk, g.venue, parkHR, pitcherStats, LEAGUE_AVG_HR_PER_9));
      });
    });

    picks.sort((a, b) => b.hrProb - a.hrProb);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
      body: JSON.stringify({
        ok: true,
        generatedAt: new Date().toISOString(),
        elapsedMs: Date.now() - t0,
        gameCount: games.length,
        pickCount: picks.length,
        games: games.map(g => ({
          awayAbbr: g.awayTeamAbbr, homeAbbr: g.homeTeamAbbr,
          awayPitcher: g.awayPitcherName, homePitcher: g.homePitcherName,
          venue: g.venue, gameTime: g.gameTime
        })),
        picks: picks
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

function buildHRPick(b, pitcherId, pitcherName, teamAbbr, teamName, oppTeam, isHome, gamePk, venue, parkHR, pitcherStats, LEAGUE_AVG_HR_PER_9) {
  const pStats = pitcherId ? (pitcherStats[pitcherId] || { era:0, hrPer9:0 }) : null;
  // Pitcher factor: if HR/9 above league avg, batter more likely. Cap at 2x and floor at 0.5x
  let pitcherFactor = 1.0;
  if (pStats && pStats.hrPer9 > 0 && pStats.ip >= 10) {
    pitcherFactor = Math.min(2.0, Math.max(0.5, pStats.hrPer9 / LEAGUE_AVG_HR_PER_9));
  }
  // Estimate per-PA HR probability
  const basePerAB = b.hrRate; // season HR rate
  const adjustedPerAB = basePerAB * parkHR * pitcherFactor;
  // Per-game probability (assume ~4 AB)
  const perAB = Math.min(0.5, Math.max(0, adjustedPerAB));
  const gameHRProb = 1 - Math.pow(1 - perAB, 4);
  return {
    name: b.name,
    team: teamAbbr,
    teamName: teamName,
    position: b.position,
    seasonHR: b.hr,
    seasonAb: b.ab,
    seasonSlg: b.slg,
    seasonIso: b.iso,
    seasonOps: b.ops,
    hrRate: b.hrRate,
    opposingPitcher: pitcherName,
    pitcherHRper9: pStats ? pStats.hrPer9 : null,
    pitcherERA: pStats ? pStats.era : null,
    parkHRFactor: parkHR,
    isHome: isHome,
    oppTeam: oppTeam,
    venue: venue,
    gamePk: gamePk,
    hrProb: Math.round(gameHRProb * 100 * 10) / 10 // one decimal
  };
}


export async function onRequest(context) {
  const result = await _internalHandler();
  return new Response(result.body, { status: result.statusCode || 200, headers: result.headers || { "Content-Type": "application/json" } });
}
