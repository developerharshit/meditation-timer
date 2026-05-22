'use strict';

// ─── State ────────────────────────────────────────────
const app = {
  // timer
  duration:    45 * 60,   // seconds
  interval:    0,          // seconds between pings (0 = off)
  remaining:   45 * 60,
  status:      'idle',     // 'idle' | 'running' | 'paused'
  startedAt:   null,       // Date.now() when segment started
  elapsed:     0,          // seconds accumulated before this segment
  pingsFired:  0,          // interval pings fired this session

  // ui
  muted:       false,
  wakeLock:    null,
  ticker:      null,
};

const CIRC = 2 * Math.PI * 108; // ≈ 678.6

// ─── Audio ────────────────────────────────────────────
let _actx = null;
function actx() {
  if (!_actx) _actx = new (window.AudioContext || window.webkitAudioContext)();
  if (_actx.state === 'suspended') _actx.resume();
  return _actx;
}

function bell(type) {
  if (app.muted) return;
  const c   = actx();
  const now = c.currentTime;

  const configs = {
    start: { freqs:[432, 864, 1296, 1728], vol:0.38, dur:4.5 },
    end:   { freqs:[528, 1056, 1584],       vol:0.46, dur:5.5 },
    ping:  { freqs:[660, 1320, 1980],        vol:0.24, dur:2.2 },
  };
  const { freqs, vol, dur } = configs[type];
  const amps = [1, 0.42, 0.18, 0.09];

  freqs.forEach((freq, i) => {
    const osc = c.createOscillator();
    const g   = c.createGain();
    osc.type  = 'sine';
    osc.frequency.value = freq;

    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(vol * (amps[i] ?? 0.08), now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    osc.connect(g);
    g.connect(c.destination);
    osc.start(now);
    osc.stop(now + dur + 0.05);
  });
}

// ─── Wake Lock ────────────────────────────────────────
async function lockScreen() {
  if (!('wakeLock' in navigator)) return;
  try {
    app.wakeLock = await navigator.wakeLock.request('screen');
    app.wakeLock.addEventListener('release', () => { app.wakeLock = null; });
  } catch (_) {}
}
function unlockScreen() {
  app.wakeLock?.release().catch(() => {});
  app.wakeLock = null;
}

// ─── Timer core ───────────────────────────────────────
function startTimer() {
  if (app.status === 'idle') {
    app.elapsed     = 0;
    app.pingsFired  = 0;
    app.remaining   = app.duration;
    bell('start');
  } else {
    // resuming from pause
    bell('ping');
  }

  app.status    = 'running';
  app.startedAt = Date.now();
  lockScreen();
  app.ticker = setInterval(tick, 500);
  tick();
  syncUI();
}

function pauseTimer() {
  if (app.status !== 'running') return;
  clearInterval(app.ticker);
  app.elapsed  += (Date.now() - app.startedAt) / 1000;
  app.startedAt = null;
  app.status    = 'paused';
  unlockScreen();
  syncUI();
}

function resetTimer() {
  clearInterval(app.ticker);
  app.status    = 'idle';
  app.elapsed   = 0;
  app.startedAt = null;
  app.pingsFired = 0;
  app.remaining = app.duration;
  unlockScreen();
  syncUI();
}

function tick() {
  if (app.status !== 'running') return;

  const segSec     = (Date.now() - app.startedAt) / 1000;
  const totalSec   = app.elapsed + segSec;
  app.remaining    = Math.max(0, app.duration - totalSec);

  // interval pings
  if (app.interval > 0 && app.remaining > 1) {
    const due = Math.floor(totalSec / app.interval);
    if (due > app.pingsFired) {
      bell('ping');
      app.pingsFired = due;
      showPingRipple();
    }
  }

  if (app.remaining <= 0) {
    clearInterval(app.ticker);
    app.status    = 'idle';
    app.remaining = 0;
    unlockScreen();
    bell('end');
    const dur = app.duration;
    saveSession(dur);
    syncUI();
    setTimeout(() => showModal(dur), 600);
    return;
  }

  updateRingDisplay();
}

// ─── Ring & display update ────────────────────────────
function updateRingDisplay() {
  const ratio = app.duration > 0
    ? (app.duration - app.remaining) / app.duration   // 0 → 1 as session progresses
    : 0;

  document.getElementById('ringFill').style.strokeDashoffset =
    CIRC * (1 - ratio);

  document.getElementById('timeDisplay').textContent =
    fmtTime(app.remaining);
}

function syncUI() {
  const running = app.status === 'running';
  const active  = app.status !== 'idle';

  // play / pause icons
  document.getElementById('iconPlay').classList.toggle('hidden',  running);
  document.getElementById('iconPause').classList.toggle('hidden', !running);

  // reset
  document.getElementById('resetBtn').disabled = !active;

  // ring classes
  const fill = document.getElementById('ringFill');
  fill.classList.toggle('running', running);
  fill.classList.toggle('paused',  app.status === 'paused');

  // settings visibility
  document.getElementById('settingsBlock').classList.toggle('hidden', active);

  // sub-label
  const sub = document.getElementById('timeSub');
  if (!active) {
    sub.textContent = 'tap to begin';
    sub.className   = 'time-sub';
  } else if (running) {
    sub.textContent = 'meditating';
    sub.className   = 'time-sub running';
  } else {
    sub.textContent = 'paused';
    sub.className   = 'time-sub';
  }

  updateRingDisplay();
}

// ─── Ping ripple ──────────────────────────────────────
function showPingRipple() {
  const wrap = document.querySelector('.ring-wrap');
  const el   = document.createElement('div');
  el.className = 'ping-ripple';
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 800);
}

