const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Auto-lock helpers ─────────────────────────────────────────────────────────

// Parse "DD/MM HH:MM" (Argentina time = UTC-3) → Date in UTC
function parseArgTime(kickoffArg) {
  const [datePart, timePart] = kickoffArg.split(' ');
  const [day, month] = datePart.split('/').map(Number);
  const [hour, min] = timePart.split(':').map(Number);
  // Argentina is UTC-3, so add 3 hours to get UTC
  return new Date(Date.UTC(2026, month - 1, day, hour + 3, min, 0));
}

const MAX_TIMEOUT = 2_147_483_647; // Node setTimeout 32-bit int limit (~24.8 days)

function scheduleAutoLocks() {
  const now = new Date();
  const matches = db.getAllMatches().filter(m => m.status === 'upcoming' && /\d{2}\/\d{2} \d{2}:\d{2}/.test(m.kickoff_arg));

  matches.forEach(m => {
    const kickoff = parseArgTime(m.kickoff_arg);
    const delay = kickoff - now;

    if (delay <= 0) {
      db.lockMatch(m.id);
    } else if (delay <= MAX_TIMEOUT) {
      setTimeout(() => {
        db.lockMatch(m.id);
        io.emit('match:locked', { match_id: m.id });
        console.log(`Locked match ${m.id}: ${m.team_home} vs ${m.team_away}`);
      }, delay);
    }
    // Matches beyond 24 days are handled by the hourly sweep below
  });
}

// Hourly sweep: lock any match whose kickoff has passed
setInterval(() => {
  const now = new Date();
  db.getAllMatches()
    .filter(m => m.status === 'upcoming' && /\d{2}\/\d{2} \d{2}:\d{2}/.test(m.kickoff_arg) && parseArgTime(m.kickoff_arg) <= now)
    .forEach(m => {
      db.lockMatch(m.id);
      io.emit('match:locked', { match_id: m.id });
    });
}, 60 * 60 * 1000);

// ── Broadcast helpers ─────────────────────────────────────────────────────────

function broadcastLeaderboard() {
  io.emit('leaderboard:updated', db.getLeaderboard());
}

function broadcastStandings() {
  io.emit('standings:updated', db.getStandings());
}

// ── Routes: Players ───────────────────────────────────────────────────────────

app.post('/api/users', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const user = db.upsertUser(name.trim());
  res.json(user);
});

app.get('/api/matches', (req, res) => {
  const userId = parseInt(req.query.user_id) || -1;
  res.json(db.getMatches(userId));
});

app.post('/api/predictions', (req, res) => {
  const { user_id, match_id, pred_home, pred_away } = req.body;
  if (!user_id || match_id == null || pred_home == null || pred_away == null)
    return res.status(400).json({ error: 'Missing fields' });
  if (db.getSetting('group_predictions_locked') === '1')
    return res.status(403).json({ error: 'Los pronósticos de grupos están bloqueados por el administrador.' });
  const result = db.savePrediction(user_id, match_id, pred_home, pred_away);
  if (!result.ok) return res.status(409).json(result);
  res.json(result);
});

app.post('/api/special-picks', (req, res) => {
  const { user_id, campeon, subcampeon, tercero, goleador, decepcion, revelacion } = req.body;
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });
  if (db.getSetting('special_picks_locked') === '1')
    return res.status(403).json({ error: 'Los picks especiales están bloqueados por el administrador.' });
  db.saveSpecialPicks(user_id, { campeon, subcampeon, tercero, goleador, decepcion, revelacion });
  res.json({ ok: true });
});

app.get('/api/settings/special-picks-locked', (req, res) => {
  res.json({ locked: db.getSetting('special_picks_locked') === '1' });
});
app.post('/api/admin/special-picks-lock', (req, res) => {
  const { locked } = req.body;
  db.setSetting('special_picks_locked', locked ? '1' : '0');
  io.emit('specials:lock', { locked: !!locked });
  res.json({ ok: true, locked: !!locked });
});

app.get('/api/settings/group-predictions-locked', (req, res) => {
  res.json({ locked: db.getSetting('group_predictions_locked') === '1' });
});
app.post('/api/admin/group-predictions-lock', (req, res) => {
  const { locked } = req.body;
  db.setSetting('group_predictions_locked', locked ? '1' : '0');
  io.emit('groups:lock', { locked: !!locked });
  res.json({ ok: true, locked: !!locked });
});

app.get('/api/settings/bonus-answers-locked', (req, res) => {
  res.json({ locked: db.getSetting('bonus_answers_locked') === '1' });
});
app.post('/api/admin/bonus-answers-lock', (req, res) => {
  const { locked } = req.body;
  db.setSetting('bonus_answers_locked', locked ? '1' : '0');
  io.emit('bonus:lock', { locked: !!locked });
  res.json({ ok: true, locked: !!locked });
});

app.get('/api/special-picks', (req, res) => {
  const userId = parseInt(req.query.user_id);
  res.json(db.getSpecialPicks(userId) || {});
});

app.get('/api/leaderboard', (req, res) => {
  res.json(db.getLeaderboard());
});

app.get('/api/standings', (req, res) => {
  res.json(db.getStandings());
});

