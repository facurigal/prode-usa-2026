const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const fixture = require('./data/fixture');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'prode.db');

let db;

// ── Scoring ───────────────────────────────────────────────────────────────────

function calcGroupPoints(predH, predA, realH, realA) {
  if (predH === realH && predA === realA) return 5;
  const predSign = Math.sign(predH - predA);
  const realSign = Math.sign(realH - realA);
  return predSign === realSign ? 2 : 0;
}

function calcPlayoffPoints(predH, predA, realH, realA, wentToPens, pensWinner, predPensWinner) {
  if (!wentToPens) return calcGroupPoints(predH, predA, realH, realA);
  if (predPensWinner !== pensWinner) return 1;
  return (predH === realH && predA === realA) ? 5 : 2;
}

// ── Persistence ───────────────────────────────────────────────────────────────

function save() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`PRAGMA journal_mode=WAL`);

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL COLLATE NOCASE,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS matches (
      id           INTEGER PRIMARY KEY,
      match_number INTEGER NOT NULL,
      stage        TEXT NOT NULL DEFAULT 'group',
      grp          TEXT,
      team_home    TEXT NOT NULL,
      team_away    TEXT NOT NULL,
      kickoff_arg  TEXT NOT NULL,
      venue        TEXT,
      status       TEXT NOT NULL DEFAULT 'upcoming',
      score_home   INTEGER,
      score_away   INTEGER,
      went_to_pens INTEGER DEFAULT 0,
      pens_winner  TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS predictions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id          INTEGER NOT NULL REFERENCES users(id),
      match_id         INTEGER NOT NULL REFERENCES matches(id),
      pred_home        INTEGER NOT NULL,
      pred_away        INTEGER NOT NULL,
      pred_pens_winner TEXT,
      points           INTEGER,
      created_at       TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, match_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS special_picks (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER UNIQUE NOT NULL REFERENCES users(id),
      campeon        TEXT,
      subcampeon     TEXT,
      tercero        TEXT,
      goleador       TEXT,
      decepcion      TEXT,
      revelacion     TEXT,
      pts_campeon    INTEGER DEFAULT 0,
      pts_subcampeon INTEGER DEFAULT 0,
      pts_tercero    INTEGER DEFAULT 0,
      pts_goleador   INTEGER DEFAULT 0,
      pts_decepcion  INTEGER DEFAULT 0,
      pts_revelacion INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS bonus_tracks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      question_number INTEGER NOT NULL,
      question_text   TEXT NOT NULL,
      correct_answer  TEXT,
      deadline_arg    TEXT NOT NULL,
      status          TEXT DEFAULT 'open'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    )
  `);
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('special_picks_locked', '0')`);
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('group_predictions_locked', '0')`);
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('bonus_answers_locked', '0')`);
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('lock_on_match_day', '0')`);
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('lock_30min_before', '0')`);

  db.run(`
    CREATE TABLE IF NOT EXISTS bonus_answers (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER NOT NULL REFERENCES users(id),
      bonus_track_id INTEGER NOT NULL REFERENCES bonus_tracks(id),
      answer         TEXT NOT NULL,
      points         INTEGER DEFAULT 0,
      UNIQUE(user_id, bonus_track_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS special_actuals (
      category TEXT PRIMARY KEY,
      value    TEXT NOT NULL
    )
  `);

  // Seed group stage matches if table is empty
  const count = db.exec('SELECT COUNT(*) as n FROM matches')[0].values[0][0];
  if (count === 0) {
    const stmt = db.prepare(`
      INSERT INTO matches (id, match_number, stage, grp, team_home, team_away, kickoff_arg, venue)
      VALUES (?, ?, 'group', ?, ?, ?, ?, ?)
    `);
    fixture.forEach((m, i) => {
      stmt.run([m.id, i + 1, m.group, m.home, m.away, m.kickoff_arg, m.venue]);
    });
    stmt.free();
    save();
  } else if (process.env.SYNC_FIXTURE === '1') {
    // Sync kickoff times from fixture (run once on Railway after fixture update)
    const upd = db.prepare(`UPDATE matches SET kickoff_arg=?, venue=? WHERE id=? AND stage='group'`);
    fixture.forEach(m => upd.run([m.kickoff_arg, m.venue, m.id]));
    upd.free();
    save();
  }

  return db;
}

// ── Users ─────────────────────────────────────────────────────────────────────

