const vf = window.__VOXFIRE__;
if (!vf) {
  throw new Error('VOXFIRE engine must load before net.js');
}

const {
  game,
  profile,
  cfg,
  MAPS,
  WEAPONS,
  findWeapon,
  sound,
  Player,
  BotModel,
  GG_ORDER,
  TEAM_HEX,
  TEAM_COLORS,
  FFA_COLORS,
  RESPAWN_TIME,
  weaponLabel,
  FRAG_SPEC,
  THREE,
} = vf;

const PEER_PREFIX = 'voxfire-room-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
};

const isTeamMode = (mode) => mode === 'tdm' || mode === 'tva';
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;
const r4 = (n) => Math.round(n * 10000) / 10000;

export function parseRoomCode(raw) {
  if (!raw) return '';
  const text = String(raw).trim();
  const match = text.match(/[?&]room=([A-Za-z0-9_-]+)/i);
  const candidate = match ? match[1] : text;
  return candidate.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
}

export function getInviteUrl(code) {
  const url = new URL(window.location.href);
  url.searchParams.set('room', code);
  return url.toString();
}

function randomCode(len = 6) {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return out;
}

function angleDelta(from, to) {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function makeProjMesh(kind) {
  if (kind === 'rocket') {
    const g = new THREE.Group();
    const body = new THREE.Mesh(game.sharedGeo.rocket, new THREE.MeshLambertMaterial({ color: 5597999 }));
    body.rotation.x = Math.PI / 2;
    const tip = new THREE.Mesh(game.sharedGeo.nade, new THREE.MeshBasicMaterial({ color: 16755251 }));
    tip.position.z = 0.28;
    g.add(body, tip);
    return g;
  }
  if (kind === 'bolt') {
    return new THREE.Mesh(game.sharedGeo.bolt, new THREE.MeshBasicMaterial({ color: 16115396 }));
  }
  if (kind === 'plasma') {
    return new THREE.Mesh(game.sharedGeo.orb, new THREE.MeshBasicMaterial({ color: 13798399 }));
  }
  return new THREE.Mesh(game.sharedGeo.nade, new THREE.MeshLambertMaterial({ color: 4020778 }));
}

const PROJ_KINDS = ['rocket', 'bolt', 'plasma', 'grenade'];

class RoomNet {
  constructor() {
    this.peer = null;
    this.role = 'solo'; // 'solo' | 'host' | 'client'
    this.roomCode = '';
    this.status = '';
    this.error = '';
    this.hostTeam = 0;
    this.myId = 0;
    this.nextId = 100;
    this.peers = new Map(); // host: peerId -> member record
    this.hostConn = null;   // client -> host DataConnection
    this.members = [];      // synced lobby list
    this.snapAcc = 0;
    this.clientAcc = 0;
    this.bgTimer = null;
    this.clientProjectiles = [];
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this.getState());
  }

  getState() {
    return {
      role: this.role,
      roomCode: this.roomCode,
      status: this.status,
      error: this.error,
      members: this.members,
      inviteUrl: this.roomCode ? getInviteUrl(this.roomCode) : '',
    };
  }

  setStatus(status, error = '') {
    this.status = status;
    this.error = error;
    this.emit();
  }

  cleanupClientProjectiles() {
    for (const p of this.clientProjectiles) {
      game.scene.remove(p.mesh);
    }
    this.clientProjectiles = [];
  }

  destroyPeer() {
    if (this.bgTimer) {
      clearInterval(this.bgTimer);
      this.bgTimer = null;
    }
    this.cleanupClientProjectiles();
    for (const rec of this.peers.values()) {
      try { rec.conn.close(); } catch {}
    }
    this.peers.clear();
    if (this.hostConn) {
      try { this.hostConn.close(); } catch {}
      this.hostConn = null;
    }
    if (this.peer) {
      try { this.peer.destroy(); } catch {}
      this.peer = null;
    }
  }

  leaveRoom(silent = false) {
    const wasPlaying = game.state === 'playing' || game.state === 'paused';
    this.destroyPeer();
    this.role = 'solo';
    this.roomCode = '';
    this.members = [];
    this.hostTeam = 0;
    this.myId = 0;
    game.netMode = 'solo';
    if (wasPlaying) {
      document.getElementById('pause').classList.add('hidden');
      document.getElementById('end').classList.add('hidden');
      document.getElementById('menu').style.display = '';
      game.quit();
    }
    const url = new URL(window.location.href);
    if (url.searchParams.has('room')) {
      url.searchParams.delete('room');
      window.history.replaceState({}, '', url.toString());
    }
    if (!silent) {
      this.setStatus('', '');
    } else {
      this.emit();
    }
  }

  /* ============================== HOST ============================== */

  startBgLoop() {
    if (this.bgTimer) clearInterval(this.bgTimer);
    let last = performance.now();
    this.bgTimer = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
      last = now;
      if (
        this.role === 'host'
        && document.hidden
        && (game.state === 'playing' || game.state === 'paused')
      ) {
        game.update(dt);
      }
    }, 50);
  }

  hostRoom(presetMode = null) {
    if (!window.Peer) {
      this.setStatus('', 'Multiplayer library failed to load. Check internet connection.');
      return;
    }
    this.leaveRoom(true);
    const code = randomCode(6);
    this.role = 'host';
    this.roomCode = code;
    this.myId = 0;
    this.nextId = 100;
    this.hostTeam = 0;
    game.netMode = 'host';
    if (presetMode === 'tva') {
      cfg.mode = 'tva';
      cfg.bots = 7;
      cfg.scoreLimit = 25;
    } else {
      if (presetMode) cfg.mode = presetMode;
      if (cfg.bots === 7) {
        cfg.bots = 0; // default pure PvP with friends (host can raise slider anytime)
      }
    }
    this.startBgLoop();
    this.setStatus(`Creating room ${code}...`);

    const peer = new window.Peer(PEER_PREFIX + code, { debug: 1, config: ICE_CONFIG });
    this.peer = peer;

    peer.on('open', () => {
      if (this.peer !== peer) return;
      this.updateMembers();
      this.setStatus(`Room ${code} live — share code or invite link`);
    });

    peer.on('connection', (conn) => {
      if (this.peer !== peer) return;
      this.bindHostConnection(conn);
    });

    peer.on('error', (err) => {
      if (this.peer !== peer) return;
      if (err.type === 'unavailable-id') {
        this.hostRoom();
        return;
      }
      this.setStatus('', `Room error: ${err.message || err.type || 'connection failed'}`);
    });

    peer.on('disconnected', () => {
      if (this.peer === peer && !peer.destroyed) {
        try { peer.reconnect(); } catch {}
      }
    });
  }

  bindHostConnection(conn) {
    conn.on('open', () => {
      // Wait for 'join' message with friend profile
    });

    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'join') {
        this.handleFriendJoin(conn, msg);
      } else if (msg.t === 'profile') {
        const rec = this.peers.get(conn.peer);
        if (!rec) return;
        rec.name = String(msg.name || 'Player').slice(0, 16);
        rec.loadout = msg.loadout || rec.loadout;
        rec.camo = msg.camo || rec.camo;
        if (rec.char) {
          rec.char.name = rec.name;
          rec.char.loadout = [rec.loadout.primary, rec.loadout.secondary, rec.loadout.melee];
        }
        this.updateMembers();
        this.broadcastLobby();
      } else if (msg.t === 'cs') {
        const rec = this.peers.get(conn.peer);
        if (rec && rec.char) this.applyClientState(rec.char, msg);
      } else if (msg.t === 'shoot') {
        const rec = this.peers.get(conn.peer);
        if (rec && rec.char) this.handleClientShoot(rec, msg);
      } else if (msg.t === 'nade') {
        const rec = this.peers.get(conn.peer);
        if (rec && rec.char) this.handleClientGrenade(rec, msg);
      }
    });

    const onDrop = () => {
      const rec = this.peers.get(conn.peer);
      if (!rec) return;
      this.peers.delete(conn.peer);
      if (rec.char) {
        if (rec.char.model) {
          game.scene.remove(rec.char.model.root);
          rec.char.model.dispose();
        }
        const idx = game.chars.indexOf(rec.char);
        if (idx >= 0) game.chars.splice(idx, 1);
        this.broadcast({ t: 'left', id: rec.id, name: rec.name });
      }
      this.updateMembers();
      this.broadcastLobby();
    };

    conn.on('close', onDrop);
    conn.on('error', onDrop);
  }

  handleFriendJoin(conn, msg) {
    if (this.peers.has(conn.peer)) return;
    const id = this.nextId++;
    const blueCount = (this.hostTeam === 0 ? 1 : 0) + [...this.peers.values()].filter((p) => p.team === 0).length;
    const redCount = (this.hostTeam === 1 ? 1 : 0) + [...this.peers.values()].filter((p) => p.team === 1).length;
    const team = blueCount <= redCount ? 0 : 1;
    const color = FFA_COLORS[id % FFA_COLORS.length];
    const rec = {
      peerId: conn.peer,
      conn,
      id,
      name: String(msg.name || `Player${id}`).slice(0, 16),
      team,
      color,
      loadout: msg.loadout || { primary: 'ak', secondary: 'p9', melee: 'knife' },
      camo: msg.camo || 'default',
      char: null,
    };
    this.peers.set(conn.peer, rec);
    this.updateMembers();

    const inMatch = game.state === 'playing' || game.state === 'paused';
    conn.send({
      t: 'welcome',
      code: this.roomCode,
      yourId: id,
      yourTeam: team,
      cfg: this.serializeCfg(),
      members: this.members,
      inMatch,
    });

    if (inMatch) {
      const char = this.createRemoteChar(rec);
      game.chars.push(char);
      game.spawn(char);
      this.broadcast({ t: 'joinLive', char: this.serializeInitChar(char) }, conn.peer);
      conn.send({
        t: 'start',
        cfg: this.serializeCfg(),
        matchTime: game.matchTime,
        teamScore: game.teamScore,
        chars: game.chars.map((c) => this.serializeInitChar(c)),
      });
    }

    this.broadcastLobby(conn.peer);
  }

  createRemoteChar(rec) {
    const isTdm = isTeamMode(cfg.mode);
    const team = isTdm ? rec.team : rec.id;
    const col = isTdm ? TEAM_COLORS[rec.team] : rec.color;
    const c = new Player(rec.id, rec.name, team, false, col);
    c.isRemote = true;
    c.peerId = rec.peerId;
    c.loadout = [rec.loadout.primary, rec.loadout.secondary, rec.loadout.melee];
    c.model = new BotModel(col, c.name, isTdm && team === game.player.team);
    game.scene.add(c.model.root);
    rec.char = c;
    return c;
  }

  serializeCfg() {
    return {
      mode: cfg.mode,
      mapId: cfg.mapId,
      bots: cfg.bots,
      difficulty: cfg.difficulty,
      scoreLimit: cfg.scoreLimit,
      timeLimit: cfg.timeLimit,
      mutators: { ...cfg.mutators },
    };
  }

  serializeInitChar(c) {
    return {
      id: c.id,
      name: c.name,
      team: c.team,
      color: c.color,
      x: r2(c.pos.x),
      y: r2(c.pos.y),
      z: r2(c.pos.z),
      yaw: r3(c.yaw),
      ggLevel: c.ggLevel,
      weaponId: c.weapon?.def?.id || 'ak',
    };
  }

  updateMembers() {
    if (this.role !== 'host') return;
    const list = [
      { id: 0, name: profile.name, team: this.hostTeam, isHost: true },
      ...[...this.peers.values()].map((p) => ({
        id: p.id,
        name: p.name,
        team: p.team,
        isHost: false,
      })),
    ];
    this.members = list;
    this.emit();
  }

  swapMemberTeam(memberId) {
    if (this.role !== 'host' || !isTeamMode(cfg.mode)) return;
    if (memberId === 0) {
      this.hostTeam = 1 - this.hostTeam;
    } else {
      for (const p of this.peers.values()) {
        if (p.id === memberId) {
          p.team = 1 - p.team;
          break;
        }
      }
    }
    this.updateMembers();
    this.broadcastLobby();
  }

  broadcast(msg, excludePeerId = null) {
    for (const p of this.peers.values()) {
      if (p.peerId === excludePeerId) continue;
      if (p.conn.open) {
        try { p.conn.send(msg); } catch {}
      }
    }
  }

  broadcastLobby(excludePeerId = null) {
    if (this.role !== 'host') return;
    this.updateMembers();
    this.broadcast({
      t: 'lobby',
      cfg: this.serializeCfg(),
      members: this.members,
    }, excludePeerId);
  }

  populateHostMatch() {
    if (this.role !== 'host') return;
    if (isTeamMode(cfg.mode) && game.player) {
      game.player.team = this.hostTeam;
      game.player.color = TEAM_COLORS[this.hostTeam];
    }
    for (const rec of this.peers.values()) {
      const char = this.createRemoteChar(rec);
      game.chars.push(char);
    }
  }

  onHostMatchStart() {
    if (this.role !== 'host') return;
    this.snapAcc = 0;
    this.broadcast({
      t: 'start',
      cfg: this.serializeCfg(),
      matchTime: game.matchTime,
      teamScore: game.teamScore,
      chars: game.chars.map((c) => this.serializeInitChar(c)),
    });
  }

  onHostSpawn(char) {
    if (this.role !== 'host') return;
    this.broadcast({
      t: 'spawn',
      id: char.id,
      x: r2(char.pos.x),
      y: r2(char.pos.y),
      z: r2(char.pos.z),
      yaw: r3(char.yaw),
      weapons: char.weapons.map((w) => w.def.id),
    });
  }

  onRemoteHurt(targetChar, dmg, fromPos) {
    const rec = this.peers.get(targetChar.peerId);
    if (!rec || !rec.conn.open) return;
    rec.conn.send({
      t: 'hurt',
      dmg,
      fx: r2(fromPos.x),
      fz: r2(fromPos.z),
      hp: Math.max(0, targetChar.health),
    });
  }

  onRemoteHit(attackerChar, head, isKill) {
    const rec = this.peers.get(attackerChar.peerId);
    if (!rec || !rec.conn.open) return;
    rec.conn.send({
      t: 'hit',
      h: head ? 1 : 0,
      k: isKill ? 1 : 0,
    });
  }

  onRemotePickup(char, kind) {
    const rec = this.peers.get(char.peerId);
    if (!rec || !rec.conn.open) return;
    rec.conn.send({ t: 'pickup', k: kind });
  }

  onRemoteStreak(char, streakName) {
    const rec = this.peers.get(char.peerId);
    if (!rec || !rec.conn.open) return;
    rec.conn.send({ t: 'streak', s: streakName });
  }

  onHostKill(victim, killer, weaponId, head, weaponName, killerCol, victimCol) {
    if (this.role !== 'host') return;
    this.broadcast({
      t: 'kill',
      kid: killer.id,
      vid: victim.id,
      kn: killer.name,
      vn: victim.name,
      wn: weaponName,
      wid: weaponId,
      hd: head ? 1 : 0,
      kc: killerCol,
      vc: victimCol,
      khp: Math.ceil(killer.health),
      ks: killer.streak,
      vr: victim.respawn,
      kgg: killer.ggLevel,
      vgg: victim.ggLevel,
      ts: [...game.teamScore],
    });
  }

  onHostShot(char, def, muzzle, pts) {
    if (this.role !== 'host') return;
    this.broadcast({
      t: 'fx',
      k: 'shot',
      id: char.id,
      w: def.id,
      mx: r2(muzzle.x),
      my: r2(muzzle.y),
      mz: r2(muzzle.z),
      pts: pts.map((p) => p.map(r2)),
    }, char.peerId || null);
  }

  onHostBoom(pos, radius, isPlasma) {
    if (this.role !== 'host') return;
    this.broadcast({
      t: 'fx',
      k: 'boom',
      x: r2(pos.x),
      y: r2(pos.y),
      z: r2(pos.z),
      r: r2(radius),
      pl: isPlasma ? 1 : 0,
    });
  }

  onHostEnd(summary) {
    if (this.role !== 'host') return;
    const rows = [...game.chars]
      .sort((a, b) => (cfg.mode === 'gungame'
        ? (b.ggLevel - a.ggLevel || b.kills - a.kills)
        : (b.score - a.score || b.kills - a.kills)))
      .map((c) => ({
        id: c.id,
        name: c.name,
        kills: c.kills,
        deaths: c.deaths,
        assists: c.assists,
        headshots: c.headshots,
        bestStreak: c.bestStreak,
        score: c.score,
        team: c.team,
        alive: c.alive,
        extra: cfg.mode === 'gungame'
          ? `Lv ${Math.min(c.ggLevel + 1, GG_ORDER.length)} · ${findWeapon(GG_ORDER[Math.min(c.ggLevel, GG_ORDER.length - 1)]).name}`
          : undefined,
      }));
    this.broadcast({
      t: 'end',
      title: summary.title,
      rows,
      teams: summary.teams,
      teamScore: [...game.teamScore],
      cfg: this.serializeCfg(),
    });
  }

  applyClientState(c, msg) {
    if (!c.alive) return;
    c.pos.set(msg.x, msg.y, msg.z);
    c.vel.set(msg.vx || 0, msg.vy || 0, msg.vz || 0);
    c.yaw = msg.yaw;
    c.pitch = msg.pitch;
    c.crouch = Boolean(msg.cr);
    c.height = c.crouch ? 1.25 : 1.8;
    c.slide = msg.sl ? 0.4 : 0;
    c.input.ads = Boolean(msg.ad);
    c.input.sprint = Boolean(msg.sp);
    if (typeof msg.wi === 'number' && msg.wi !== c.current && msg.wi >= 0 && msg.wi < c.weapons.length) {
      game.switchWeapon(c, msg.wi);
    }
  }

  handleClientShoot(rec, msg) {
    const c = rec.char;
    if (!c.alive || (game.state !== 'playing' && game.state !== 'paused')) return;
    const def = findWeapon(msg.w);
    if (!def) return;

    c.lastFired = game.time;
    const eye = c.eye(new THREE.Vector3());
    const origin = new THREE.Vector3(msg.ox, msg.oy, msg.oz);
    if (!Number.isFinite(origin.x) || origin.distanceTo(eye) > 2.8) {
      origin.copy(eye);
    }

    const muzzle = game.muzzlePos(c, new THREE.Vector3());
    const [vol, pan] = game.spatial(c.pos);
    sound.shot(def.sound, vol, pan);
    if (def.kind !== 'melee') {
      game.effects.burst(muzzle, 16765562, 2, 1.5, 0, 0.06);
    }

    const dirs = Array.isArray(msg.d) ? msg.d : [];
    const firstDir = dirs[0]
      ? new THREE.Vector3(dirs[0][0], dirs[0][1], dirs[0][2]).normalize()
      : c.forward(new THREE.Vector3());

    if (def.kind === 'melee') {
      game.melee(c, def, origin, firstDir);
      this.onHostShot(c, def, muzzle, []);
      return;
    }

    if (def.kind === 'projectile') {
      game.spawnProjectile(
        c,
        def.projectile,
        def.id,
        origin.clone().addScaledVector(firstDir, 0.4),
        firstDir.clone().multiplyScalar(def.projectile.speed),
        def.headMult,
      );
      if (def.projectile.kind === 'rocket') {
        game.effects.burst(muzzle, 11184810, 10, 2, -1, 0.6);
      }
      this.onHostShot(c, def, muzzle, []);
      return;
    }

    const fxList = [];
    const count = Math.min(def.pellets || 1, dirs.length || 1);
    for (let i = 0; i < count; i++) {
      const raw = dirs[i];
      const dir = raw ? new THREE.Vector3(raw[0], raw[1], raw[2]).normalize() : firstDir;
      const maxDist = def.range * 1.6;
      const wallHit = game.map.raycast(origin, dir, maxDist);
      const dist = wallHit ? wallHit.t : maxDist;
      let hits = game.rayChars(origin, dir, dist, c);
      if (!def.pierce) hits = hits.slice(0, 1);

      for (const h of hits) {
        const rangeMult = h.t > def.range ? 0.6 : 1;
        const dmg = cfg.mutators.instagib
          ? 999
          : def.damage * (h.head ? def.headMult : 1) * rangeMult;
        const pt = origin.clone().addScaledVector(dir, h.t);
        if (!cfg.mutators.headshotsOnly || h.head || def.kind === 'melee') {
          game.effects.blood(pt, h.head);
        }
        game.damage(h.c, c, dmg, { head: h.head, weapon: def.id, explosive: false, from: origin });
      }

      const endT = hits.length && !def.pierce ? hits[0].t : dist;
      const endPt = origin.clone().addScaledVector(dir, endT);
      if (def.pierce) {
        game.effects.beam(muzzle, endPt, def.model.accent);
      } else if (i < 4 || Math.random() < 0.4) {
        game.effects.tracer(muzzle, endPt, 16765562);
      }
      const hitWall = wallHit && (!hits.length || def.pierce);
      if (hitWall) {
        game.effects.impact(endPt, new THREE.Vector3(wallHit.nx, wallHit.ny, wallHit.nz), 13617328);
      }
      fxList.push([
        endPt.x,
        endPt.y,
        endPt.z,
        hitWall ? wallHit.nx : 9,
        hitWall ? wallHit.ny : 0,
        hitWall ? wallHit.nz : 0,
      ]);
    }
    this.onHostShot(c, def, muzzle, fxList);
  }

  handleClientGrenade(rec, msg) {
    const c = rec.char;
    if (!c.alive || (game.state !== 'playing' && game.state !== 'paused') || c.grenades <= 0 || c.grenadeCd > 0) return;
    c.grenades--;
    c.grenadeCd = 1;
    const eye = c.eye(new THREE.Vector3());
    const og = new THREE.Vector3(msg.ox, msg.oy, msg.oz);
    if (!Number.isFinite(og.x) || og.distanceTo(eye) > 2.5) og.copy(eye);
    const vel = new THREE.Vector3(msg.vx, msg.vy, msg.vz);
    if (vel.length() > 35) vel.setLength(35);
    game.spawnProjectile(c, FRAG_SPEC, 'frag', og, vel, 1);
    const [vol, pan] = game.spatial(c.pos);
    sound.shot('knife', vol * 0.5, pan);
  }

  tickHost(dt) {
    this.snapAcc += dt;
    if (this.snapAcc < 0.04) return;
    this.snapAcc = 0;

    this.broadcast({
      t: 'snap',
      mt: r2(game.matchTime),
      ts: [...game.teamScore],
      pk: game.pickups.map((p) => (p.active ? 1 : 0)),
      pl: game.chars.map((c) => [
        c.id,
        r2(c.pos.x),
        r2(c.pos.y),
        r2(c.pos.z),
        r2(c.vel.x),
        r2(c.vel.y),
        r2(c.vel.z),
        r3(c.yaw),
        r3(c.pitch),
        Math.ceil(c.health),
        c.alive ? 1 : 0,
        c.shield > 0 ? 1 : 0,
        c.crouch ? 1 : 0,
        c.kills,
        c.deaths,
        c.assists,
        c.score,
        c.streak,
        c.ggLevel,
        c.weapon?.def?.id || 'ak',
        c.team,
      ]),
      pr: game.projectiles.map((p) => [
        PROJ_KINDS.indexOf(p.spec.kind),
        r2(p.pos.x),
        r2(p.pos.y),
        r2(p.pos.z),
        r2(p.vel.x),
        r2(p.vel.y),
        r2(p.vel.z),
      ]),
    });
  }

  /* ============================== CLIENT ============================== */

  joinRoom(rawInput) {
    if (!window.Peer) {
      this.setStatus('', 'Multiplayer library failed to load. Check internet connection.');
      return;
    }
    const code = parseRoomCode(rawInput);
    if (!code) {
      this.setStatus('', 'Enter a valid room code or invite link.');
      return;
    }
    this.leaveRoom(true);
    this.role = 'client';
    this.roomCode = code;
    game.netMode = 'client';
    this.setStatus(`Connecting to room ${code}...`);

    const peer = new window.Peer({ debug: 1, config: ICE_CONFIG });
    this.peer = peer;

    peer.on('open', () => {
      if (this.peer !== peer) return;
      const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
      this.hostConn = conn;

      const timeout = setTimeout(() => {
        if (this.peer === peer && !conn.open) {
          this.leaveRoom(true);
          this.setStatus('', `Could not reach room ${code}. Check the code or host status.`);
        }
      }, 12000);

      conn.on('open', () => {
        clearTimeout(timeout);
        if (this.peer !== peer) return;
        this.setStatus(`Joined room ${code} — syncing...`);
        conn.send({
          t: 'join',
          name: profile.name,
          loadout: { ...profile.loadout },
          camo: profile.camo,
        });
      });

      conn.on('data', (msg) => {
        if (this.peer !== peer || !msg || typeof msg !== 'object') return;
        this.handleHostMessage(msg);
      });

      conn.on('close', () => {
        clearTimeout(timeout);
        if (this.peer !== peer) return;
        this.leaveRoom(true);
        this.setStatus('', 'Disconnected: Host closed the room.');
      });

      conn.on('error', () => {
        clearTimeout(timeout);
        if (this.peer !== peer) return;
        this.leaveRoom(true);
        this.setStatus('', `Connection error joining room ${code}.`);
      });
    });

    peer.on('error', (err) => {
      if (this.peer !== peer) return;
      if (err.type === 'peer-unavailable') {
        this.leaveRoom(true);
        this.setStatus('', `Room ${code} not found. Ask your friend to Host first.`);
        return;
      }
      this.leaveRoom(true);
      this.setStatus('', `Network error: ${err.message || err.type || 'failed'}`);
    });
  }

  sendClientProfile() {
    if (this.role === 'host') {
      this.broadcastLobby();
    } else if (this.role === 'client' && this.hostConn?.open) {
      this.hostConn.send({
        t: 'profile',
        name: profile.name,
        loadout: { ...profile.loadout },
        camo: profile.camo,
      });
    }
  }

  applySyncedCfg(remoteCfg) {
    if (!remoteCfg) return;
    cfg.mode = remoteCfg.mode;
    cfg.mapId = remoteCfg.mapId;
    cfg.bots = remoteCfg.bots;
    cfg.difficulty = remoteCfg.difficulty;
    cfg.scoreLimit = remoteCfg.scoreLimit;
    cfg.timeLimit = remoteCfg.timeLimit;
    cfg.mutators = { ...remoteCfg.mutators };
    if (game.state === 'menu') {
      game.loadMap(cfg.mapId);
    }
  }

  handleHostMessage(msg) {
    switch (msg.t) {
      case 'welcome': {
        this.myId = msg.yourId;
        this.members = msg.members || [];
        this.applySyncedCfg(msg.cfg);
        this.setStatus(msg.inMatch ? `Connected to ${this.roomCode} — joining match...` : `In room ${this.roomCode} — waiting for host to Deploy`);
        break;
      }
      case 'lobby': {
        this.members = msg.members || [];
        this.applySyncedCfg(msg.cfg);
        this.emit();
        break;
      }
      case 'start': {
        this.startClientMatch(msg);
        break;
      }
      case 'joinLive': {
        if (game.state === 'playing' || game.state === 'paused') {
          this.addRemoteClientChar(msg.char);
        }
        break;
      }
      case 'left': {
        const idx = game.chars.findIndex((c) => c.id === msg.id);
        if (idx >= 0) {
          const c = game.chars[idx];
          if (c.model) {
            game.scene.remove(c.model.root);
            c.model.dispose();
          }
          game.chars.splice(idx, 1);
        }
        break;
      }
      case 'snap': {
        this.applySnapshot(msg);
        break;
      }
      case 'spawn': {
        this.handleClientSpawn(msg);
        break;
      }
      case 'hurt': {
        if (!game.player) return;
        game.player.health = msg.hp;
        sound.hurt();
        const ang = Math.atan2(msg.fx - game.player.pos.x, msg.fz - game.player.pos.z);
        game.hud.hurt(-(ang - game.player.yaw) + Math.PI, msg.dmg);
        break;
      }
      case 'hit': {
        game.hud.hitmarker(Boolean(msg.h), Boolean(msg.k));
        sound.hit(Boolean(msg.h));
        break;
      }
      case 'pickup': {
        if (!game.player) return;
        sound.pickup();
        if (msg.k === 'health') {
          game.player.health = Math.min(100, game.player.health + 60);
          game.hud.points('+60 HEALTH', '');
        } else {
          for (const w of game.player.weapons) {
            w.reserve = Math.max(w.reserve, w.def.reserve);
          }
          game.player.grenades = 2;
          game.hud.points('AMMO REFILLED', '');
        }
        break;
      }
      case 'streak': {
        if (!game.player) return;
        sound.streak();
        if (msg.s === 'RADAR') {
          game.radarT = 25;
          game.hud.announce('RADAR ONLINE', 'Enemies revealed on the minimap');
        } else if (msg.s === 'OVERDRIVE') {
          game.overdriveT = 12;
          game.hud.announce('OVERDRIVE', 'Speed, fire rate & infinite ammo');
        } else if (msg.s === 'AIRSTRIKE') {
          game.hud.announce('AIRSTRIKE INBOUND', 'Bombing enemy positions');
        } else if (msg.s === 'ORBITAL') {
          game.hud.announce('ORBITAL STRIKE', 'Impact in 4 seconds');
        }
        break;
      }
      case 'kill': {
        this.handleClientKill(msg);
        break;
      }
      case 'fx': {
        this.handleClientFx(msg);
        break;
      }
      case 'end': {
        this.handleClientEnd(msg);
        break;
      }
      case 'lobbyReset': {
        this.cleanupClientProjectiles();
        game.clearMatch();
        game.state = 'menu';
        game.hud.show(false);
        if (document.pointerLockElement) document.exitPointerLock();
        document.getElementById('pause').classList.add('hidden');
        document.getElementById('end').classList.add('hidden');
        document.getElementById('menu').style.display = '';
        this.setStatus(`In room ${this.roomCode} — waiting for host to Deploy`);
        break;
      }
    }
  }

  addRemoteClientChar(data) {
    if (!data || game.chars.some((c) => c.id === data.id)) return null;
    const isTdm = isTeamMode(game.cfg.mode);
    const isMe = data.id === this.myId;
    const c = new Player(data.id, data.name, data.team, isMe, data.color);
    c.pos.set(data.x, data.y, data.z);
    c.yaw = data.yaw;
    c.alive = true;
    c.ggLevel = data.ggLevel || 0;
    c.netPos = new THREE.Vector3(data.x, data.y, data.z);
    c.netYaw = data.yaw;
    c.netPitch = 0;

    if (isMe) {
      game.player = c;
      game.giveLoadout(c);
    } else {
      const wid = data.weaponId || 'ak';
      c.loadout = [wid, 'p9', 'knife'];
      c.weapons = [{ def: findWeapon(wid), mag: 30, reserve: 90 }];
      c.model = new BotModel(data.color, data.name, isTdm && data.team === (game.player?.team ?? -1));
      c.model.setGun(findWeapon(wid));
      game.scene.add(c.model.root);
    }
    game.chars.push(c);
    return c;
  }

  startClientMatch(msg) {
    sound.ensure();
    this.cleanupClientProjectiles();
    this.applySyncedCfg(msg.cfg);
    game.cfg = { ...this.serializeCfg() };
    game.clearMatch();
    game.loadMap(game.cfg.mapId);
    game.applySettings();
    game.hud.reset();
    game.time = 0;
    game.matchTime = msg.matchTime || 0;
    game.teamScore = msg.teamScore ? [...msg.teamScore] : [0, 0];
    game.radarT = game.overdriveT = game.orbitalT = 0;

    const myEntry = (msg.chars || []).find((c) => c.id === this.myId);
    if (myEntry) this.addRemoteClientChar(myEntry);
    for (const c of msg.chars || []) {
      if (c.id !== this.myId) this.addRemoteClientChar(c);
    }
    for (const spot of game.map.healthSpots) game.addPickup('health', spot);
    for (const spot of game.map.ammoSpots) game.addPickup('ammo', spot);

    document.getElementById('menu').style.display = 'none';
    document.getElementById('pause').classList.add('hidden');
    document.getElementById('end').classList.add('hidden');
    game.state = 'playing';
    game.hud.show(true);

    const modeTitle = game.cfg.mode === 'ffa'
      ? 'FREE FOR ALL'
      : game.cfg.mode === 'tva'
        ? '4v4 TERRORISTS VS ANTI-TERRORISTS'
        : game.cfg.mode === 'tdm'
          ? 'TEAM DEATHMATCH'
          : 'GUN GAME';
    game.hud.announce(
      modeTitle,
      game.cfg.mode === 'gungame' ? 'Every kill upgrades your weapon' : `First to ${game.cfg.scoreLimit} kills`,
    );
    game.lockPointer();
    this.emit();
  }

  applySnapshot(msg) {
    if (game.state !== 'playing' && game.state !== 'paused') return;
    game.matchTime = msg.mt;
    if (msg.ts) game.teamScore = [...msg.ts];
    if (Array.isArray(msg.pk)) {
      for (let i = 0; i < game.pickups.length && i < msg.pk.length; i++) {
        const active = Boolean(msg.pk[i]);
        game.pickups[i].active = active;
        game.pickups[i].mesh.visible = active;
      }
    }

    for (const row of msg.pl || []) {
      const [id, x, y, z, vx, vy, vz, yaw, pitch, hp, alive, shield, crouch, kills, deaths, assists, score, streak, ggLevel, wid, team] = row;
      let c = game.chars.find((ch) => ch.id === id);
      if (!c) {
        c = this.addRemoteClientChar({
          id,
          name: `Player${id}`,
          team,
          color: isTeamMode(game.cfg.mode) ? TEAM_COLORS[team] : FFA_COLORS[id % FFA_COLORS.length],
          x,
          y,
          z,
          yaw,
          ggLevel,
          weaponId: wid,
        });
      }
      if (!c) continue;
      const prevGg = c.ggLevel;
      c.health = hp;
      c.alive = Boolean(alive);
      c.shield = shield ? 1 : 0;
      c.kills = kills;
      c.deaths = deaths;
      c.assists = assists;
      c.score = score;
      c.streak = streak;
      c.ggLevel = ggLevel;
      c.team = team;

      if (c === game.player) {
        if (game.cfg.mode === 'gungame' && ggLevel !== prevGg && ggLevel < GG_ORDER.length) {
          game.giveLoadout(c);
        }
        continue;
      }
      if (!c.netPos) c.netPos = new THREE.Vector3(x, y, z);
      c.netPos.set(x, y, z);
      c.vel.set(vx, vy, vz);
      c.netYaw = yaw;
      c.netPitch = pitch;
      c.crouch = Boolean(crouch);
      c.height = c.crouch ? 1.25 : 1.8;
      if (c.model) {
        c.model.setGun(findWeapon(wid));
      }
    }

    const projList = msg.pr || [];
    while (this.clientProjectiles.length > projList.length) {
      const removed = this.clientProjectiles.pop();
      game.scene.remove(removed.mesh);
    }
    for (let i = 0; i < projList.length; i++) {
      const [kIdx, x, y, z, vx, vy, vz] = projList[i];
      const kind = PROJ_KINDS[kIdx] || 'grenade';
      let item = this.clientProjectiles[i];
      if (!item || item.kind !== kind) {
        if (item) game.scene.remove(item.mesh);
        const mesh = makeProjMesh(kind);
        game.scene.add(mesh);
        item = { kind, mesh };
        this.clientProjectiles[i] = item;
      }
      item.mesh.position.set(x, y, z);
      if (kind !== 'grenade') {
        item.mesh.lookAt(x - vx, y - vy, z - vz);
      } else {
        item.mesh.rotation.x += 0.25;
      }
    }
  }

  interpChar(c, dt) {
    if (!c.netPos) return;
    const f = 1 - Math.exp(-18 * dt);
    if (c.pos.distanceTo(c.netPos) > 8) {
      c.pos.copy(c.netPos);
    } else {
      c.pos.lerp(c.netPos, f);
    }
    c.yaw += angleDelta(c.yaw, c.netYaw ?? c.yaw) * f;
    c.pitch += ((c.netPitch ?? c.pitch) - c.pitch) * f;
  }

  handleClientSpawn(msg) {
    const c = game.chars.find((ch) => ch.id === msg.id);
    if (!c) return;
    c.pos.set(msg.x, msg.y, msg.z);
    c.vel.set(0, 0, 0);
    c.yaw = msg.yaw;
    c.pitch = 0;
    c.alive = true;
    c.health = 100;
    c.shield = 2;
    c.grenades = 2;
    c.killer = null;
    if (c.netPos) c.netPos.copy(c.pos);
    if (c === game.player) {
      game.recoil = 0;
      game.adsT = 0;
      game.scopeStep = 1;
      game.giveLoadout(c);
      game.hud.deathScreen(false);
    }
  }

  handleClientKill(msg) {
    const isMine = msg.kid === this.myId || msg.vid === this.myId;
    const kc = msg.kid === this.myId ? '#ffd400' : msg.kc;
    const vc = msg.vid === this.myId ? '#ffd400' : msg.vc;
    game.hud.kill(msg.kn, msg.wn, msg.vn, Boolean(msg.hd), kc, vc, isMine);
    if (msg.ts) game.teamScore = [...msg.ts];

    const killer = game.chars.find((c) => c.id === msg.kid);
    const victim = game.chars.find((c) => c.id === msg.vid);
    if (killer) {
      killer.ggLevel = msg.kgg;
      killer.streak = msg.ks;
    }
    if (victim) {
      victim.alive = false;
      victim.health = 0;
      victim.respawn = msg.vr ?? RESPAWN_TIME;
      victim.ggLevel = msg.vgg;
      victim.killer = killer || null;
      victim.killerWeapon = msg.wid;
      if (victim.model) victim.model.deathT = 0;
    }

    if (msg.kid === this.myId && msg.vid !== this.myId) {
      sound.kill(Boolean(msg.hd));
      const mult = msg.ks >= 2
        ? ['', '', 'DOUBLE KILL', 'TRIPLE KILL', 'QUAD KILL', 'RAMPAGE'][Math.min(5, msg.ks)] || 'UNSTOPPABLE'
        : '';
      game.hud.points(
        msg.hd ? 'HEADSHOT' : 'ELIMINATED',
        `${msg.vn}  +${100 + (msg.hd ? 50 : 0)}${mult ? `  · ${mult}` : ''}`,
      );
      if (game.cfg.mode === 'gungame' && msg.kgg < GG_ORDER.length) {
        game.player.ggLevel = msg.kgg;
        game.giveLoadout(game.player);
        game.hud.announce(`LEVEL ${msg.kgg + 1}/${GG_ORDER.length}`, findWeapon(GG_ORDER[msg.kgg]).name);
      }
    }

    if (msg.vid === this.myId && game.cfg.mode === 'gungame' && findWeapon(msg.wid).kind === 'melee') {
      game.player.ggLevel = msg.vgg;
      game.hud.announce('DEMOTED', 'You were knifed');
    }
  }

  handleClientFx(msg) {
    if (msg.k === 'shot') {
      const def = findWeapon(msg.w);
      const origin = new THREE.Vector3(msg.mx, msg.my, msg.mz);
      const [vol, pan] = game.spatial(origin);
      sound.shot(def.sound, vol, pan);
      if (def.kind !== 'melee') {
        game.effects.burst(origin, 16765562, 2, 1.5, 0, 0.06);
      }
      for (const p of msg.pts || []) {
        const end = new THREE.Vector3(p[0], p[1], p[2]);
        if (def.pierce) {
          game.effects.beam(origin, end, def.model.accent);
        } else {
          game.effects.tracer(origin, end, 16765562);
        }
        if (p[3] !== 9) {
          game.effects.impact(end, new THREE.Vector3(p[3], p[4], p[5]), 13617328);
        }
      }
    } else if (msg.k === 'boom') {
      const pos = new THREE.Vector3(msg.x, msg.y, msg.z);
      game.effects.explosion(pos, msg.r, msg.pl ? 11815935 : 16747050);
      const [vol, pan] = game.spatial(pos);
      if (msg.pl) sound.shot('plasma', vol * 0.6, pan);
      else sound.explosion(vol, pan);
      if (game.player?.alive) {
        const dist = game.player.pos.distanceTo(pos);
        game.effects.shake = Math.max(
          game.effects.shake,
          Math.max(0, 1 - dist / (msg.r * 4)) * (msg.pl ? 0.2 : 1),
        );
      }
    }
  }

  handleClientEnd(msg) {
    this.cleanupClientProjectiles();
    game.state = 'ended';
    if (document.pointerLockElement) document.exitPointerLock();
    const rows = (msg.rows || []).map((r) => ({
      ...r,
      isPlayer: r.id === this.myId,
    }));
    const me = rows.find((r) => r.isPlayer) || {
      kills: game.player?.kills || 0,
      deaths: game.player?.deaths || 0,
      assists: game.player?.assists || 0,
      headshots: game.player?.headshots || 0,
      bestStreak: game.player?.bestStreak || 0,
      team: game.player?.team || 0,
    };
    const teams = Boolean(msg.teams);
    let won = false;
    let place = 1;
    if (teams) {
      const ts = msg.teamScore || [0, 0];
      won = ts[me.team] > ts[1 - me.team];
      place = won ? 1 : 2;
    } else {
      place = Math.max(1, rows.findIndex((r) => r.isPlayer) + 1);
      won = place === 1;
    }
    const xp = 200 + me.kills * 100 + me.headshots * 25 + me.assists * 40 + (won ? 500 : 0);
    game.hud.show(false);
    game.onEnd({
      won,
      place,
      total: teams ? 2 : rows.length,
      kills: me.kills,
      deaths: me.deaths,
      assists: me.assists,
      headshots: me.headshots,
      bestStreak: me.bestStreak,
      xp,
      title: msg.title,
      rows,
      teams,
      mode: msg.cfg?.mode,
    });
  }

  onClientShoot(weaponId, origin, dirs) {
    if (this.role !== 'client' || !this.hostConn?.open) return;
    this.hostConn.send({
      t: 'shoot',
      w: weaponId,
      ox: r3(origin.x),
      oy: r3(origin.y),
      oz: r3(origin.z),
      d: dirs.map((v) => [r4(v.x), r4(v.y), r4(v.z)]),
    });
  }

  onClientGrenade(origin, vel) {
    if (this.role !== 'client' || !this.hostConn?.open) return;
    this.hostConn.send({
      t: 'nade',
      ox: r3(origin.x),
      oy: r3(origin.y),
      oz: r3(origin.z),
      vx: r2(vel.x),
      vy: r2(vel.y),
      vz: r2(vel.z),
    });
  }

  tickClient(dt) {
    this.clientAcc += dt;
    if (this.clientAcc < 0.04 || !this.hostConn?.open || !game.player) return;
    this.clientAcc = 0;
    const p = game.player;
    this.hostConn.send({
      t: 'cs',
      x: r3(p.pos.x),
      y: r3(p.pos.y),
      z: r3(p.pos.z),
      vx: r2(p.vel.x),
      vy: r2(p.vel.y),
      vz: r2(p.vel.z),
      yaw: r4(p.yaw),
      pitch: r4(p.pitch),
      cr: p.crouch ? 1 : 0,
      sl: p.slide > 0 ? 1 : 0,
      wi: p.current,
      ad: game.adsT > 0.5 ? 1 : 0,
      sp: p.input.sprint ? 1 : 0,
    });
  }

  onLocalQuit() {
    this.cleanupClientProjectiles();
    if (this.role === 'host') {
      this.broadcast({ t: 'lobbyReset' });
      this.updateMembers();
    }
  }
}

export const net = new RoomNet();
game.net = net;
