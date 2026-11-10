import './index-cmkigcey.js';
import { net, getInviteUrl } from './net.js';

const vf = window.__VOXFIRE__;
if (!vf) {
  throw new Error('VOXFIRE engine failed to initialize.');
}

const {
  game,
  profile,
  saveProfile,
  cfg,
  MAPS,
  WEAPONS,
  CAMOS,
  DIFFICULTIES,
  buildWeaponModel,
  sound,
  THREE,
} = vf;

const MODES = [
  { id: 'ffa', name: 'Free For All', desc: 'Every player for themselves. First to score limit wins.' },
  { id: 'tdm', name: 'Team Deathmatch', desc: 'Blue vs Red squad combat. Coordinate and control the arena.' },
  { id: 'tva', name: '4v4 T vs AT', desc: 'Terrorists vs Anti-Terrorists 4v4 tactical squad battle.' },
  { id: 'gungame', name: 'Gun Game', desc: '16-weapon progression ladder. Knife kills demote enemies.' },
];

const MUTATORS = [
  { key: 'lowGravity', label: 'Low Gravity' },
  { key: 'headshotsOnly', label: 'Headshots Only' },
  { key: 'instagib', label: 'Instagib (Railgun 1-Hit)' },
  { key: 'turbo', label: 'Turbo Speed' },
];

const CROSSHAIR_COLORS = ['#7dff6a', '#00e5ff', '#ff4d6d', '#ffd400', '#ffffff', '#ff7a00'];

const $ = (id) => document.getElementById(id);

function esc(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function xpForLevel(level) {
  return Math.floor(250 * (level - 1) * level);
}

function getLevelInfo(xp) {
  let level = 1;
  while (xp >= xpForLevel(level + 1)) {
    level++;
  }
  const start = xpForLevel(level);
  const next = xpForLevel(level + 1);
  const pct = Math.min(100, Math.max(0, ((xp - start) / (next - start)) * 100));
  return { level, pct, start, next };
}

function uiClick() {
  sound.ensure();
  sound.ui();
}

/* ============================== PLAYER CHIP ============================== */

function renderPlayerChip() {
  const { level, pct } = getLevelInfo(profile.xp);
  $('chip-level').textContent = String(level);
  $('chip-name').textContent = profile.name;
  $('chip-xp').style.width = `${pct.toFixed(1)}%`;
}

/* ============================== TABS ============================== */

let activeTab = 'play';

function switchTab(tabId) {
  activeTab = tabId;
  document.querySelectorAll('.tabs .tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  document.querySelectorAll('.panels .panel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.panel === tabId);
  });
  if (tabId === 'loadout') {
    resizePreview();
    renderWeaponPreview();
  } else if (tabId === 'profile') {
    renderCareer();
  }
}

document.querySelectorAll('.tabs .tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    uiClick();
    switchTab(btn.dataset.tab);
  });
});

/* ============================== PLAY PANEL ============================== */

function renderModes() {
  const host = $('modes');
  host.innerHTML = MODES.map((m) => `
    <button type="button" class="card ${cfg.mode === m.id ? 'active' : ''}" data-mode="${m.id}">
      <strong>${esc(m.name)}</strong>
      <span>${esc(m.desc)}</span>
    </button>
  `).join('');

  host.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (net.role === 'client') return;
      uiClick();
      cfg.mode = btn.dataset.mode;
      if (cfg.mode === 'tva' && cfg.bots === 0) {
        cfg.bots = 7;
        botsInput.value = '7';
        botsVal.textContent = '7';
      }
      renderModes();
      if (net.role === 'host') net.broadcastLobby();
    });
  });
}

function hexCss(num) {
  return '#' + num.toString(16).padStart(6, '0');
}