function upsertUser(name) {
  db.run(`INSERT OR IGNORE INTO users (name) VALUES (?)`, [name.trim()]);
  const rows = db.exec(`SELECT id, name FROM users WHERE name = ? COLLATE NOCASE`, [name.trim()]);
  save();
  return { id: rows[0].values[0][0], name: rows[0].values[0][1] };
}

// ── Matches ───────────────────────────────────────────────────────────────────

function getMatches(userId) {
  const rows = db.exec(`
    SELECT m.id, m.match_number, m.stage, m.grp, m.team_home, m.team_away,
           m.kickoff_arg, m.venue, m.status, m.score_home, m.score_away,
           m.went_to_pens, m.pens_winner,
           p.pred_home, p.pred_away, p.pred_pens_winner, p.points
    FROM matches m
    LEFT JOIN predictions p ON p.match_id = m.id AND p.user_id = ?
    ORDER BY m.id
  `, [userId]);

  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => obj[c] = row[i]);
    return obj;
  });
}

function getMatchPredictions(matchId) {
  const rows = db.exec(`
    SELECT u.name, p.pred_home, p.pred_away, p.points
    FROM predictions p
    JOIN users u ON u.id = p.user_id
    WHERE p.match_id = ?
    ORDER BY p.points DESC, u.name ASC
  `, [matchId]);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => obj[c] = row[i]);
    return obj;
  });
}

function lockMatch(matchId) {
  db.run(`UPDATE matches SET status='locked' WHERE id=? AND status='upcoming'`, [matchId]);
  save();
}

// ── Predictions ───────────────────────────────────────────────────────────────

function savePrediction(userId, matchId, predHome, predAway) {
  const match = db.exec(`SELECT status FROM matches WHERE id=?`, [matchId]);
  if (!match.length || match[0].values[0][0] !== 'upcoming') return { ok: false, error: 'Match is locked' };

  db.run(`
    INSERT INTO predictions (user_id, match_id, pred_home, pred_away)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, match_id) DO UPDATE SET pred_home=excluded.pred_home, pred_away=excluded.pred_away
  `, [userId, matchId, predHome, predAway]);
  save();
  return { ok: true };
}

// ── Special Picks ─────────────────────────────────────────────────────────────

function saveSpecialPicks(userId, picks) {
  db.run(`
    INSERT INTO special_picks (user_id, campeon, subcampeon, tercero, goleador, decepcion, revelacion)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      campeon=excluded.campeon, subcampeon=excluded.subcampeon,
      tercero=excluded.tercero, goleador=excluded.goleador,
      decepcion=excluded.decepcion, revelacion=excluded.revelacion
  `, [userId, picks.campeon, picks.subcampeon, picks.tercero, picks.goleador, picks.decepcion, picks.revelacion]);
  save();
  return { ok: true };
}

function getSpecialPicks(userId) {
  const rows = db.exec(`SELECT * FROM special_picks WHERE user_id=?`, [userId]);
  if (!rows.length) return null;
  const cols = rows[0].columns;
  const obj = {};
  cols.forEach((c, i) => obj[c] = rows[0].values[0][i]);
  return obj;
}

// ── Admin: Group Result ───────────────────────────────────────────────────────

function saveGroupResult(matchId, scoreHome, scoreAway) {
  db.run(`UPDATE matches SET status='played', score_home=?, score_away=? WHERE id=?`,
    [scoreHome, scoreAway, matchId]);

  // Recalculate points for all predictions on this match
  const preds = db.exec(`SELECT id, user_id, pred_home, pred_away FROM predictions WHERE match_id=?`, [matchId]);
  if (preds.length) {
    const stmt = db.prepare(`UPDATE predictions SET points=? WHERE id=?`);
    preds[0].values.forEach(([predId, , predH, predA]) => {
      const pts = calcGroupPoints(predH, predA, scoreHome, scoreAway);
      stmt.run([pts, predId]);
    });
    stmt.free();
  }
  save();
}

function resetGroupResult(matchId) {
  db.run(`UPDATE matches SET status='upcoming', score_home=NULL, score_away=NULL WHERE id=? AND stage='group'`, [matchId]);
  db.run(`UPDATE predictions SET points=NULL WHERE match_id=?`, [matchId]);
  save();
}

// ── Admin: Playoff Result ─────────────────────────────────────────────────────

