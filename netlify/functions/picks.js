// netlify/functions/picks.js
// Ranked BTS picks for today, pulled live from MLB Stats API

const API = 'https://statsapi.mlb.com/api/v1';

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
      let avg = 0, ab = 0, hits = 0, ops = 0;
      const ps = (person.stats || []);
      for (const block of ps) {
        if (block.group && block.group.displayName === 'hitting') {
          for (const s of (block.splits || [])) {
            if (s.stat) {
              avg = parseFloat(s.stat.avg || '0') || 0;
              ab = parseInt(s.stat.atBats || '0', 10) || 0;
              hits = parseInt(s.stat.hits || '0', 10) || 0;
              ops = parseFloat(s.stat.ops || '0') || 0;
            }
          }
        }
      }
      result.push({
        personId: person.id,
        name: person.fullName || 'Unknown',
        position: (p.position && p.position.abbreviation) || '',
        avg: avg, ab: ab, hits: hits, ops: ops
      });
    }
    return result;
  } catch (e) {
    return [];
  }
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

exports.handler = async function() {
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
      mapLimit(pitcherIdArr, 10, id => getPitcherStats(id, season))
    ]);

    const teamBatters = {};
    teamIdArr.forEach((id, i) => { teamBatters[id] = teamBattersArrays[i] || []; });
    const pitcherStats = {};
    pitcherIdArr.forEach((id, i) => { pitcherStats[id] = pitcherStatsArr[i] || { era:0, whip:0, baa:0 }; });

    const teamTop10 = {};
    for (const tid of teamIdArr) {
      teamTop10[tid] = (teamBatters[tid] || [])
        .filter(b => b.ab >= 20)
        .sort((a, b) => b.avg - a.avg)
        .slice(0, 10);
    }

    const bvpTasks = [];
    games.forEach(g => {
      const parkFac = parkFactor(g.venue);
      (teamTop10[g.awayTeamId] || []).forEach(b => {
        bvpTasks.push({ batter: b, pitcherId: g.homePitcherId, pitcherName: g.homePitcherName, teamAbbr: g.awayTeamAbbr, teamName: g.awayTeamName, oppTeam: g.homeTeamAbbr, parkFac: parkFac, isHome: false, gamePk: g.gamePk, venue: g.venue });
      });
      (teamTop10[g.homeTeamId] || []).forEach(b => {
        bvpTasks.push({ batter: b, pitcherId: g.awayPitcherId, pitcherName: g.awayPitcherName, teamAbbr: g.homeTeamAbbr, teamName: g.homeTeamName, oppTeam: g.awayTeamAbbr, parkFac: parkFac, isHome: true, gamePk: g.gamePk, venue: g.venue });
      });
    });

    const bvpResults = await mapLimit(bvpTasks, 15, async task => {
      if (!task.pitcherId) return { ab: 0, hits: 0, avg: 0 };
      return await getBvP(task.batter.personId, task.pitcherId);
    });

    const picks = [];
    bvpTasks.forEach((task, i) => {
      const bvp = bvpResults[i];
      const seasonAvg = task.batter.avg;
      let blended = seasonAvg;
      if (bvp.ab >= 10) blended = 0.6 * seasonAvg + 0.4 * bvp.avg;
      else if (bvp.ab >= 5) blended = 0.8 * seasonAvg + 0.2 * bvp.avg;
      const adjusted = blended * task.parkFac;
      const perAB = Math.min(0.99, Math.max(0.01, adjusted));
      const gameHitProb = 1 - Math.pow(1 - perAB, 4);

      picks.push({
        name: task.batter.name,
        team: task.teamAbbr,
        teamName: task.teamName,
        position: task.batter.position,
        seasonAvg: seasonAvg,
        seasonAb: task.batter.ab,
        seasonOps: task.batter.ops,
        bvpAb: bvp.ab,
        bvpHits: bvp.hits,
        bvpAvg: bvp.avg,
        opposingPitcher: task.pitcherName,
        pitcherStats: task.pitcherId ? pitcherStats[task.pitcherId] : null,
        parkFactor: task.parkFac,
        isHome: task.isHome,
        oppTeam: task.oppTeam,
        venue: task.venue,
        gamePk: task.gamePk,
        hitProb: Math.round(gameHitProb * 100)
      });
    });

    picks.sort((a, b) => b.hitProb - a.hitProb);

    const elapsed = Date.now() - t0;
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=600'
      },
      body: JSON.stringify({
        ok: true,
        generatedAt: new Date().toISOString(),
        elapsedMs: elapsed,
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
    const elapsed = Date.now() - t0;
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: false,
        error: e.message || String(e),
        elapsedMs: elapsed,
        stack: e.stack ? e.stack.split('\n').slice(0, 3).join('\n') : null
      })
    };
  }
};