function renderMaps() {
  const host = $('maps');
  host.innerHTML = MAPS.map((m) => `
    <button type="button" class="card ${cfg.mapId === m.id ? 'active' : ''}" data-map="${m.id}">
      <div class="map-swatch" style="background: linear-gradient(90deg, ${hexCss(m.sky)}, ${hexCss(m.walls[0])}, ${hexCss(m.accent)})"></div>
      <strong>${esc(m.name)}</strong>
      <span>${esc(m.desc)}</span>
    </button>
  `).join('');

  host.querySelectorAll('[data-map]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (net.role === 'client') return;
      uiClick();
      cfg.mapId = btn.dataset.map;
      renderMaps();
      game.loadMap(cfg.mapId);
      if (net.role === 'host') net.broadcastLobby();
    });
  });
}

function renderDiff() {
  const host = $('opt-diff');
  host.innerHTML = Object.entries(DIFFICULTIES).map(([key, d]) => `
    <button type="button" class="${cfg.difficulty === key ? 'active' : ''}" data-diff="${key}">
      ${esc(d.label)}
    </button>
  `).join('');

  host.querySelectorAll('[data-diff]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (net.role === 'client') return;
      uiClick();
      cfg.difficulty = btn.dataset.diff;
      renderDiff();
      if (net.role === 'host') net.broadcastLobby();
    });
  });
}

function renderMutators() {
  const host = $('mutators');
  host.innerHTML = MUTATORS.map((m) => `
    <button type="button" class="mutator-btn ${cfg.mutators[m.key] ? 'active' : ''}" data-mut="${m.key}">
      ${esc(m.label)}
    </button>
  `).join('');

  host.querySelectorAll('[data-mut]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (net.role === 'client') return;
      uiClick();
      const k = btn.dataset.mut;
      cfg.mutators[k] = !cfg.mutators[k];
      renderMutators();
      if (net.role === 'host') net.broadcastLobby();
    });
  });
}

function weaponById(id) {
  return WEAPONS.find((w) => w.id === id) || WEAPONS[0];
}

function renderLoadoutMini() {
  const p = weaponById(profile.loadout.primary);
  const s = weaponById(profile.loadout.secondary);
  const m = weaponById(profile.loadout.melee);
  const c = CAMOS.find((x) => x.id === profile.camo) || CAMOS[0];
  const host = $('loadout-mini');
  host.innerHTML = `
    <div class="lm-pill"><b>1</b>${esc(p.name)}</div>
    <div class="lm-pill"><b>2</b>${esc(s.name)}</div>
    <div class="lm-pill"><b>3</b>${esc(m.name)}</div>
    <div class="lm-pill"><b>Camo</b>${esc(c.name)}</div>
  `;
}

$('loadout-mini').addEventListener('click', () => {
  uiClick();
  switchTab('loadout');
});

const botsInput = $('opt-bots');
const botsVal = $('bots-val');
botsInput.value = String(cfg.bots);
botsVal.textContent = String(cfg.bots);
botsInput.addEventListener('input', () => {
  if (net.role === 'client') return;
  cfg.bots = Number(botsInput.value);
  botsVal.textContent = String(cfg.bots);
  if (net.role === 'host') net.broadcastLobby();
});

const scoreSel = $('opt-score');
scoreSel.value = String(cfg.scoreLimit);
scoreSel.addEventListener('change', () => {
  if (net.role === 'client') return;
  uiClick();
  cfg.scoreLimit = Number(scoreSel.value);
  if (net.role === 'host') net.broadcastLobby();
});

const timeSel = $('opt-time');
timeSel.value = String(cfg.timeLimit);
timeSel.addEventListener('change', () => {
  if (net.role === 'client') return;
  uiClick();
  cfg.timeLimit = Number(timeSel.value);
  if (net.role === 'host') net.broadcastLobby();
});

/* ============================== LOADOUT & 3D PREVIEW ============================== */

let activeSlot = 'primary';
let previewState = null;

