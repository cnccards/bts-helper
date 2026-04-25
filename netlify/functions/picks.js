// netlify/functions/picks.js
// Ranked BTS picks for today, pulled live from MLB Stats API
// Optimized for 10s Netlify function timeout:
//  - 1 schedule call
//  - 1 call per team for roster+stats (hydrated)
//  - Parallel BvP calls for only the top 10 batters per team
//  - Parallel pitcher season stats

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

// Hit-specific park factors (different from runs - some parks boost HRs but not hits)
const PARK_HIT_FACTORS = {
  'Coors Field':1.12,'Fenway Park':1.08,'Wrigley Field':1.04,
  'Great American Ball Park':1.03,'Citizens Bank Park':1.02,'Dodger Stadium':1.01,
  'Minute Maid Park':1.01,'Daikin Park':1.01,'Globe Life Field':1.00,
  'Truist Park':1.00,'Rogers Centre':1.00,'Oracle Park':0.99,
  'Chase Field':1.02,'Yankee Stadium':0.98,'Kauffman Stadium':1.00,
  'Progressive Field':0.97,'Tropicana Field':0.96,'Nationals Park':0.98,
  'Angel Stadium':0.97,'Petco Park':0.96,'T-Mobile Park':0.94,
  'Sutter Health Park':0.98,'Guaranteed Rate Field':0.98,'Rate Field':0.98,
  'Comerica Park':0.98,'Target Field':1.00,'Oriole Park at Camden Yards':0.99,
  'Citi Field':0.97,'Busch Stadium':1.00,'American Family Field':0.99,
  'PNC Park':0.99,'loanDepot park':0.95,'George M. Steinbrenner Field':0.98
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

function parkHitFactor(venueName) {
  if (!venueName) return 1.0;
  if (PARK_HIT_FACTORS[venueName]) return PARK_HIT_FACTORS[venueName];
  const lower = venueName.toLowerCase();
  for (const k of Object.keys(PARK_HIT_FACTORS)) {
    if (lower.indexOf(k.toLowerCase()) >= 0) return PARK_HIT_FACTORS[k];
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

// ONE CALL to get roster + each player's season hitting stats in a single response
async function getTeamBattersWithStats(teamId, season) {
  const url = `${API}/teams/${teamId}/roster?rosterType=active&hydrate=person(stats(type=season,group=hitting,season=${season}),batSide)`;
  try {
    const data = await fetchJson(url);
    const roster = data.roster || [];
    const result = [];
    for (const p of roster) {
      if (!p.position || p.position.code === '1') continue; // exclude pitchers
      const person = p.person || {};
      // Find season hitting split
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
      // Get batter handedness (L/R/S)
      var batSide = 'R';
      if (person.batSide && person.batSide.code) {
        batSide = person.batSide.code; // 'L', 'R', or 'S' (switch)
      }
      result.push({
        personId: person.id,
        name: person.fullName || 'Unknown',
        position: (p.position && p.position.abbreviation) || '',
        avg: avg, ab: ab, hits: hits, ops: ops,
        batSide: batSide
      });
    }
    return result;
  } catch (e) {
    return [];
  }
}

async function getBvP(batterId, pitcherId) {
  // Use vsPlayerTotal which returns career-aggregate (no season param needed)
  // Sum ALL splits to get true career totals; recalculate avg from raw counts
  const url = `${API}/people/${batterId}/stats?stats=vsPlayerTotal&group=hitting&opposingPlayerId=${pitcherId}&sportId=1`;
  try {
    const data = await fetchJson(url, 2500);
    let totalAb = 0, totalHits = 0;
    for (const s of (data.stats || [])) {
      if (s.type && s.type.displayName === 'vsPlayerTotal') {
        for (const split of (s.splits || [])) {
          if (split.stat) {
            totalAb += parseInt(split.stat.atBats || '0', 10) || 0;
            totalHits += parseInt(split.stat.hits || '0', 10) || 0;
          }
        }
      }
    }
    const avg = totalAb > 0 ? totalHits / totalAb : 0;
    return { ab: totalAb, hits: totalHits, avg: avg };
  } catch (e) {}
  return { ab: 0, hits: 0, avg: 0 };
}

async function getPitcherStats(pitcherId, season) {
  // Use hydrate to grab pitch hand + season stats in one call
  const url = `${API}/people/${pitcherId}?hydrate=stats(group=pitching,type=season,season=${season})`;
  try {
    const data = await fetchJson(url, 3500);
    const people = data.people || [];
    if (!people.length) return { era: 0, whip: 0, baa: 0, pitchHand: 'R' };
    const person = people[0];
    let era = 0, whip = 0, baa = 0;
    const ps = person.stats || [];
    for (const block of ps) {
      const splits = block.splits || [];
      if (splits.length && splits[0].stat) {
        const stat = splits[0].stat;
        era = parseFloat(stat.era || '0') || 0;
        whip = parseFloat(stat.whip || '0') || 0;
        baa = parseFloat(stat.avg || '0') || 0;
      }
    }
    var pitchHand = 'R';
    if (person.pitchHand && person.pitchHand.code) {
      pitchHand = person.pitchHand.code; // 'L' or 'R'
    }
    return { era: era, whip: whip, baa: baa, pitchHand: pitchHand };
  } catch (e) {}
  return { era: 0, whip: 0, baa: 0, pitchHand: 'R' };
}

// Get pitcher's last 3 starts — rolling form indicator
async function getPitcherLast3(pitcherId, season) {
  const url = `${API}/people/${pitcherId}/stats?stats=gameLog&group=pitching&season=${season}`;
  try {
    const data = await fetchJson(url, 3500);
    for (const s of (data.stats || [])) {
      const splits = s.splits || [];
      if (!splits.length) continue;
      // Filter to starts only (gamesStarted=1), take last 3
      const starts = splits.filter(sp => sp.stat && parseInt(sp.stat.gamesStarted || '0', 10) >= 1);
      // splits are oldest first typically; take last 3
      const last3 = starts.slice(-3);
      if (!last3.length) return { starts: 0, era: 0, ip: 0, er: 0 };
      let totalOuts = 0, totalER = 0;
      for (const sp of last3) {
        // ip comes as decimal like "6.1" meaning 6+1/3 innings -> 19 outs
        const ipStr = sp.stat.inningsPitched || '0';
        const ipParts = String(ipStr).split('.');
        const wholeIp = parseInt(ipParts[0] || '0', 10);
        const fracOuts = parseInt(ipParts[1] || '0', 10); // 0, 1, or 2
        totalOuts += wholeIp * 3 + fracOuts;
        totalER += parseInt(sp.stat.earnedRuns || '0', 10);
      }
      const totalIp = totalOuts / 3;
      const era = totalIp > 0 ? (9 * totalER / totalIp) : 0;
      return { starts: last3.length, era: era, ip: totalIp, er: totalER };
    }
  } catch (e) {}
  return { starts: 0, era: 0, ip: 0, er: 0 };
}

// Get pitcher's splits vs a specific team this season
async function getPitcherVsTeam(pitcherId, opposingTeamId, season) {
  if (!pitcherId || !opposingTeamId) return { starts: 0, era: 0, ip: 0, er: 0 };
  const url = `${API}/people/${pitcherId}/stats?stats=vsTeam&group=pitching&opposingTeamId=${opposingTeamId}&season=${season}`;
  try {
    const data = await fetchJson(url, 3500);
    for (const s of (data.stats || [])) {
      const splits = s.splits || [];
      for (const sp of splits) {
        if (!sp.stat) continue;
        const starts = parseInt(sp.stat.gamesStarted || '0', 10) || 0;
        if (starts === 0) continue;
        const ipStr = sp.stat.inningsPitched || '0';
        const ipParts = String(ipStr).split('.');
        const wholeIp = parseInt(ipParts[0] || '0', 10);
        const fracOuts = parseInt(ipParts[1] || '0', 10);
        const totalOuts = wholeIp * 3 + fracOuts;
        const totalIp = totalOuts / 3;
        const er = parseInt(sp.stat.earnedRuns || '0', 10) || 0;
        const era = totalIp > 0 ? (9 * er / totalIp) : 0;
        return { starts: starts, era: era, ip: totalIp, er: er };
      }
    }
  } catch (e) {}
  return { starts: 0, era: 0, ip: 0, er: 0 };
}

// Bounded parallel helper
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

    // Collect unique team IDs and pitcher IDs
    const teamIds = new Set();
    const pitcherIds = new Set();
    games.forEach(g => {
      if (g.awayTeamId) teamIds.add(g.awayTeamId);
      if (g.homeTeamId) teamIds.add(g.homeTeamId);
      if (g.awayPitcherId) pitcherIds.add(g.awayPitcherId);
      if (g.homePitcherId) pitcherIds.add(g.homePitcherId);
    });

    // Parallel: teams rosters (with hydrated season stats) + pitcher stats
    const teamIdArr = Array.from(teamIds);
    const pitcherIdArr = Array.from(pitcherIds);

    // Build pitcher-vs-team pairs (each pitcher has one opposing team today)
    const pitcherVsTeamPairs = [];
    games.forEach(g => {
      if (g.awayPitcherId && g.homeTeamId) {
        pitcherVsTeamPairs.push({ pitcherId: g.awayPitcherId, teamId: g.homeTeamId });
      }
      if (g.homePitcherId && g.awayTeamId) {
        pitcherVsTeamPairs.push({ pitcherId: g.homePitcherId, teamId: g.awayTeamId });
      }
    });

    const [teamBattersArrays, pitcherStatsArr, pitcherLast3Arr, pitcherVsTeamArr] = await Promise.all([
      mapLimit(teamIdArr, 10, id => getTeamBattersWithStats(id, season)),
      mapLimit(pitcherIdArr, 10, id => getPitcherStats(id, season)),
      mapLimit(pitcherIdArr, 10, id => getPitcherLast3(id, season)),
      mapLimit(pitcherVsTeamPairs, 10, pair => getPitcherVsTeam(pair.pitcherId, pair.teamId, season))
    ]);

    // Index
    const teamBatters = {};
    teamIdArr.forEach((id, i) => { teamBatters[id] = teamBattersArrays[i] || []; });
    const pitcherStats = {};
    pitcherIdArr.forEach((id, i) => { pitcherStats[id] = pitcherStatsArr[i] || { era:0, whip:0, baa:0, pitchHand:'R' }; });
    const pitcherLast3 = {};
    pitcherIdArr.forEach((id, i) => { pitcherLast3[id] = pitcherLast3Arr[i] || { starts:0, era:0, ip:0, er:0 }; });
    const pitcherVsTeam = {};
    pitcherVsTeamPairs.forEach((pair, i) => {
      const key = pair.pitcherId + '_' + pair.teamId;
      pitcherVsTeam[key] = pitcherVsTeamArr[i] || { starts:0, era:0, ip:0, er:0 };
    });

    // For each team, include ALL hitters with at least 5 season ABs (catches everyday players
    // even when slumping, plus bench players who may have BvP history vs starter).
    // Lower threshold than before (was 20) to catch slumping veterans and platoon bats.
    const teamHitters = {};
    for (const tid of teamIdArr) {
      teamHitters[tid] = (teamBatters[tid] || [])
        .filter(b => b.ab >= 5)
        .sort((a, b) => b.ab - a.ab); // sort by AB count (regulars first)
    }

    // Build list of BvP lookups needed (batter × opposing pitcher)
    const bvpTasks = [];
    games.forEach(g => {
      const parkFac = parkFactor(g.venue);
      const parkHit = parkHitFactor(g.venue);
      // Away batters vs home pitcher
      (teamHitters[g.awayTeamId] || []).forEach(b => {
        bvpTasks.push({ batter: b, pitcherId: g.homePitcherId, pitcherName: g.homePitcherName, teamAbbr: g.awayTeamAbbr, teamName: g.awayTeamName, teamId: g.awayTeamId, oppTeam: g.homeTeamAbbr, oppTeamId: g.homeTeamId, parkFac: parkFac, parkHit: parkHit, isHome: false, gamePk: g.gamePk, venue: g.venue });
      });
      // Home batters vs away pitcher
      (teamHitters[g.homeTeamId] || []).forEach(b => {
        bvpTasks.push({ batter: b, pitcherId: g.awayPitcherId, pitcherName: g.awayPitcherName, teamAbbr: g.homeTeamAbbr, teamName: g.homeTeamName, teamId: g.homeTeamId, oppTeam: g.awayTeamAbbr, oppTeamId: g.awayTeamId, parkFac: parkFac, parkHit: parkHit, isHome: true, gamePk: g.gamePk, venue: g.venue });
      });
    });

    // Fetch BvP in parallel (batched). Higher concurrency since we're now checking full rosters.
    const bvpResults = await mapLimit(bvpTasks, 30, async task => {
      if (!task.pitcherId) return { ab: 0, hits: 0, avg: 0 };
      return await getBvP(task.batter.personId, task.pitcherId);
    });

    // Build final picks
    const picks = [];
    bvpTasks.forEach((task, i) => {
      const bvp = bvpResults[i];
      const seasonAvg = task.batter.avg;
      let blended = seasonAvg;
      if (bvp.ab >= 10) blended = 0.6 * seasonAvg + 0.4 * bvp.avg;
      else if (bvp.ab >= 5) blended = 0.8 * seasonAvg + 0.2 * bvp.avg;
      // Use parkHitFactor now (hit-specific) instead of parkFac (run-based)
      const adjusted = blended * task.parkHit;
      const perAB = Math.min(0.99, Math.max(0.01, adjusted));
      const gameHitProb = 1 - Math.pow(1 - perAB, 4);

      // Resolve pitcher data
      const pStat = task.pitcherId ? pitcherStats[task.pitcherId] : null;
      const pLast3 = task.pitcherId ? pitcherLast3[task.pitcherId] : { starts:0, era:0, ip:0, er:0 };
      const vsTeamKey = task.pitcherId + '_' + task.teamId;
      const pVsTeam = pitcherVsTeam[vsTeamKey] || { starts:0, era:0, ip:0, er:0 };

      // Determine platoon advantage (LHB vs RHP or RHB vs LHP = platoon)
      const batSide = task.batter.batSide || 'R';
      const pHand = (pStat && pStat.pitchHand) || 'R';
      let platoonAdv = false;
      if (batSide === 'S') platoonAdv = true; // switch hitters always have advantage
      else if (batSide !== pHand) platoonAdv = true;

      picks.push({
        name: task.batter.name,
        team: task.teamAbbr,
        teamName: task.teamName,
        position: task.batter.position,
        batSide: batSide,
        seasonAvg: seasonAvg,
        seasonAb: task.batter.ab,
        seasonOps: task.batter.ops,
        bvpAb: bvp.ab,
        bvpHits: bvp.hits,
        bvpAvg: bvp.avg,
        opposingPitcher: task.pitcherName,
        pitcherStats: pStat,
        pitcherHand: pHand,
        pitcherLast3: pLast3,
        pitcherVsTeam: pVsTeam,
        platoonAdvantage: platoonAdv,
        parkFactor: task.parkFac,
        parkHitFactor: task.parkHit,
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
