/**
 * Mobile & touch input module for VOXFIRE.io.
 * Drives virtual joystick movement, multi-touch look aiming, HUD action buttons,
 * and dynamic touch-mode detection without interfering with desktop mouse/keyboard play.
 */

const JOY_RADIUS = 44;
const JOY_DEADZONE = 0.12;
const SPRINT_Y_THRESHOLD = -0.78;
const TOUCH_LOOK_SCALE = 3.2;

function isCoarseHardware() {
  const uaMobile = /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent);
  const coarse = Boolean(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  const fine = Boolean(window.matchMedia && window.matchMedia('(pointer: fine)').matches);
  const compactTouch = !fine
    && ('ontouchstart' in window || navigator.maxTouchPoints > 0)
    && Math.min(window.innerWidth, window.innerHeight) <= 900;
  return uaMobile || coarse || compactTouch;
}

/**
 * Binds all mobile HUD touch controls to the VOXFIRE game instance.
 */
export function createTouchController(game, profile, saveProfile, sound) {
  let touchSeen = false;
  let sprintLocked = false;
  let initialized = false;

  const el = (id) => document.getElementById(id);

  function shouldEnableTouch() {
    const mode = profile.settings.touchControls || 'auto';
    if (mode === 'on') return true;
    if (mode === 'off') return false;
    return touchSeen || game.isMobileDevice || isCoarseHardware();
  }

  function syncTouchMode() {
    const active = shouldEnableTouch();
    game.touchActive = active;
    document.body.classList.toggle('touch-ui', active);
    const hint = el('pause-hint');
    if (hint) {
      hint.textContent = active
        ? 'Tap Resume to continue.'
        : 'Click Resume to recapture your mouse.';
    }
    const autoBtn = el('btn-autofire');
    if (autoBtn) {
      autoBtn.classList.toggle('hidden', !(game.isMobileDevice && active));
    }
    return active;
  }

  function clearStuckVisuals() {
    const joyZone = el('joystick-zone');
    const joyBase = el('joystick-base');
    const joyKnob = el('joystick-knob');
    if (joyZone) joyZone.classList.remove('active', 'sprinting');
    if (joyBase) {
      joyBase.style.left = '';
      joyBase.style.top = '';
    }
    if (joyKnob) {
      joyKnob.style.left = '';
      joyKnob.style.top = '';
    }
    document.querySelectorAll('.tc-btn.pressed').forEach((b) => b.classList.remove('pressed'));
  }

  function bindHoldButton(btn, onState) {
    if (!btn) return;
    let pointerTouchId = null;

    btn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (pointerTouchId === null && e.changedTouches.length > 0) {
        pointerTouchId = e.changedTouches[0].identifier;
        btn.classList.add('pressed');
        onState(true);
      }
    }, { passive: false });

    const release = (e) => {
      if (pointerTouchId === null) return;
      for (const t of e.changedTouches) {
        if (t.identifier === pointerTouchId) {
          pointerTouchId = null;
          btn.classList.remove('pressed');
          onState(false);
          break;
        }
      }
    };

    btn.addEventListener('touchend', release, { passive: false });
    btn.addEventListener('touchcancel', release, { passive: false });
  }

  function bindLookSurface(surface) {
    if (!surface) return;
    const tracked = new Map();

    surface.addEventListener('touchstart', (e) => {
      if (game.state !== 'playing') return;
      for (const t of e.changedTouches) {
        tracked.set(t.identifier, { x: t.clientX, y: t.clientY });
      }
    }, { passive: false });

    surface.addEventListener('touchmove', (e) => {
      if (game.state !== 'playing') return;
      e.preventDefault();
      for (const t of e.changedTouches) {
        const prev = tracked.get(t.identifier);
        if (!prev) continue;
        game.look.dx += (t.clientX - prev.x) * TOUCH_LOOK_SCALE;
        game.look.dy += (t.clientY - prev.y) * TOUCH_LOOK_SCALE;
        prev.x = t.clientX;
        prev.y = t.clientY;
      }
    }, { passive: false });

    const endTrack = (e) => {
      for (const t of e.changedTouches) {
        tracked.delete(t.identifier);
      }
    };

    surface.addEventListener('touchend', endTrack, { passive: false });
    surface.addEventListener('touchcancel', endTrack, { passive: false });
  }

  function bindJoystick() {
    const zone = el('joystick-zone');
    const base = el('joystick-base');
    const knob = el('joystick-knob');
    if (!zone || !base || !knob) return;

    let joyId = null;
    let originX = 0;
    let originY = 0;

    function updateKnob(clientX, clientY) {
      let dx = clientX - originX;
      let dy = clientY - originY;
      const dist = Math.hypot(dx, dy);
      if (dist > JOY_RADIUS) {
        const s = JOY_RADIUS / dist;
        dx *= s;
        dy *= s;
      }
      const rect = zone.getBoundingClientRect();
      knob.style.left = `${originX - rect.left + dx}px`;
      knob.style.top = `${originY - rect.top + dy}px`;

      const nx = dx / JOY_RADIUS;
      const ny = dy / JOY_RADIUS;
      if (Math.hypot(nx, ny) < JOY_DEADZONE) {
        game.touch.moveX = 0;
        game.touch.moveY = 0;
        game.touch.sprint = sprintLocked;
        zone.classList.remove('sprinting');
        return;
      }
      game.touch.moveX = nx;
      game.touch.moveY = ny;
      const autoSprint = ny < SPRINT_Y_THRESHOLD;
      game.touch.sprint = sprintLocked || autoSprint;
      zone.classList.toggle('sprinting', game.touch.sprint);
    }

    zone.addEventListener('touchstart', (e) => {
      if (game.state !== 'playing' || joyId !== null || e.changedTouches.length === 0) return;
      e.preventDefault();
      const t = e.changedTouches[0];
      joyId = t.identifier;
      const rect = zone.getBoundingClientRect();
      const pad = 42;
      originX = Math.max(rect.left + pad, Math.min(rect.right - pad, t.clientX));
      originY = Math.max(rect.top + pad, Math.min(rect.bottom - pad, t.clientY));
      base.style.left = `${originX - rect.left}px`;
      base.style.top = `${originY - rect.top}px`;
      zone.classList.add('active');
      updateKnob(t.clientX, t.clientY);
    }, { passive: false });

    zone.addEventListener('touchmove', (e) => {
      if (joyId === null) return;
      for (const t of e.changedTouches) {
        if (t.identifier === joyId) {
          e.preventDefault();
          updateKnob(t.clientX, t.clientY);
          break;
        }
      }
    }, { passive: false });

    const releaseJoy = (e) => {
      if (joyId === null) return;
      for (const t of e.changedTouches) {
        if (t.identifier === joyId) {
          joyId = null;
          game.touch.moveX = 0;
          game.touch.moveY = 0;
          game.touch.sprint = sprintLocked;
          zone.classList.remove('active', 'sprinting');
          base.style.left = '';
          base.style.top = '';
          knob.style.left = '';
          knob.style.top = '';
          break;
        }
      }
    };

    zone.addEventListener('touchend', releaseJoy, { passive: false });
    zone.addEventListener('touchcancel', releaseJoy, { passive: false });
  }

  function bindActionButtons() {
    const fireBtn = el('btn-fire');
    const adsBtn = el('btn-ads');
    const jumpBtn = el('btn-jump');
    const crouchBtn = el('btn-crouch');
    const reloadBtn = el('btn-reload');
    const grenadeBtn = el('btn-grenade');
    const swapBtn = el('btn-swap');
    const sprintBtn = el('btn-sprint');
    const autoFireBtn = el('btn-autofire');
    const scopeZoomBtn = el('btn-scope-zoom');
    const pauseBtn = el('btn-pause-m');
    const scoreBtn = el('btn-score-m');
    const lookZone = el('look-zone');

    bindLookSurface(lookZone);
    bindLookSurface(fireBtn);
    bindLookSurface(adsBtn);

    bindHoldButton(fireBtn, (down) => {
      game.touch.fire = down;
    });
    bindHoldButton(jumpBtn, (down) => {
      game.touch.jump = down;
    });
    bindHoldButton(crouchBtn, (down) => {
      game.touch.crouch = down;
    });

    if (adsBtn) {
      adsBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const p = game.player;
        if (!p || !p.alive || p.weapon.def.kind === 'melee') return;
        game.touch.ads = !game.touch.ads;
        sound.ensure();
        sound.ui();
      }, { passive: false });
    }

    if (sprintBtn) {
      sprintBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        sprintLocked = !sprintLocked;
        game.touch.sprint = sprintLocked || game.touch.moveY < SPRINT_Y_THRESHOLD;
        sound.ensure();
        sound.ui();
      }, { passive: false });
    }

    if (autoFireBtn) {
      autoFireBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        if (!game.isMobileDevice) return;
        const next = profile.settings.autoFire === false;
        profile.settings.autoFire = next;
        saveProfile();
        const chk = el('s-autofire');
        if (chk) chk.checked = next;
        sound.ensure();
        sound.ui();
      }, { passive: false });
    }

    if (reloadBtn) {
      reloadBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const p = game.player;
        if (!p || !p.alive) return;
        game.touch.ads = false;
        game.startReload(p);
      }, { passive: false });
    }

    if (grenadeBtn) {
      grenadeBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const p = game.player;
        if (p && p.alive) game.throwGrenade(p);
      }, { passive: false });
    }

    if (swapBtn) {
      swapBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const p = game.player;
        if (!p || !p.alive || p.weapons.length < 2) return;
        game.touch.ads = false;
        game.switchWeapon(p, (p.current + 1) % p.weapons.length);
      }, { passive: false });
    }

    const slotsEl = el('weapon-slots');
    if (slotsEl) {
      slotsEl.addEventListener('touchstart', (e) => {
        const slot = e.target.closest('.slot');
        if (!slot) return;
        e.preventDefault();
        const idx = Array.from(slotsEl.children).indexOf(slot);
        const p = game.player;
        if (p && p.alive && idx >= 0 && idx < p.weapons.length) {
          game.touch.ads = false;
          game.switchWeapon(p, idx);
        }
      }, { passive: false });
    }

    if (scopeZoomBtn) {
      scopeZoomBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const p = game.player;
        if (!p || !p.alive || !p.weapon.def.scope) return;
        const zooms = p.weapon.def.scopeZooms || [4, 8, 12];
        game.scopeStep = (game.scopeStep + 1) % zooms.length;
        sound.ui();
      }, { passive: false });
    }

    if (pauseBtn) {
      pauseBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        clearStuckVisuals();
        game.pause();
      }, { passive: false });
      pauseBtn.addEventListener('click', () => {
        clearStuckVisuals();
        game.pause();
      });
    }

    const toggleScore = (e) => {
      if (!game.touchActive || game.state !== 'playing') return;
      e.preventDefault();
      game.touch.scoreboard = !game.touch.scoreboard;
      sound.ui();
    };
    if (scoreBtn) scoreBtn.addEventListener('touchstart', toggleScore, { passive: false });
    const topbar = el('topbar');
    if (topbar) topbar.addEventListener('touchstart', toggleScore, { passive: false });
    const board = el('scoreboard');
    if (board) {
      board.addEventListener('touchstart', (e) => {
        if (!game.touchActive || !game.touch.scoreboard) return;
        e.preventDefault();
        game.touch.scoreboard = false;
      }, { passive: false });
    }
  }

  function syncHudButtonStates() {
    requestAnimationFrame(syncHudButtonStates);
    if (!game.touchActive || game.state !== 'playing') return;
    const p = game.player;
    if (p && (!p.alive || p.weapon.def.kind === 'melee')) {
      game.touch.ads = false;
    }
    const adsBtn = el('btn-ads');
    const sprintBtn = el('btn-sprint');
    const autoFireBtn = el('btn-autofire');
    const scoreBtn = el('btn-score-m');
    const zoomBtn = el('btn-scope-zoom');

    if (adsBtn) adsBtn.classList.toggle('active', Boolean(game.touch.ads));
    if (sprintBtn) sprintBtn.classList.toggle('active', sprintLocked);
    if (autoFireBtn) {
      const enabled = game.isMobileDevice && profile.settings.autoFire !== false;
      autoFireBtn.classList.toggle('active', enabled);
      autoFireBtn.classList.toggle('firing', enabled && Boolean(game.autoFiring));
    }
    if (scoreBtn) scoreBtn.classList.toggle('active', Boolean(game.touch.scoreboard));
    if (zoomBtn) {
      const def = p?.weapon?.def;
      const showZoom = Boolean(p && p.alive && def && def.scope && game.adsT > 0.35);
      zoomBtn.classList.toggle('hidden', !showZoom);
      if (showZoom) {
        const zooms = def.scopeZooms || [4, 8, 12];
        const z = zooms[Math.max(0, Math.min(zooms.length - 1, game.scopeStep))];
        zoomBtn.textContent = `${z}×`;
      }
    }
  }

  function init() {
    if (initialized) return syncTouchMode();
    initialized = true;

    bindJoystick();
    bindActionButtons();
    syncTouchMode();

    window.addEventListener('touchstart', () => {
      if (!touchSeen) {
        touchSeen = true;
        syncTouchMode();
      }
    }, { passive: true, capture: true, once: true });

    if (window.matchMedia) {
      const mq = window.matchMedia('(pointer: coarse)');
      mq.addEventListener?.('change', () => syncTouchMode());
    }

    const origOnPause = game.onPause;
    game.onPause = (paused) => {
      if (paused) {
        sprintLocked = false;
        clearStuckVisuals();
      }
      if (origOnPause) origOnPause(paused);
    };

    requestAnimationFrame(syncHudButtonStates);
    return game.touchActive;
  }

  return { init, syncTouchMode };
}