function ensurePreview() {
  if (previewState) return previewState;
  const canvas = $('preview');
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, canvas.clientWidth / Math.max(1, canvas.clientHeight), 0.05, 20);
  camera.position.set(0, 0.12, 1.35);

  const hemi = new THREE.HemisphereLight(0xdcebff, 0x222a38, 1.8);
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(1.5, 2.2, 2);
  const rim = new THREE.DirectionalLight(0x4cd4ff, 0.8);
  rim.position.set(-2, 0.6, -1.5);
  scene.add(hemi, sun, rim);

  previewState = { canvas, renderer, scene, camera, modelGroup: null, angle: 0.45 };

  const animate = () => {
    requestAnimationFrame(animate);
    if (activeTab !== 'loadout' || game.state !== 'menu') return;
    if (previewState.modelGroup) {
      previewState.angle += 0.012;
      previewState.modelGroup.rotation.y = previewState.angle;
      previewState.modelGroup.rotation.x = Math.sin(previewState.angle * 0.7) * 0.08;
    }
    renderer.render(scene, camera);
  };
  requestAnimationFrame(animate);
  return previewState;
}

function resizePreview() {
  const st = ensurePreview();
  const w = Math.max(260, st.canvas.clientWidth);
  const h = Math.max(140, st.canvas.clientHeight);
  st.renderer.setSize(w, h, false);
  st.camera.aspect = w / h;
  st.camera.updateProjectionMatrix();
}

function renderWeaponPreview() {
  const st = ensurePreview();
  resizePreview();
  if (st.modelGroup) {
    st.scene.remove(st.modelGroup);
    st.modelGroup.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => m.dispose());
      }
    });
  }
  const w = weaponById(profile.loadout[activeSlot]);
  const camo = CAMOS.find((c) => c.id === profile.camo);
  const built = buildWeaponModel(w, camo, 1.55);
  built.group.rotation.y = st.angle;
  st.modelGroup = built.group;
  st.scene.add(built.group);
  st.renderer.render(st.scene, st.camera);
}

function statBar(label, valueText, pct) {
  const clamped = Math.max(4, Math.min(100, Math.round(pct)));
  return `
    <div class="stat-row">
      <div><span>${esc(label)}</span><b>${esc(valueText)}</b></div>
      <div class="stat-bar"><i style="width:${clamped}%"></i></div>
    </div>
  `;
}

function renderWeaponDetail() {
  const w = weaponById(profile.loadout[activeSlot]);
  $('wd-name').textContent = w.name;
  $('wd-tag').textContent = w.tag;
  $('wd-desc').textContent = w.desc;

  const dmgVal = w.projectile
    ? (w.projectile.directDamage + w.projectile.splashDamage)
    : (w.damage * w.pellets);
  const dmgLabel = w.projectile && w.projectile.splashDamage
    ? `${w.projectile.directDamage} + ${w.projectile.splashDamage} splash`
    : w.pellets > 1
      ? `${w.damage} × ${w.pellets}`
      : String(w.damage);

  const accuracyScore = w.kind === 'melee'
    ? 100
    : Math.max(8, 100 - (w.adsSpread * 1100));

  $('wd-stats').innerHTML = [
    statBar('Damage', dmgLabel, (dmgVal / 155) * 100),
    statBar('Fire Rate', `${w.rpm} RPM`, Math.min(100, (w.rpm / 1200) * 100)),
    statBar('Range', `${w.range} m`, Math.min(100, (w.range / 220) * 100)),
    statBar('Accuracy', w.kind === 'melee' ? 'Melee' : `${Math.round(accuracyScore)}%`, accuracyScore),
    statBar('Mobility', `${Math.round(w.speed * 100)}%`, ((w.speed - 0.6) / 0.6) * 100),
    statBar('Headshot', `${w.headMult}×`, (w.headMult / 2.2) * 100),
  ].join('');

  const meta = [];
  if (w.kind !== 'melee') {
    meta.push(`Mag: ${w.mag} / ${w.reserve}`);
    meta.push(`Reload: ${w.reload}s`);
  }
  meta.push(`Fire: ${w.trigger.toUpperCase()}`);
  if (w.pierce) meta.push('Piercing Beam');
  if (w.spinup) meta.push(`Spin-up: ${w.spinup}s`);
  if (w.scope && w.scopeZooms) {
    meta.push(`Scope: ${w.scopeZooms.map((z) => `${z}×`).join(' / ')}`);
  } else if (w.scope) {
    meta.push('Sniper Scope');
  }
  if (w.projectile) meta.push(`Projectile (${w.projectile.speed} m/s)`);

  $('wd-meta').innerHTML = meta.map((t) => `<span>${esc(t)}</span>`).join('');
  renderWeaponPreview();
}

