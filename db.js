/**
 * db.js — Data layer for Quran Memorization Tracker
 * Reads/writes data.json via GitHub API. No server needed.
 */

// ─── Config ───
const DATA_URL = 'data.json';

// ─── Core: load & save ───

async function loadData() {
  const res = await fetch(DATA_URL + '?t=' + Date.now());
  if (!res.ok) throw new Error('Failed to load data');
  return res.json();
}

async function saveData(data, token, repo, message) {
  // First get the current file to obtain its SHA
  const apiBase = `https://api.github.com/repos/${repo}/contents/data.json`;
  const getRes = await fetch(apiBase, {
    headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' }
  });
  if (!getRes.ok) throw new Error('GitHub API error: ' + getRes.status);
  const current = await getRes.json();
  const sha = current.sha;

  // Encode new content as base64
  const jsonStr = JSON.stringify(data, null, 2, 'utf-8');
  const content = btoa(String.fromCharCode(...new TextEncoder().encode(jsonStr)));

  const putRes = await fetch(apiBase, {
    method: 'PUT',
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message: message || 'Update data', content, sha })
  });
  if (!putRes.ok) {
    const err = await putRes.json();
    throw new Error(err.message || 'Save failed');
  }
  return putRes.json();
}

// ─── Queries (in-memory, same as old database.py logic) ───

function getStudentById(data, id) {
  return data.students.find(s => s.id === id);
}

function getTeamById(data, id) {
  return data.teams.find(t => t.id === id);
}

function getSessionById(data, id) {
  return data.sessions.find(s => s.id === id);
}

function getStudentsByTeam(data, teamId) {
  return data.students.filter(s => s.team_id === teamId);
}

function getEntriesForSession(data, sessionId) {
  return data.entries.filter(e => e.session_id === sessionId);
}

function getEntry(data, studentId, sessionId) {
  return data.entries.find(e => e.student_id === studentId && e.session_id === sessionId);
}

// Team totals for a specific session
function getSessionTeamTotals(data, sessionId) {
  const entries = getEntriesForSession(data, sessionId);
  const totals = {};
  for (const t of data.teams) {
    totals[t.id] = { team_name: t.name, total_hifdh: 0, total_tilawah: 0, total_rabt: 0, total_points: 0 };
  }
  for (const e of entries) {
    const s = getStudentById(data, e.student_id);
    if (!s) continue;
    const tid = s.team_id;
    if (!totals[tid]) continue;
    totals[tid].total_hifdh += e.hifdh_pages;
    totals[tid].total_tilawah += e.tilawah_pages;
    totals[tid].total_rabt += e.rabt_pages;
    totals[tid].total_points += e.points;
  }
  return Object.values(totals).sort((a, b) => b.total_points - a.total_points);
}

// Cumulative team totals across all sessions
function getCumulativeTeamTotals(data) {
  const totals = {};
  for (const t of data.teams) {
    totals[t.id] = { team_name: t.name, total_hifdh: 0, total_tilawah: 0, total_rabt: 0, total_points: 0 };
  }
  for (const e of data.entries) {
    const s = getStudentById(data, e.student_id);
    if (!s) continue;
    const tid = s.team_id;
    if (!totals[tid]) continue;
    totals[tid].total_hifdh += e.hifdh_pages;
    totals[tid].total_tilawah += e.tilawah_pages;
    totals[tid].total_rabt += e.rabt_pages;
    totals[tid].total_points += e.points;
  }
  return Object.values(totals).sort((a, b) => b.total_points - a.total_points);
}

// Cumulative hifdh by session per team (for the line chart)
function getCumulativeHistory(data) {
  const sessions = [...data.sessions].sort((a, b) => a.id - b.id);
  const teams = data.teams;
  const history = [];

  for (const session of sessions) {
    const entries = getEntriesForSession(data, session.id);
    for (const team of teams) {
      const teamStudents = new Set(getStudentsByTeam(data, team.id).map(s => s.id));
      let sessionHifdh = 0, sessionPoints = 0;
      for (const e of entries) {
        if (teamStudents.has(e.student_id)) {
          sessionHifdh += e.hifdh_pages;
          sessionPoints += e.points;
        }
      }
      history.push({
        session_id: session.id, date: session.date, label: session.label,
        team_name: team.name, session_hifdh: sessionHifdh, session_points: sessionPoints
      });
    }
  }

  // Compute running cumulative per team
  const cumMap = {};
  for (const h of history) {
    const key = h.team_name;
    if (!cumMap[key]) cumMap[key] = 0;
    cumMap[key] += h.session_hifdh;
    h.cumulative_hifdh = cumMap[key];
  }

  return history;
}

// Top memorizers for a session (hifdh leaderboard)
function getTopMemorizers(data, sessionId) {
  const entries = getEntriesForSession(data, sessionId)
    .filter(e => e.hifdh_pages > 0);
  const result = entries.map(e => {
    const s = getStudentById(data, e.student_id);
    const t = s ? getTeamById(data, s.team_id) : null;
    return {
      student_name: s ? s.name : '?',
      team_name: t ? t.name : '?',
      hifdh_pages: e.hifdh_pages,
      tilawah_pages: e.tilawah_pages,
      rabt_pages: e.rabt_pages,
      points: e.points
    };
  });
  result.sort((a, b) => b.hifdh_pages - a.hifdh_pages);
  return result;
}

// Next available ID for a type
function nextId(data, type) {
  const arr = data[type];
  if (!arr || arr.length === 0) return 1;
  return Math.max(...arr.map(x => x.id)) + 1;
}

// ─── Mutations ───

function addSession(data, date, label) {
  const id = nextId(data, 'sessions');
  data.sessions.push({ id, date, label });
  return id;
}

function saveEntry(data, studentId, sessionId, hifdh, tilawah, rabt, points, notes) {
  const idx = data.entries.findIndex(e => e.student_id === studentId && e.session_id === sessionId);
  if (idx >= 0) {
    data.entries[idx].hifdh_pages = hifdh;
    data.entries[idx].tilawah_pages = tilawah;
    data.entries[idx].rabt_pages = rabt;
    data.entries[idx].points = points;
    data.entries[idx].notes = notes;
  } else {
    data.entries.push({
      id: nextId(data, 'entries'),
      student_id: studentId,
      session_id: sessionId,
      hifdh_pages: hifdh,
      tilawah_pages: tilawah,
      rabt_pages: rabt,
      points: points,
      notes: notes
    });
  }
}