// ─── Settings ────────────────────────────────────────
function setDuration(mins) {
  app.duration  = mins * 60;
  app.remaining = app.duration;
  savePrefs();
  updateRingDisplay();
  document.getElementById('ringFill').style.strokeDashoffset = CIRC; // reset ring
}

function setIntervalSec(sec) {
  app.interval = sec;
  savePrefs();
}

// ─── Persistence ─────────────────────────────────────
function savePrefs() {
  try {
    localStorage.setItem('med_prefs', JSON.stringify({
      durMin:  app.duration  / 60,
      intSec:  app.interval,
      muted:   app.muted,
    }));
  } catch (_) {}
}

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('med_prefs') || 'null');
    if (!p) return;
    if (p.durMin) { app.duration = p.durMin * 60; app.remaining = app.duration; }
    if (p.intSec !== undefined) app.interval = p.intSec;
    if (p.muted  !== undefined) app.muted    = p.muted;
  } catch (_) {}
}

function getLogs() {
  try { return JSON.parse(localStorage.getItem('med_logs') || '[]'); }
  catch (_) { return []; }
}

function saveLogs(logs) {
  try { localStorage.setItem('med_logs', JSON.stringify(logs)); }
  catch (_) {}
}

function saveSession(durSec) {
  const logs = getLogs();
  logs.push({ id: Date.now(), ts: Date.now(), dur: Math.round(durSec) });
  saveLogs(logs);
}

// ─── Helpers ─────────────────────────────────────────
function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function fmtDur(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return m + 'm' + (s > 0 ? ` ${s}s` : '');
  return `${s}s`;
}