function renderWeaponList() {
  const list = $('weapon-list');
  const weapons = WEAPONS.filter((w) => w.slot === activeSlot);
  const equippedId = profile.loadout[activeSlot];

  list.innerHTML = weapons.map((w) => `
    <button type="button" class="weapon-item ${w.id === equippedId ? 'active' : ''}" data-wid="${w.id}">
      <div>
        <div class="wi-name">${esc(w.name)}</div>
        <div class="wi-tag">${esc(w.tag)}</div>
      </div>
      ${w.id === equippedId ? '<span class="wi-eq">Equipped</span>' : ''}
    </button>
  `).join('');

  list.querySelectorAll('[data-wid]').forEach((btn) => {
    btn.addEventListener('click', () => {
      uiClick();
      profile.loadout[activeSlot] = btn.dataset.wid;
      saveProfile();
      renderWeaponList();
      renderWeaponDetail();
      renderLoadoutMini();
      net.sendClientProfile();
    });
  });
}

function renderCamos() {
  const host = $('camos');
  host.innerHTML = CAMOS.map((c) => {
    const unlocked = profile.kills >= c.unlock;
    const dotColor = c.color !== undefined ? hexCss(c.color) : '#606c7d';
    const sub = unlocked
      ? (profile.camo === c.id ? 'Equipped' : 'Unlocked')
      : `${profile.kills}/${c.unlock} kills`;
    return `
      <button type="button" class="camo-btn ${profile.camo === c.id ? 'active' : ''} ${unlocked ? '' : 'locked'}" data-camo="${c.id}" ${unlocked ? '' : 'disabled'}>
        <span class="camo-dot" style="background:${dotColor}"></span>
        <div>
          <strong>${esc(c.name)}</strong>
          <small>${esc(sub)}</small>
        </div>
      </button>
    `;
  }).join('');

  host.querySelectorAll('[data-camo]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const c = CAMOS.find((x) => x.id === btn.dataset.camo);
      if (!c || profile.kills < c.unlock) return;
      uiClick();
      profile.camo = c.id;
      saveProfile();
      renderCamos();
      renderWeaponPreview();
      renderLoadoutMini();
      net.sendClientProfile();
    });
  });
}

document.querySelectorAll('#slot-tabs button[data-slot]').forEach((btn) => {
  btn.addEventListener('click', () => {
    uiClick();
    activeSlot = btn.dataset.slot;
    document.querySelectorAll('#slot-tabs button[data-slot]').forEach((b) => {
      b.classList.toggle('active', b.dataset.slot === activeSlot);
    });
    renderWeaponList();
    renderWeaponDetail();
  });
});

/* ============================== PROFILE PANEL ============================== */

const nameInput = $('name-input');
nameInput.value = profile.name;
nameInput.addEventListener('input', () => {
  const val = nameInput.value.trim();
  if (val) {
    profile.name = val.slice(0, 16);
    renderPlayerChip();
    saveProfile();
    net.sendClientProfile();
  }
});
nameInput.addEventListener('blur', () => {
  if (!nameInput.value.trim()) {
    nameInput.value = profile.name;
  }
});