function savePlayoffResult(matchId, scoreHome, scoreAway, wentToPens, pensWinner) {
  db.run(`UPDATE matches SET status='played', score_home=?, score_away=?, went_to_pens=?, pens_winner=? WHERE id=?`,
    [scoreHome, scoreAway, wentToPens ? 1 : 0, pensWinner || null, matchId]);

  const preds = db.exec(
    `SELECT id, pred_home, pred_away, pred_pens_winner FROM predictions WHERE match_id=?`, [matchId]);
  if (preds.length) {
    const stmt = db.prepare(`UPDATE predictions SET points=? WHERE id=?`);
    preds[0].values.forEach(([predId, predH, predA, predPens]) => {
      const pts = calcPlayoffPoints(predH, predA, scoreHome, scoreAway, wentToPens, pensWinner, predPens);
      stmt.run([pts, predId]);
    });
    stmt.free();
  }
  save();
}

// ── Admin: Special Actuals ────────────────────────────────────────────────────

const SPECIAL_POINTS = { campeon: 15, subcampeon: 10, tercero: 5, goleador: 7, decepcion: 7, revelacion: 7 };

function resolveSpecial(category, actualValue) {
  // Store actual value (may be comma-separated for decepcion/revelacion)
  db.run(`INSERT OR REPLACE INTO special_actuals (category, value) VALUES (?, ?)`,
    [category, actualValue.trim()]);

  const actuals = actualValue.toLowerCase().split(',').map(s => s.trim());
  const pts = SPECIAL_POINTS[category] || 0;

  // Load all special picks
  const rows = db.exec(`SELECT user_id, ${category} FROM special_picks`);
  if (!rows.length) { save(); return; }

  const stmt = db.prepare(`UPDATE special_picks SET pts_${category}=? WHERE user_id=?`);
  rows[0].values.forEach(([uid, pick]) => {
    const earned = pick && actuals.includes(pick.toLowerCase().trim()) ? pts : 0;
    stmt.run([earned, uid]);
  });
  stmt.free();
  save();
}

function getSpecialActuals() {
  const rows = db.exec(`SELECT category, value FROM special_actuals`);
  if (!rows.length) return {};
  const obj = {};
  rows[0].values.forEach(([cat, val]) => obj[cat] = val);
  return obj;
}

// ── Bonus Tracks ──────────────────────────────────────────────────────────────

function createBonusTrack(questionNumber, questionText, deadlineArg) {
  db.run(`INSERT INTO bonus_tracks (question_number, question_text, deadline_arg) VALUES (?, ?, ?)`,
    [questionNumber, questionText, deadlineArg]);
  save();
  return db.exec(`SELECT last_insert_rowid() as id`)[0].values[0][0];
}

function updateBonusTrack(id, questionNumber, questionText, deadlineArg) {
  db.run(`UPDATE bonus_tracks SET question_number=?, question_text=?, deadline_arg=? WHERE id=?`,
    [questionNumber, questionText, deadlineArg, id]);
  save();
}

function reopenBonusTrack(id) {
  db.run(`UPDATE bonus_tracks SET status='open', correct_answer=NULL WHERE id=?`, [id]);
  db.run(`UPDATE bonus_answers SET points=0 WHERE bonus_track_id=?`, [id]);
  save();
}

function saveBonusAnswer(userId, bonusTrackId, answer) {
  const track = db.exec(`SELECT status FROM bonus_tracks WHERE id=?`, [bonusTrackId]);
  if (!track.length || track[0].values[0][0] !== 'open') return { ok: false, error: 'Bonus track is closed' };

  db.run(`
    INSERT INTO bonus_answers (user_id, bonus_track_id, answer)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, bonus_track_id) DO UPDATE SET answer=excluded.answer
  `, [userId, bonusTrackId, answer]);
  save();
  return { ok: true };
}

function resolveBonusTrack(bonusTrackId, correctAnswer) {
  db.run(`UPDATE bonus_tracks SET status='resolved', correct_answer=? WHERE id=?`,
    [correctAnswer, bonusTrackId]);

  const correct = correctAnswer.toLowerCase().trim();
  const answers = db.exec(
    `SELECT id, user_id, answer FROM bonus_answers WHERE bonus_track_id=?`, [bonusTrackId]);
  if (answers.length) {
    const stmt = db.prepare(`UPDATE bonus_answers SET points=? WHERE id=?`);
    answers[0].values.forEach(([ansId, , ans]) => {
      const pts = ans && ans.toLowerCase().trim() === correct ? 2 : 0;
      stmt.run([pts, ansId]);
    });
    stmt.free();
  }
  save();
}