function localDateStr(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function todayStr()     { return localDateStr(Date.now()); }
function yesterdayStr() { return localDateStr(Date.now() - 86400000); }

// ─── Completion modal ─────────────────────────────────
function showModal(durSec) {
  const mins = Math.round(durSec / 60);
  document.getElementById('modalMeta').textContent =
    `${mins} minute session complete`;

  const { current } = calcStreaks(buildDailyMap(getLogs()));
  const streakEl = document.getElementById('modalStreak');
  if (current > 1) {
    streakEl.textContent = `🔥 ${current} day streak!`;
    streakEl.classList.remove('hidden');
  } else {
    streakEl.classList.add('hidden');
  }

  document.getElementById('modal').classList.remove('hidden');
  document.getElementById('modalBackdrop').classList.remove('hidden');
}

function hideModal() {
  document.getElementById('modal').classList.add('hidden');
  document.getElementById('modalBackdrop').classList.add('hidden');
}

// ─── History view ─────────────────────────────────────
function renderHistory() {
  const container = document.getElementById('historyList');
  const logs = getLogs().slice().reverse();

  if (logs.length === 0) {
    container.innerHTML = `
      <div class="hist-empty">
        No sessions yet.<br>Start your first meditation.
      </div>`;
    return;
  }

  const byDay = {};
  logs.forEach(log => {
    const day = localDateStr(log.ts);
    (byDay[day] ??= []).push(log);
  });

  const days = Object.keys(byDay).sort().reverse();

  container.innerHTML = days.map(day => {
    const label = dateLabelFor(day);
    const rows  = byDay[day].map(s => {
      const timeStr = new Date(s.ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
      return `
        <div class="hist-session">
          <div class="sess-icon">🧘</div>
          <div class="sess-info">
            <div class="sess-dur">${Math.round(s.dur / 60)} min</div>
            <div class="sess-time">${timeStr}</div>
          </div>
          <div class="sess-badge">${fmtDur(s.dur)}</div>
        </div>`;
    }).join('');
    return `<div class="hist-day"><div class="hist-date">${label}</div>${rows}</div>`;
  }).join('');
}

function dateLabelFor(dateStr) {
  if (dateStr === todayStr())     return 'Today';
  if (dateStr === yesterdayStr()) return 'Yesterday';
  return new Date(dateStr + 'T12:00:00').toLocaleDateString([], {
    weekday:'long', month:'short', day:'numeric',
  });
}

// ─── Stats view ───────────────────────────────────────
function buildDailyMap(logs) {
  const map = {};
  logs.forEach(l => {
    const d = localDateStr(l.ts);
    map[d] = (map[d] ?? 0) + l.dur;
  });
  return map;
}

function calcStreaks(daily) {
  const days = Object.keys(daily).sort();
  if (!days.length) return { current:0, longest:0 };

  let current = 0;
  const today = todayStr(), yday = yesterdayStr();
  const anchor = daily[today] ? today : daily[yday] ? yday : null;

  if (anchor) {
    let d = new Date(anchor + 'T12:00:00');
    while (daily[localDateStr(d.getTime())]) {
      current++;
      d.setDate(d.getDate() - 1);
    }
  }

  let longest = current, run = 1;
  for (let i = 1; i < days.length; i++) {
    const diff = (new Date(days[i]+'T12:00:00') - new Date(days[i-1]+'T12:00:00')) / 86400000;
    if (Math.round(diff) === 1) { run++; }
    else                        { longest = Math.max(longest, run); run = 1; }
  }
  longest = Math.max(longest, run);
  return { current, longest };
}

function renderStats() {
  const logs   = getLogs();
  const daily  = buildDailyMap(logs);
  const { current, longest } = calcStreaks(daily);
  const totalSec = logs.reduce((a, l) => a + l.dur, 0);

  document.getElementById('sCurStreak').textContent  = current;
  document.getElementById('sLngStreak').textContent  = longest;
  document.getElementById('sTotalSess').textContent  = logs.length;
  document.getElementById('sTotalHrs').textContent   = (totalSec / 3600).toFixed(1);

  renderHeatmap(daily);
}

function renderHeatmap(daily) {
  const WEEKS = 16;
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const today = new Date(); today.setHours(12,0,0,0);

  // build array of weeks (each week = 7 days, Sun→Sat)
  const end   = new Date(today);
  const start = new Date(today);
  start.setDate(start.getDate() - (WEEKS * 7 - 1) - start.getDay());

  const weeks = [];
  let cur = new Date(start);
  while (cur <= today) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      week.push({
        date:   localDateStr(cur.getTime()),
        sec:    daily[localDateStr(cur.getTime())] ?? 0,
        future: cur > today,
      });
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  }

  function level(sec) {
    const m = sec / 60;
    if (m === 0) return 0;
    if (m < 10)  return 1;
    if (m < 20)  return 2;
    if (m < 45)  return 3;
    return 4;
  }

  // grid
  const grid = document.getElementById('heatmapGrid');
  grid.innerHTML = weeks.map(week =>
    `<div class="hm-week">${
      week.map(day =>
        `<div class="hm-cell" data-l="${day.future ? 0 : level(day.sec)}"
              title="${day.date}: ${Math.round(day.sec/60)}min"></div>`
      ).join('')
    }</div>`
  ).join('');

  // month labels (absolute-positioned, 15px per column = 12px cell + 3px gap)
  const COL_W = 15;
  const months = document.getElementById('heatmapMonths');
  let lastMonth = -1, lastLabelCol = -4, html = '';
  weeks.forEach((week, i) => {
    const m = new Date(week[0].date + 'T12:00:00').getMonth();
    if (m !== lastMonth) {
      // skip if too close to previous label (need ≥3 cols gap to avoid overlap)
      if (i - lastLabelCol >= 3) {
        html += `<span class="hm-month" style="left:${i * COL_W}px">${MONTHS[m]}</span>`;
        lastLabelCol = i;
      }
      lastMonth = m;
    }
  });
  months.innerHTML = html;
}

// ─── Export / Import ──────────────────────────────────
function exportData() {
  const data = { version:1, logs: getLogs(), exported: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `meditate-logs-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data    = JSON.parse(e.target.result);
      const incoming = (data.logs ?? data) || [];
      if (!Array.isArray(incoming)) throw new Error('bad format');

      const existing = getLogs();
      const ids      = new Set(existing.map(l => l.id));
      const merged   = [...existing, ...incoming.filter(l => l.id && !ids.has(l.id))];
      merged.sort((a, b) => a.ts - b.ts);
      saveLogs(merged);
      renderHistory();
      alert(`Imported ${incoming.length} sessions (${merged.length - existing.length} new).`);
    } catch (err) {
      alert('Import failed: invalid file.');
    }
  };
  reader.readAsText(file);
}

// ─── Navigation ───────────────────────────────────────
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`v-${name}`).classList.add('active');
  document.querySelector(`.nav-btn[data-view="${name}"]`).classList.add('active');

  if (name === 'history') renderHistory();
  if (name === 'stats')   renderStats();
}

// ─── Chip selectors ───────────────────────────────────
function activateChip(group, matchFn) {
  group.querySelectorAll('.chip').forEach(c => {
    c.classList.toggle('active', matchFn(c));
  });
}

// ─── Init ─────────────────────────────────────────────
function init() {
  loadPrefs();

  // sync duration chips
  const durMin = app.duration / 60;
  const durPresets = [5, 10, 20, 30, 45, 60];
  const dChips = document.getElementById('durationChips');

  activateChip(dChips, c => {
    const v = c.dataset.min;
    if (v === 'custom') return !durPresets.includes(durMin);
    return parseInt(v) === durMin;
  });

  if (!durPresets.includes(durMin)) {
    document.getElementById('customMin').classList.remove('hidden');
    document.getElementById('customMin').value = durMin;
  }

  // sync interval chips
  activateChip(
    document.getElementById('intervalChips'),
    c => parseInt(c.dataset.sec) === app.interval,
  );

  // sync mute
  if (app.muted) {
    document.getElementById('iconSoundOn').classList.add('hidden');
    document.getElementById('iconSoundOff').classList.remove('hidden');
  }

  updateRingDisplay();

  // ── Event listeners ────────────────────────────────
  document.querySelectorAll('.nav-btn').forEach(btn =>
    btn.addEventListener('click', () => showView(btn.dataset.view))
  );

  function handlePlayTap() {
    if (_actx?.state === 'suspended') _actx.resume();
    if (app.status === 'running') pauseTimer(); else startTimer();
  }

  document.getElementById('playBtn').addEventListener('click', handlePlayTap);

  // Tapping the ring face (where "tap to begin" label sits) also starts/pauses
  document.querySelector('.ring-wrap').addEventListener('click', handlePlayTap);

  document.getElementById('resetBtn').addEventListener('click', resetTimer);

  document.getElementById('muteBtn').addEventListener('click', () => {
    app.muted = !app.muted;
    document.getElementById('iconSoundOn').classList.toggle('hidden',  app.muted);
    document.getElementById('iconSoundOff').classList.toggle('hidden', !app.muted);
    savePrefs();
  });

  // duration chips
  document.getElementById('durationChips').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip || app.status !== 'idle') return;

    activateChip(document.getElementById('durationChips'), c => c === chip);

    const val = chip.dataset.min;
    const ci  = document.getElementById('customMin');
    if (val === 'custom') {
      ci.classList.remove('hidden'); ci.focus();
    } else {
      ci.classList.add('hidden');
      setDuration(parseInt(val));
    }
  });

  document.getElementById('customMin').addEventListener('change', e => {
    const v = Math.max(1, Math.min(480, parseInt(e.target.value) || 20));
    e.target.value = v;
    setDuration(v);
  });

  // interval chips
  document.getElementById('intervalChips').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    activateChip(document.getElementById('intervalChips'), c => c === chip);
    setIntervalSec(parseInt(chip.dataset.sec));
  });

  // modal
  document.getElementById('modalClose').addEventListener('click', hideModal);
  document.getElementById('modalBackdrop').addEventListener('click', hideModal);

  // export / import
  document.getElementById('exportBtn').addEventListener('click', exportData);
  document.getElementById('importBtn').addEventListener('click', () =>
    document.getElementById('importFile').click()
  );
  document.getElementById('importFile').addEventListener('change', e => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });

  // re-acquire wake lock on page show
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && app.status === 'running') {
      lockScreen();
      tick(); // sync immediately
    }
  });

  // service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