function renderCareer() {
  const { level } = getLevelInfo(profile.xp);
  const kd = (profile.kills / Math.max(1, profile.deaths)).toFixed(2);
  const hsPct = profile.kills > 0 ? Math.round((profile.headshots / profile.kills) * 100) : 0;
  const winPct = profile.matches > 0 ? Math.round((profile.wins / profile.matches) * 100) : 0;

  const cards = [
    ['Level', String(level)],
    ['Total XP', profile.xp.toLocaleString()],
    ['Kills', String(profile.kills)],
    ['Deaths', String(profile.deaths)],
    ['K/D Ratio', kd],
    ['Headshots', `${profile.headshots} (${hsPct}%)`],
    ['Wins / Matches', `${profile.wins} / ${profile.matches} (${winPct}%)`],
    ['Best Streak', String(profile.bestStreak)],
  ];

  $('career').innerHTML = cards.map(([k, v]) => `
    <div class="career-card">
      <span>${esc(k)}</span>
      <b>${esc(v)}</b>
    </div>
  `).join('');
}

/* ============================== SETTINGS PANEL ============================== */

function bindRangeSetting(inputId, labelId, key, format = (v) => String(v)) {
  const input = $(inputId);
  const label = $(labelId);
  input.value = String(profile.settings[key]);
  label.textContent = format(profile.settings[key]);
  input.addEventListener('input', () => {
    const val = parseFloat(input.value);
    profile.settings[key] = val;
    label.textContent = format(val);
    saveProfile();
    game.applySettings();
  });
}

bindRangeSetting('s-sens', 'v-sens', 'sens', (v) => v.toFixed(2));
bindRangeSetting('s-ads', 'v-ads', 'adsSens', (v) => v.toFixed(2));
bindRangeSetting('s-fov', 'v-fov', 'fov', (v) => `${Math.round(v)}°`);
bindRangeSetting('s-vol', 'v-vol', 'volume', (v) => `${Math.round(v * 100)}%`);

function renderCrosshairSwatches() {
  const host = $('s-xhair');
  host.innerHTML = CROSSHAIR_COLORS.map((col) => `
    <button type="button" class="swatch ${profile.settings.crosshair === col ? 'active' : ''}"
      style="background:${col}" data-xh="${col}" aria-label="Crosshair color ${col}"></button>
  `).join('');

  host.querySelectorAll('[data-xh]').forEach((btn) => {
    btn.addEventListener('click', () => {
      uiClick();
      profile.settings.crosshair = btn.dataset.xh;
      saveProfile();
      game.applySettings();
      renderCrosshairSwatches();
    });
  });
}

function renderQualityButtons() {
  document.querySelectorAll('#s-quality button[data-v]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.v === profile.settings.quality);
  });
}

document.querySelectorAll('#s-quality button[data-v]').forEach((btn) => {
  btn.addEventListener('click', () => {
    uiClick();
    profile.settings.quality = btn.dataset.v;
    saveProfile();
    game.applySettings();
    renderQualityButtons();
  });
});

const fpsCheck = $('s-fps');
fpsCheck.checked = Boolean(profile.settings.showFps);
fpsCheck.addEventListener('change', () => {
  profile.settings.showFps = fpsCheck.checked;
  saveProfile();
  game.applySettings();
});

const invertCheck = $('s-invert');
invertCheck.checked = Boolean(profile.settings.invertY);
invertCheck.addEventListener('change', () => {
  profile.settings.invertY = invertCheck.checked;
  saveProfile();
  game.applySettings();
});

/* ============================== END OF MATCH ============================== */

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function renderEndBoard(rows, teams, mode = 'tdm') {
  const head = '<tr><th>#</th><th>Player</th><th>K</th><th>D</th><th>A</th><th>Score</th></tr>';
  const makeRows = (list) => list.map((l, idx) => `
    <tr class="${l.isPlayer ? 'me' : ''}">
      <td>${idx + 1}</td>
      <td>${esc(l.name)}${l.extra ? ` <small>${esc(l.extra)}</small>` : ''}</td>
      <td>${l.kills}</td>
      <td>${l.deaths}</td>
      <td>${l.assists}</td>
      <td>${l.score}</td>
    </tr>
  `).join('');

  const host = $('end-board');
  if (teams) {
    const names = mode === 'tva' ? ['ANTI-TERRORISTS', 'TERRORISTS'] : ['BLUE', 'RED'];
    host.innerHTML = `<div class="sb-teams">${[0, 1].map((t) => `
      <table class="team${t}">
        <caption>${names[t]}</caption>
        ${head}${makeRows(rows.filter((r) => r.team === t))}
      </table>
    `).join('')}</div>`;
  } else {
    host.innerHTML = `<table>${head}${makeRows(rows)}</table>`;
  }
}