function getBonusTracks(userId) {
  const rows = db.exec(`
    SELECT bt.id, bt.question_number, bt.question_text, bt.deadline_arg, bt.status, bt.correct_answer,
           ba.answer as my_answer, ba.points as my_points
    FROM bonus_tracks bt
    LEFT JOIN bonus_answers ba ON ba.bonus_track_id = bt.id AND ba.user_id = ?
    ORDER BY bt.question_number
  `, [userId || -1]);

  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => obj[c] = row[i]);
    return obj;
  });
}

// ── Leaderboard ───────────────────────────────────────────────────────────────

function getLeaderboard() {
  const rows = db.exec(`
    SELECT
      u.id,
      u.name,
      COALESCE(SUM(CASE WHEN m.stage='group'  THEN p.points ELSE 0 END), 0) AS pts_groups,
      COALESCE(SUM(CASE WHEN m.stage='r32'    THEN p.points ELSE 0 END), 0) AS pts_r32,
      COALESCE(SUM(CASE WHEN m.stage='r16'    THEN p.points ELSE 0 END), 0) AS pts_r16,
      COALESCE(SUM(CASE WHEN m.stage='qf'     THEN p.points ELSE 0 END), 0) AS pts_qf,
      COALESCE(SUM(CASE WHEN m.stage='sf'     THEN p.points ELSE 0 END), 0) AS pts_sf,
      COALESCE(SUM(CASE WHEN m.stage IN ('final','third') THEN p.points ELSE 0 END), 0) AS pts_final,
      COALESCE(sp.pts_campeon, 0)    AS pts_campeon,
      COALESCE(sp.pts_subcampeon, 0) AS pts_subcampeon,
      COALESCE(sp.pts_tercero, 0)    AS pts_tercero,
      COALESCE(sp.pts_goleador, 0)   AS pts_goleador,
      COALESCE(sp.pts_decepcion, 0)  AS pts_decepcion,
      COALESCE(sp.pts_revelacion, 0) AS pts_revelacion,
      COALESCE((SELECT SUM(ba.points) FROM bonus_answers ba WHERE ba.user_id=u.id), 0) AS pts_bonus
    FROM users u
    LEFT JOIN predictions p ON p.user_id = u.id
    LEFT JOIN matches m ON m.id = p.match_id AND m.status = 'played'
    LEFT JOIN special_picks sp ON sp.user_id = u.id
    GROUP BY u.id
    ORDER BY
      (COALESCE(SUM(p.points),0) + COALESCE(sp.pts_campeon,0) + COALESCE(sp.pts_subcampeon,0) +
       COALESCE(sp.pts_tercero,0) + COALESCE(sp.pts_goleador,0) + COALESCE(sp.pts_decepcion,0) +
       COALESCE(sp.pts_revelacion,0) +
       COALESCE((SELECT SUM(ba.points) FROM bonus_answers ba WHERE ba.user_id=u.id),0)) DESC
  `);

  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map((row, idx) => {
    const obj = { rank: idx + 1 };
    cols.forEach((c, i) => obj[c] = row[i]);
    obj.total = obj.pts_groups + obj.pts_r32 + obj.pts_r16 + obj.pts_qf + obj.pts_sf + obj.pts_final +
                obj.pts_campeon + obj.pts_subcampeon + obj.pts_tercero + obj.pts_goleador +
                obj.pts_decepcion + obj.pts_revelacion + obj.pts_bonus;
    return obj;
  });
}

// ── Standings ─────────────────────────────────────────────────────────────────

function getStandings() {
  const groups = ['A','B','C','D','E','F','G','H','I','J','K','L'];
  const result = {};

  // Get all played group matches
  const rows = db.exec(`
    SELECT grp, team_home, team_away, score_home, score_away
    FROM matches WHERE stage='group' AND status='played'
  `);

  const played = rows.length ? rows[0].values : [];

  // Build team stats
  const stats = {};
  fixture.forEach(m => {
    [m.home, m.away].forEach(team => {
      if (!stats[team]) stats[team] = { group: m.group, pj:0, g:0, e:0, p:0, gf:0, gc:0, dg:0, pts:0 };
    });
  });

  played.forEach(([grp, home, away, sh, sa]) => {
    const addStats = (team, gf, gc) => {
      const s = stats[team];
      s.pj++; s.gf += gf; s.gc += gc; s.dg = s.gf - s.gc;
      if (gf > gc) { s.g++; s.pts += 3; }
      else if (gf === gc) { s.e++; s.pts += 1; }
      else { s.p++; }
    };
    addStats(home, sh, sa);
    addStats(away, sa, sh);
  });

  groups.forEach(g => {
    const teams = Object.entries(stats)
      .filter(([, s]) => s.group === g)
      .map(([name, s]) => ({ name, ...s }))
      .sort((a, b) => b.pts - a.pts || b.dg - a.dg || b.gf - a.gf);
    result[g] = teams;
  });

  return result;
}