app.get('/api/bonus-tracks', (req, res) => {
  const userId = parseInt(req.query.user_id) || -1;
  res.json(db.getBonusTracks(userId));
});

app.post('/api/bonus-answers', (req, res) => {
  const { user_id, bonus_track_id, answer } = req.body;
  if (!user_id || !bonus_track_id || !answer) return res.status(400).json({ error: 'Missing fields' });
  if (db.getSetting('bonus_answers_locked') === '1')
    return res.status(403).json({ error: 'Las respuestas de bonus están bloqueadas por el administrador.' });
  const result = db.saveBonusAnswer(user_id, bonus_track_id, answer);
  if (!result.ok) return res.status(409).json(result);
  res.json(result);
});

// Playoff routes
app.get('/api/playoffs', (req, res) => {
  const userId = parseInt(req.query.user_id) || -1;
  res.json(db.getPlayoffMatches(userId));
});

app.post('/api/playoff-predictions', (req, res) => {
  const { user_id, match_id, pred_home, pred_away, pred_pens_winner } = req.body;
  if (!user_id || match_id == null) return res.status(400).json({ error: 'Missing fields' });
  const result = db.savePlayoffPrediction(user_id, match_id, pred_home, pred_away, pred_pens_winner);
  if (!result.ok) return res.status(409).json(result);
  res.json(result);
});

// ── Routes: Admin ─────────────────────────────────────────────────────────────

app.post('/api/admin/result', (req, res) => {
  const { match_id, score_home, score_away } = req.body;
  if (match_id == null || score_home == null || score_away == null)
    return res.status(400).json({ error: 'Missing fields' });
  db.saveGroupResult(match_id, score_home, score_away);
  broadcastLeaderboard();
  broadcastStandings();
  res.json({ ok: true });
});

app.post('/api/admin/playoff-result', (req, res) => {
  const { match_id, score_home, score_away, went_to_pens, pens_winner } = req.body;
  if (match_id == null || score_home == null || score_away == null)
    return res.status(400).json({ error: 'Missing fields' });
  db.savePlayoffResult(match_id, score_home, score_away, went_to_pens, pens_winner);
  broadcastLeaderboard();
  res.json({ ok: true });
});

app.post('/api/admin/special-result', (req, res) => {
  const { category, actual_value } = req.body;
  if (!category || !actual_value) return res.status(400).json({ error: 'Missing fields' });
  db.resolveSpecial(category, actual_value);
  broadcastLeaderboard();
  res.json({ ok: true });
});

app.get('/api/admin/special-actuals', (req, res) => {
  res.json(db.getSpecialActuals());
});

app.post('/api/admin/bonus-track', (req, res) => {
  const { question_number, question_text, deadline_arg } = req.body;
  if (!question_text || !deadline_arg) return res.status(400).json({ error: 'Missing fields' });
  const id = db.createBonusTrack(question_number || 1, question_text, deadline_arg);
  io.emit('bonus:new', { id, question_number: question_number || 1, question_text, deadline_arg });
  res.json({ ok: true, id });
});

app.put('/api/admin/bonus-track/:id', (req, res) => {
  const { question_number, question_text, deadline_arg } = req.body;
  if (!question_text || !deadline_arg) return res.status(400).json({ error: 'Missing fields' });
  db.updateBonusTrack(parseInt(req.params.id), question_number || 1, question_text, deadline_arg);
  io.emit('bonus:updated');
  res.json({ ok: true });
});

app.post('/api/admin/bonus-track/:id/reopen', (req, res) => {
  db.reopenBonusTrack(parseInt(req.params.id));
  io.emit('bonus:updated');
  broadcastLeaderboard();
  res.json({ ok: true });
});

app.post('/api/admin/bonus-result', (req, res) => {
  const { bonus_track_id, correct_answer } = req.body;
  if (!bonus_track_id || !correct_answer) return res.status(400).json({ error: 'Missing fields' });
  db.resolveBonusTrack(bonus_track_id, correct_answer);
  broadcastLeaderboard();
  res.json({ ok: true });
});

app.post('/api/admin/playoff-match', (req, res) => {
  const { stage, team_home, team_away, kickoff_arg } = req.body;
  if (!stage || !team_home || !team_away) return res.status(400).json({ error: 'Missing fields' });
  const id = db.createPlayoffMatch(stage, team_home, team_away, kickoff_arg || 'TBD');
  scheduleAutoLocks();
  res.json({ ok: true, id });
});

app.delete('/api/admin/playoff-match/:id', (req, res) => {
  db.deletePlayoffMatch(parseInt(req.params.id));
  broadcastLeaderboard();
  res.json({ ok: true });
});

app.get('/api/admin/export', (req, res) => {
  const data = db.exportAll();
  const filename = `prode-backup-${new Date().toISOString().slice(0,10)}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(data, null, 2));
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────

io.on('connection', socket => {
  console.log('Client connected');
  socket.emit('leaderboard:updated', db.getLeaderboard());
  socket.emit('standings:updated', db.getStandings());
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

db.init().then(() => {
  scheduleAutoLocks();
  server.listen(PORT, () => {
    console.log(`\n🌍 Prode USA 2026 running on port ${PORT}`);
    console.log(`   Admin panel: /admin.html\n`);
  });
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