game.onEnd = (res) => {
  const prevKills = profile.kills;
  profile.xp += res.xp;
  profile.kills += res.kills;
  profile.deaths += res.deaths;
  profile.headshots += res.headshots;
  profile.bestStreak = Math.max(profile.bestStreak, res.bestStreak);
  profile.matches++;
  if (res.won) profile.wins++;
  saveProfile();

  const { level, pct } = getLevelInfo(profile.xp);
  $('end-title').textContent = res.title;
  $('end-place').textContent = res.teams
    ? (res.won ? 'Your squad won the match!' : 'Better luck next deployment.')
    : `Finished ${ordinal(res.place)} of ${res.total}`;

  $('end-stats').innerHTML = [
    ['Kills', res.kills],
    ['Deaths', res.deaths],
    ['Assists', res.assists],
    ['Headshots', res.headshots],
    ['Best Streak', res.bestStreak],
  ].map(([k, v]) => `<div class="end-stat"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');

  $('end-level').textContent = `Level ${level}`;
  $('end-xpgain').textContent = `+${res.xp} XP`;
  $('end-xpbar').style.width = `${pct.toFixed(1)}%`;

  const newlyUnlocked = CAMOS.filter((c) => prevKills < c.unlock && profile.kills >= c.unlock);
  const nextLocked = CAMOS.find((c) => profile.kills < c.unlock);
  $('end-unlock').textContent = newlyUnlocked.length
    ? `Unlocked Camo: ${newlyUnlocked.map((c) => c.name).join(', ')}!`
    : nextLocked
      ? `Next Camo (${nextLocked.name}): ${profile.kills} / ${nextLocked.unlock} kills`
      : 'All camos unlocked!';

  renderEndBoard(res.rows, res.teams, res.mode);
  renderPlayerChip();
  renderCareer();
  renderCamos();
  $('btn-again').style.display = net.role === 'client' ? 'none' : '';
  $('end').classList.remove('hidden');
};

/* ============================== FRIENDS / ROOM LOBBY ============================== */

function flashCopyBtn(btn, label) {
  const prev = btn.textContent;
  btn.textContent = label;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = prev;
    btn.disabled = false;
  }, 1500);
}

async function copyText(text, btn, label = 'Copied!') {
  try {
    await navigator.clipboard.writeText(text);
    flashCopyBtn(btn, label);
  } catch {
    const tmp = document.createElement('textarea');
    tmp.value = text;
    document.body.appendChild(tmp);
    tmp.select();
    document.execCommand('copy');
    tmp.remove();
    flashCopyBtn(btn, label);
  }
}

$('btn-host').addEventListener('click', () => {
  uiClick();
  net.hostRoom();
});

$('btn-host-tva').addEventListener('click', () => {
  uiClick();
  net.hostRoom('tva');
});

function submitJoin() {
  const input = $('room-join-input');
  uiClick();
  net.joinRoom(input.value);
}

$('btn-join').addEventListener('click', submitJoin);
$('room-join-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitJoin();
  }
});

$('btn-copy-code').addEventListener('click', () => {
  if (!net.roomCode) return;
  uiClick();
  copyText(net.roomCode, $('btn-copy-code'));
});

$('btn-copy-link').addEventListener('click', () => {
  if (!net.roomCode) return;
  uiClick();
  copyText(getInviteUrl(net.roomCode), $('btn-copy-link'));
});

$('btn-pause-copy').addEventListener('click', () => {
  if (!net.roomCode) return;
  uiClick();
  copyText(getInviteUrl(net.roomCode), $('btn-pause-copy'));
});

$('btn-leave-room').addEventListener('click', () => {
  uiClick();
  net.leaveRoom();
});

const origQuit = $('btn-quit').onclick;
$('btn-quit').onclick = () => {
  if (net.role === 'client') {
    net.leaveRoom();
    return;
  }
  if (origQuit) origQuit();
};

function renderRoomState(st) {
  const inRoom = st.role !== 'solo';
  $('friends-idle').classList.toggle('hidden', inRoom);
  $('room-lobby').classList.toggle('hidden', !inRoom);
  $('pause-room').classList.toggle('hidden', !inRoom);
  if (inRoom) {
    $('room-code').textContent = st.roomCode;
    $('pause-room-code').textContent = st.roomCode;
  }

  const statusEl = $('room-status');
  statusEl.textContent = st.error || st.status || '';
  statusEl.classList.toggle('err', Boolean(st.error));

  const membersEl = $('room-members');
  const isTeam = cfg.mode === 'tdm' || cfg.mode === 'tva';
  const teamTag = (team) => (cfg.mode === 'tva' ? (team === 0 ? 'AT' : 'T') : (team === 0 ? 'BLUE' : 'RED'));
  membersEl.innerHTML = (st.members || []).map((m) => `
    <button type="button" class="member-pill ${m.isHost ? 'host' : ''} ${isTeam ? `team${m.team}` : ''}"
      data-mid="${m.id}" ${st.role === 'host' && isTeam ? 'title="Click to swap team"' : ''}>
      ${isTeam ? `<em>${teamTag(m.team)}</em>` : ''}
      <span>${esc(m.name)}</span>
      ${m.isHost ? '<small>HOST</small>' : ''}
    </button>
  `).join('');

  if (st.role === 'host' && isTeam) {
    membersEl.querySelectorAll('[data-mid]').forEach((btn) => {
      btn.addEventListener('click', () => {
        uiClick();
        net.swapMemberTeam(Number(btn.dataset.mid));
      });
    });
  }

  const isClient = st.role === 'client';
  botsInput.value = String(cfg.bots);
  botsVal.textContent = String(cfg.bots);
  scoreSel.value = String(cfg.scoreLimit);
  timeSel.value = String(cfg.timeLimit);
  botsInput.disabled = isClient;
  scoreSel.disabled = isClient;
  timeSel.disabled = isClient;

  $('modes').classList.toggle('play-locked', isClient);
  $('maps').classList.toggle('play-locked', isClient);
  $('opt-diff').classList.toggle('play-locked', isClient);
  $('mutators').classList.toggle('play-locked', isClient);

  const deployBtn = $('deploy');
  deployBtn.disabled = isClient;
  deployBtn.innerHTML = isClient ? 'Waiting for Host…' : 'Deploy <span>▶</span>';
  $('btn-restart').style.display = isClient ? 'none' : '';
  $('btn-quit').textContent = isClient ? 'Leave Match' : 'Quit to Menu';

  renderModes();
  renderMaps();
  renderDiff();
  renderMutators();
}

net.onChange(renderRoomState);

window.addEventListener('resize', () => {
  if (activeTab === 'loadout' && previewState) {
    resizePreview();
  }
});

/* ============================== INIT ============================== */

renderPlayerChip();
renderModes();
renderMaps();
renderDiff();
renderMutators();
renderLoadoutMini();
renderWeaponList();
renderWeaponDetail();
renderCamos();
renderCareer();
renderCrosshairSwatches();
renderQualityButtons();
renderRoomState(net.getState());

const urlRoom = new URLSearchParams(window.location.search).get('room');
if (urlRoom) {
  $('room-join-input').value = urlRoom;
  net.joinRoom(urlRoom);
}