// ── Playoff match creation ────────────────────────────────────────────────────

function createPlayoffMatch(stage, teamHome, teamAway, kickoffArg) {
  db.run(`
    INSERT INTO matches (match_number, stage, team_home, team_away, kickoff_arg)
    VALUES ((SELECT COALESCE(MAX(match_number),72)+1 FROM matches), ?, ?, ?, ?)
  `, [stage, teamHome, teamAway, kickoffArg]);
  save();
  return db.exec(`SELECT last_insert_rowid() as id`)[0].values[0][0];
}

function lockMatchesForToday(dateStr) {
  const rows = db.exec(
    `SELECT id FROM matches WHERE status='upcoming' AND kickoff_arg LIKE ?`,
    [dateStr + '%']
  );
  if (!rows.length || !rows[0].values.length) return [];
  const ids = rows[0].values.map(([id]) => id);
  ids.forEach(id => db.run(`UPDATE matches SET status='locked' WHERE id=?`, [id]));
  save();
  return ids;
}

function updateMatchKickoff(id, kickoffArg) {
  db.run(`UPDATE matches SET kickoff_arg=? WHERE id=?`, [kickoffArg, id]);
  // If new kickoff is in the future, restore to upcoming so it isn't stuck locked
  db.run(`UPDATE matches SET status='upcoming' WHERE id=? AND status='locked' AND score_home IS NULL`, [id]);
  save();
}

function deletePlayoffMatch(id) {
  db.run(`DELETE FROM predictions WHERE match_id=?`, [id]);
  db.run(`DELETE FROM matches WHERE id=? AND stage != 'group'`, [id]);
  save();
}

function getPlayoffMatches(userId) {
  const stages = ['r32','r16','qf','sf','final','third'];
  const rows = db.exec(`
    SELECT m.id, m.stage, m.team_home, m.team_away, m.kickoff_arg, m.status,
           m.score_home, m.score_away, m.went_to_pens, m.pens_winner,
           p.pred_home, p.pred_away, p.pred_pens_winner, p.points
    FROM matches m
    LEFT JOIN predictions p ON p.match_id=m.id AND p.user_id=?
    WHERE m.stage IN ('r32','r16','qf','sf','final','third')
    ORDER BY m.id
  `, [userId || -1]);

  if (!rows.length) return {};
  const cols = rows[0].columns;
  const all = rows[0].values.map(row => {
    const obj = {}; cols.forEach((c, i) => obj[c] = row[i]); return obj;
  });
  const grouped = {};
  stages.forEach(s => { grouped[s] = all.filter(m => m.stage === s); });
  return grouped;
}

function savePlayoffPrediction(userId, matchId, predHome, predAway, predPensWinner) {
  const match = db.exec(`SELECT status FROM matches WHERE id=?`, [matchId]);
  if (!match.length || match[0].values[0][0] !== 'upcoming') return { ok: false, error: 'Match is locked' };

  db.run(`
    INSERT INTO predictions (user_id, match_id, pred_home, pred_away, pred_pens_winner)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, match_id) DO UPDATE SET
      pred_home=excluded.pred_home, pred_away=excluded.pred_away,
      pred_pens_winner=excluded.pred_pens_winner
  `, [userId, matchId, predHome, predAway, predPensWinner || null]);
  save();
  return { ok: true };
}

function getAllMatches() {
  const rows = db.exec(`SELECT * FROM matches ORDER BY id`);
  if (!rows.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map(row => { const o={}; cols.forEach((c,i)=>o[c]=row[i]); return o; });
}

// ── Settings ──────────────────────────────────────────────────────────────────

function getSetting(key) {
  const rows = db.exec(`SELECT value FROM settings WHERE key=?`, [key]);
  if (!rows.length || !rows[0].values.length) return null;
  return rows[0].values[0][0];
}

function setSetting(key, value) {
  db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key, String(value)]);
  save();
}

