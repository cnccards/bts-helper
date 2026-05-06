var _internalHandler;
// netlify/functions/picks.js
// v14: + lineup status (batting order, confirmed) + recent form (last 15 games)

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

async function getTeamBattersWithStats(teamId, season) {
  const url = `${API}/teams/${teamId}/roster?rosterType=active&hydrate=person(stats(type=season,group=hitting,season=${season}),batSide)`;
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
      var batSide = 'R';
      if (person.batSide && person.batSide.code) {
        batSide = person.batSide.code;
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
      pitchHand = person.pitchHand.code;
    }
    return { era: era, whip: whip, baa: baa, pitchHand: pitchHand };
  } catch (e) {}
  return { era: 0, whip: 0, baa: 0, pitchHand: 'R' };
}

async function getPitcherLast3(pitcherId, season) {
  const url = `${API}/people/${pitcherId}/stats?stats=gameLog&group=pitching&season=${season}`;
  try {
    const data = await fetchJson(url, 3500);
    for (const s of (data.stats || [])) {
      const splits = s.splits || [];
      if (!splits.length) continue;
      const starts = splits.filter(sp => sp.stat && parseInt(sp.stat.gamesStarted || '0', 10) >= 1);
      const last3 = starts.slice(-3);
      if (!last3.length) return { starts: 0, era: 0, ip: 0, er: 0 };
      let totalOuts = 0, totalER = 0;
      for (const sp of last3) {
        const ipStr = sp.stat.inningsPitched || '0';
        const ipParts = String(ipStr).split('.');
        const wholeIp = parseInt(ipParts[0] || '0', 10);
        const fracOuts = parseInt(ipParts[1] || '0', 10);
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

// v14 NEW: Get batter's last 15 games rolling AVG
async function getBatterRecentForm(batterId, season) {
  const url = `${API}/people/${batterId}/stats?stats=gameLog&group=hitting&season=${season}`;
  try {
    const data = await fetchJson(url, 2500);
    for (const s of (data.stats || [])) {
      const splits = s.splits || [];
      if (!splits.length) continue;
      // gameLog returns oldest -> newest. Take last 15 games.
      const last15 = splits.slice(-15);
      let totalAb = 0, totalHits = 0;
      for (const sp of last15) {
        if (!sp.stat) continue;
        totalAb += parseInt(sp.stat.atBats || '0', 10) || 0;
        totalHits += parseInt(sp.stat.hits || '0', 10) || 0;
      }
      const avg = totalAb > 0 ? totalHits / totalAb : 0;
      return { games: last15.length, ab: totalAb, hits: totalHits, avg: avg };
    }
  } catch (e) {}
  return { games: 0, ab: 0, hits: 0, avg: 0 };
}

// v14 NEW: Get today's lineup for a team (returns map of personId -> battingOrder)
// Returns null if lineup not yet posted (so we can flag "unconfirmed")
async function getTeamLineup(gamePk, teamSide) {
  // teamSide is 'home' or 'away'
  const url = `${API}/game/${gamePk}/boxscore`;
  try {
    const data = await fetchJson(url, 2500);
    const teams = data.teams || {};
    const t = teams[teamSide];
    if (!t || !t.battingOrder || !t.battingOrder.length) {
      return null; // lineup not posted yet
    }
    // battingOrder is array of personIds in batting order positions
    // First 9 are starters in order 1-9
    const lineup = {};
    t.battingOrder.slice(0, 9).forEach((pid, idx) => {
      lineup[pid] = idx + 1; // 1 through 9
    });
    return lineup;
  } catch (e) {}
  return null;
}

// v15 NEW: Get game over/under totals from The Odds API
// Returns map of "AwayTeam@HomeTeam" -> total (e.g., 8.5)
// Returns empty map if API key missing or call fails - graceful degradation
async function getGameTotals() {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return {}; // No key configured - skip silently

  const url = 'https://api.the-odds-api.com/v4/sports/baseball_mlb/odds?regions=us&markets=totals&oddsFormat=american&apiKey=' + apiKey;
  try {
    const data = await fetchJson(url, 4000);
    if (!Array.isArray(data)) return {};

    const totalsMap = {};
    for (const game of data) {
      const home = game.home_team;
      const away = game.away_team;
      if (!home || !away) continue;

      // Find first bookmaker with totals data, average their over/under point
      let totalSum = 0, totalCount = 0;
      for (const book of (game.bookmakers || [])) {
        for (const market of (book.markets || [])) {
          if (market.key !== 'totals') continue;
          for (const outcome of (market.outcomes || [])) {
            if (outcome.point != null) {
              totalSum += outcome.point;
              totalCount++;
              break; // one point per market (over and under share the same point)
            }
          }
        }
      }
      if (totalCount > 0) {
        const avgTotal = totalSum / totalCount;
        // Index by both team-name and abbreviation-friendly key
        const key = away + '@' + home;
        totalsMap[key] = Math.round(avgTotal * 10) / 10;
      }
    }
    return totalsMap;
  } catch (e) {
    return {};
  }
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

    const pitcherVsTeamPairs = [];
    games.forEach(g => {
      if (g.awayPitcherId && g.homeTeamId) {
        pitcherVsTeamPairs.push({ pitcherId: g.awayPitcherId, teamId: g.homeTeamId });
      }
      if (g.homePitcherId && g.awayTeamId) {
        pitcherVsTeamPairs.push({ pitcherId: g.homePitcherId, teamId: g.awayTeamId });
      }
    });

    // v14: also fetch lineups (one per game-side)
    const lineupTasks = [];
    games.forEach(g => {
      lineupTasks.push({ gamePk: g.gamePk, teamSide: 'home', teamId: g.homeTeamId });
      lineupTasks.push({ gamePk: g.gamePk, teamSide: 'away', teamId: g.awayTeamId });
    });

    const [teamBattersArrays, pitcherStatsArr, pitcherLast3Arr, pitcherVsTeamArr, lineupArr, gameTotalsMap] = await Promise.all([
      mapLimit(teamIdArr, 10, id => getTeamBattersWithStats(id, season)),
      mapLimit(pitcherIdArr, 10, id => getPitcherStats(id, season)),
      mapLimit(pitcherIdArr, 10, id => getPitcherLast3(id, season)),
      mapLimit(pitcherVsTeamPairs, 10, pair => getPitcherVsTeam(pair.pitcherId, pair.teamId, season)),
      mapLimit(lineupTasks, 15, t => getTeamLineup(t.gamePk, t.teamSide)),
      getGameTotals()
    ]);

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

    // v14: index lineups by gamePk + side
    const lineupsByKey = {};
    lineupTasks.forEach((task, i) => {
      const key = task.gamePk + '_' + task.teamSide;
      lineupsByKey[key] = lineupArr[i]; // null if unconfirmed
    });

    const teamHitters = {};
    for (const tid of teamIdArr) {
      teamHitters[tid] = (teamBatters[tid] || [])
        .filter(b => b.ab >= 5)
        .sort((a, b) => b.ab - a.ab);
    }

    // v14: collect all unique batter IDs that we'll need recent form for
    // Limit to those we'll actually rank - all hitters with 5+ ABs
    const allBatterIds = new Set();
    for (const tid of teamIdArr) {
      (teamHitters[tid] || []).forEach(b => allBatterIds.add(b.personId));
    }
    const batterIdArr = Array.from(allBatterIds);

    // Fetch recent form for all batters in parallel (keep concurrency reasonable)
    const recentFormArr = await mapLimit(batterIdArr, 20, id => getBatterRecentForm(id, season));
    const recentFormByBatter = {};
    batterIdArr.forEach((id, i) => {
      recentFormByBatter[id] = recentFormArr[i] || { games: 0, ab: 0, hits: 0, avg: 0 };
    });

    const bvpTasks = [];
    games.forEach(g => {
      const parkFac = parkFactor(g.venue);
      const parkHit = parkHitFactor(g.venue);
      const awayLineupKey = g.gamePk + '_away';
      const homeLineupKey = g.gamePk + '_home';
      const awayLineup = lineupsByKey[awayLineupKey];
      const homeLineup = lineupsByKey[homeLineupKey];
      // v15: lookup game total by team-name key
      const totalKey = g.awayTeamName + '@' + g.homeTeamName;
      const gameTotal = gameTotalsMap[totalKey] || null;
      (teamHitters[g.awayTeamId] || []).forEach(b => {
        const battingOrder = awayLineup ? (awayLineup[b.personId] || null) : null;
        const lineupConfirmed = !!awayLineup;
        bvpTasks.push({ batter: b, pitcherId: g.homePitcherId, pitcherName: g.homePitcherName, teamAbbr: g.awayTeamAbbr, teamName: g.awayTeamName, teamId: g.awayTeamId, oppTeam: g.homeTeamAbbr, oppTeamId: g.homeTeamId, parkFac: parkFac, parkHit: parkHit, isHome: false, gamePk: g.gamePk, venue: g.venue, battingOrder: battingOrder, lineupConfirmed: lineupConfirmed, gameTotal: gameTotal });
      });
      (teamHitters[g.homeTeamId] || []).forEach(b => {
        const battingOrder = homeLineup ? (homeLineup[b.personId] || null) : null;
        const lineupConfirmed = !!homeLineup;
        bvpTasks.push({ batter: b, pitcherId: g.awayPitcherId, pitcherName: g.awayPitcherName, teamAbbr: g.homeTeamAbbr, teamName: g.homeTeamName, teamId: g.homeTeamId, oppTeam: g.awayTeamAbbr, oppTeamId: g.awayTeamId, parkFac: parkFac, parkHit: parkHit, isHome: true, gamePk: g.gamePk, venue: g.venue, battingOrder: battingOrder, lineupConfirmed: lineupConfirmed, gameTotal: gameTotal });
      });
    });

    const bvpResults = await mapLimit(bvpTasks, 30, async task => {
      if (!task.pitcherId) return { ab: 0, hits: 0, avg: 0 };
      return await getBvP(task.batter.personId, task.pitcherId);
    });

    const picks = [];
    bvpTasks.forEach((task, i) => {
      const bvp = bvpResults[i];
      const seasonAvg = task.batter.avg;
      const recentForm = recentFormByBatter[task.batter.personId] || { games:0, ab:0, hits:0, avg:0 };

      // v14: blend uses recent form too if we have meaningful sample
      // Old: season + BvP only. New: weight recent form alongside season.
      let blended = seasonAvg;
      if (recentForm.ab >= 30) {
        // Solid 15-game sample: 50% season + 50% recent
        blended = 0.5 * seasonAvg + 0.5 * recentForm.avg;
      } else if (recentForm.ab >= 15) {
        // Partial sample: 70% season + 30% recent
        blended = 0.7 * seasonAvg + 0.3 * recentForm.avg;
      }
      // Then layer in BvP if we have it
      if (bvp.ab >= 10) blended = 0.6 * blended + 0.4 * bvp.avg;
      else if (bvp.ab >= 5) blended = 0.8 * blended + 0.2 * bvp.avg;

      const adjusted = blended * task.parkHit;
      const perAB = Math.min(0.99, Math.max(0.01, adjusted));
      const gameHitProb = 1 - Math.pow(1 - perAB, 4);

      const pStat = task.pitcherId ? pitcherStats[task.pitcherId] : null;
      const pLast3 = task.pitcherId ? pitcherLast3[task.pitcherId] : { starts:0, era:0, ip:0, er:0 };
      const vsTeamKey = task.pitcherId + '_' + task.teamId;
      const pVsTeam = pitcherVsTeam[vsTeamKey] || { starts:0, era:0, ip:0, er:0 };

      const batSide = task.batter.batSide || 'R';
      const pHand = (pStat && pStat.pitchHand) || 'R';
      let platoonAdv = false;
      if (batSide === 'S') platoonAdv = true;
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
        // v14 NEW
        recentAvg: recentForm.avg,
        recentAb: recentForm.ab,
        recentHits: recentForm.hits,
        recentGames: recentForm.games,
        battingOrder: task.battingOrder,
        lineupConfirmed: task.lineupConfirmed,
        gameTotal: task.gameTotal,
        // existing
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


export default async function handler(req, res) {
  try {
    const result = await _internalHandler();
    const statusCode = result.statusCode || 200;
    const headers = result.headers || { 'Content-Type': 'application/json' };
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }
    res.status(statusCode).send(result.body);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