function deleteUser(name) {
  const user = db.exec(`SELECT id FROM users WHERE name = ? COLLATE NOCASE`, [name]);
  if (!user.length || !user[0].values.length) return;
  const userId = user[0].values[0][0];
  db.run(`DELETE FROM bonus_answers WHERE user_id = ?`, [userId]);
  db.run(`DELETE FROM predictions WHERE user_id = ?`, [userId]);
  db.run(`DELETE FROM special_picks WHERE user_id = ?`, [userId]);
  db.run(`DELETE FROM users WHERE id = ?`, [userId]);
  save();
}

function resetAll() {
  db.run('DELETE FROM bonus_answers');
  db.run('DELETE FROM bonus_tracks');
  db.run('DELETE FROM special_picks');
  db.run('DELETE FROM predictions');
  db.run('DELETE FROM users');
  db.run(`UPDATE matches SET status='upcoming', score_home=NULL, score_away=NULL, went_to_pens=0, pens_winner=NULL WHERE stage='group'`);
  db.run(`DELETE FROM matches WHERE stage != 'group'`);
  save();
}

function exportAll() {
  function query(sql) {
    const rows = db.exec(sql);
    if (!rows.length) return [];
    const cols = rows[0].columns;
    return rows[0].values.map(row => { const o={}; cols.forEach((c,i)=>o[c]=row[i]); return o; });
  }

  return {
    exported_at: new Date().toISOString(),
    users: query(`SELECT id, name, created_at FROM users ORDER BY id`),
    predictions: query(`
      SELECT u.name AS usuario, m.grp AS grupo, m.stage, m.team_home AS local, m.team_away AS visitante,
             m.kickoff_arg, p.pred_home, p.pred_away, p.pred_pens_winner, p.points,
             m.score_home, m.score_away, m.status
      FROM predictions p
      JOIN users u ON u.id = p.user_id
      JOIN matches m ON m.id = p.match_id
      ORDER BY u.name, m.id
    `),
    special_picks: query(`
      SELECT u.name AS usuario, sp.campeon, sp.subcampeon, sp.tercero, sp.goleador,
             sp.decepcion, sp.revelacion,
             sp.pts_campeon, sp.pts_subcampeon, sp.pts_tercero, sp.pts_goleador,
             sp.pts_decepcion, sp.pts_revelacion
      FROM special_picks sp
      JOIN users u ON u.id = sp.user_id
      ORDER BY u.name
    `),
    bonus_answers: query(`
      SELECT u.name AS usuario, bt.question_number, bt.question_text, bt.deadline_arg, bt.status,
             bt.correct_answer, ba.answer, ba.points
      FROM bonus_answers ba
      JOIN users u ON u.id = ba.user_id
      JOIN bonus_tracks bt ON bt.id = ba.bonus_track_id
      ORDER BY u.name, bt.question_number
    `),
    leaderboard: query(`
      SELECT u.name, COALESCE(SUM(p.points),0) AS pts_partidos,
             COALESCE(sp.pts_campeon,0) AS pts_campeon, COALESCE(sp.pts_subcampeon,0) AS pts_subcampeon,
             COALESCE(sp.pts_tercero,0) AS pts_tercero, COALESCE(sp.pts_goleador,0) AS pts_goleador,
             COALESCE(sp.pts_decepcion,0) AS pts_decepcion, COALESCE(sp.pts_revelacion,0) AS pts_revelacion,
             COALESCE((SELECT SUM(ba.points) FROM bonus_answers ba WHERE ba.user_id=u.id),0) AS pts_bonus
      FROM users u
      LEFT JOIN predictions p ON p.user_id=u.id
      LEFT JOIN special_picks sp ON sp.user_id=u.id
      GROUP BY u.id ORDER BY u.name
    `),
  };
}

module.exports = {
  init, save,
  upsertUser,
  getMatches, getMatchPredictions, lockMatch, getAllMatches,
  savePrediction,
  saveSpecialPicks, getSpecialPicks,
  saveGroupResult, resetGroupResult, savePlayoffResult,
  resolveSpecial, getSpecialActuals,
  createBonusTrack, updateBonusTrack, reopenBonusTrack, saveBonusAnswer, resolveBonusTrack, getBonusTracks,
  getLeaderboard, getStandings,
  lockMatchesForToday, updateMatchKickoff,
  createPlayoffMatch, deletePlayoffMatch, getPlayoffMatches, savePlayoffPrediction,
  exportAll, resetAll, deleteUser,
  getSetting, setSetting,
};
