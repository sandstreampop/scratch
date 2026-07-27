// Unified input for desktop and touch.
//
// Both paths produce the same action state, so the game loop never branches on
// input source. Desktop uses pointer lock; touch uses a floating movement
// stick on the left, drag-to-look on the right, and a fixed button cluster.
//
// iOS Safari has no Pointer Lock API at all, so touch is not a degraded mode
// here — on a phone it is the only mode, and it has to feel deliberate.

const ACTIONS = {
  forward: false, back: false, left: false, right: false,
  sprint: false, crouch: false, ads: false, fire: false,
};

/** Touch look sensitivity, radians per CSS pixel of drag. */
const LOOK_SENSITIVITY = 0.0042;
const STICK_RADIUS = 58;       // px from centre for full deflection
const STICK_DEADZONE = 0.14;
const SPRINT_THRESHOLD = 0.92; // stick deflection that starts a sprint

export const isTouchDevice = (() => {
  if (typeof window === 'undefined') return false;
  return ('ontouchstart' in window)
    || (navigator.maxTouchPoints > 0)
    || window.matchMedia('(pointer: coarse)').matches;
})();

export class Input {
  /**
   * @param canvas       element that receives pointer lock and touch events
   * @param player       supplies look(dx, dy) and requestJump(now)
   * @param handlers     { onReload, onStart }
   */
  constructor(canvas, player, handlers = {}) {
    this.canvas = canvas;
    this.player = player;
    this.handlers = handlers;
    this.state = { ...ACTIONS };
    this.pointerLocked = false;
    this.enabled = false;

    // Touch look is accumulated per frame rather than applied per event, so a
    // burst of coalesced touchmoves cannot outrun the simulation.
    this.lookDelta = { x: 0, y: 0 };
    this.touch = {
      move: null,     // { id, originX, originY, x, y }
      look: null,     // { id, lastX, lastY }
    };

    this.bindKeyboard();
    this.bindMouse();
    if (isTouchDevice) this.bindTouch();
  }

  get usingTouch() { return isTouchDevice; }

  /* ----------------------------------------------------------- keyboard -- */

  bindKeyboard() {
    const map = {
      KeyW: 'forward', ArrowUp: 'forward',
      KeyS: 'back', ArrowDown: 'back',
      KeyA: 'left', ArrowLeft: 'left',
      KeyD: 'right', ArrowRight: 'right',
      ShiftLeft: 'sprint', ShiftRight: 'sprint',
      KeyC: 'crouch', ControlLeft: 'crouch',
    };

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (map[e.code]) { this.state[map[e.code]] = true; e.preventDefault(); }
      else if (e.code === 'Space') { this.player.requestJump(this.now()); e.preventDefault(); }
      else if (e.code === 'KeyR') this.handlers.onReload?.();
    });

    window.addEventListener('keyup', (e) => {
      if (map[e.code]) { this.state[map[e.code]] = false; e.preventDefault(); }
    });

    // Releasing keys on blur stops the player walking into a wall forever
    // while the tab is in the background.
    window.addEventListener('blur', () => this.releaseAll());
  }

  /* -------------------------------------------------------------- mouse -- */

  bindMouse() {
    window.addEventListener('mousedown', (e) => {
      if (!this.pointerLocked) return;
      if (e.button === 0) this.state.fire = true;
      if (e.button === 2) this.state.ads = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.state.fire = false;
      if (e.button === 2) this.state.ads = false;
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      this.player.look(e.movementX, e.movementY);
    });

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (!this.pointerLocked) this.releaseAll();
    });
  }

  requestPointerLock() {
    if (isTouchDevice) return;
    this.canvas.requestPointerLock?.();
  }

  /* -------------------------------------------------------------- touch -- */

  bindTouch() {
    const opts = { passive: false };
    this.canvas.addEventListener('touchstart', (e) => this.onTouchStart(e), opts);
    this.canvas.addEventListener('touchmove', (e) => this.onTouchMove(e), opts);
    this.canvas.addEventListener('touchend', (e) => this.onTouchEnd(e), opts);
    this.canvas.addEventListener('touchcancel', (e) => this.onTouchEnd(e), opts);

    this.stickEl = document.getElementById('stick');
    this.stickKnobEl = document.getElementById('stick-knob');
    this.bindButtons();
  }

  /**
   * Buttons are DOM rather than canvas so they inherit safe-area insets and
   * stay crisp at any devicePixelRatio. They sit outside the canvas, so their
   * touches never reach the look handler.
   */
  bindButtons() {
    const hold = (id, action) => {
      const el = document.getElementById(id);
      if (!el) return;
      const down = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.state[action] = true;
        el.classList.add('active');
      };
      const up = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.state[action] = false;
        el.classList.remove('active');
      };
      el.addEventListener('touchstart', down, { passive: false });
      el.addEventListener('touchend', up, { passive: false });
      el.addEventListener('touchcancel', up, { passive: false });
    };

    const toggle = (id, action) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.state[action] = !this.state[action];
        el.classList.toggle('active', this.state[action]);
      }, { passive: false });
    };

    const tap = (id, fn) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
        el.classList.add('active');
        setTimeout(() => el.classList.remove('active'), 130);
      }, { passive: false });
    };

    hold('btn-fire', 'fire');
    toggle('btn-ads', 'ads');
    toggle('btn-crouch', 'crouch');
    tap('btn-reload', () => this.handlers.onReload?.());
    tap('btn-jump', () => this.player.requestJump(this.now()));
  }

  onTouchStart(e) {
    if (!this.enabled) return;
    e.preventDefault();
    const midpoint = window.innerWidth * 0.42;   // left of this drives movement

    for (const t of e.changedTouches) {
      if (t.clientX < midpoint && !this.touch.move) {
        // Floating stick: it originates wherever the thumb lands, which is
        // far more forgiving than a fixed pad you have to find by feel.
        this.touch.move = {
          id: t.identifier,
          originX: t.clientX, originY: t.clientY,
          x: t.clientX, y: t.clientY,
        };
        this.showStick(t.clientX, t.clientY, 0, 0);
      } else if (t.clientX >= midpoint && !this.touch.look) {
        this.touch.look = { id: t.identifier, lastX: t.clientX, lastY: t.clientY };
      }
    }
  }

  onTouchMove(e) {
    if (!this.enabled) return;
    e.preventDefault();

    for (const t of e.changedTouches) {
      const move = this.touch.move;
      if (move && t.identifier === move.id) {
        move.x = t.clientX;
        move.y = t.clientY;
        this.applyStick();
        continue;
      }
      const look = this.touch.look;
      if (look && t.identifier === look.id) {
        this.lookDelta.x += t.clientX - look.lastX;
        this.lookDelta.y += t.clientY - look.lastY;
        look.lastX = t.clientX;
        look.lastY = t.clientY;
      }
    }
  }

  onTouchEnd(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (this.touch.move && t.identifier === this.touch.move.id) {
        this.touch.move = null;
        this.state.forward = this.state.back = false;
        this.state.left = this.state.right = false;
        this.state.sprint = false;
        this.hideStick();
      }
      if (this.touch.look && t.identifier === this.touch.look.id) {
        this.touch.look = null;
      }
    }
  }

  /**
   * The stick is analogue but the movement model is boolean, so deflection is
   * resolved to axis flags. Sprint falls out of a near-full forward push,
   * which removes the need for a separate sprint button.
   */
  applyStick() {
    const s = this.touch.move;
    if (!s) return;
    let dx = (s.x - s.originX) / STICK_RADIUS;
    let dy = (s.y - s.originY) / STICK_RADIUS;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }

    const magnitude = Math.min(1, len);
    this.showStick(s.originX, s.originY, dx, dy);

    if (magnitude < STICK_DEADZONE) {
      this.state.forward = this.state.back = false;
      this.state.left = this.state.right = false;
      this.state.sprint = false;
      return;
    }

    this.state.forward = dy < -STICK_DEADZONE;
    this.state.back = dy > STICK_DEADZONE;
    this.state.left = dx < -STICK_DEADZONE;
    this.state.right = dx > STICK_DEADZONE;
    this.state.sprint = this.state.forward && magnitude > SPRINT_THRESHOLD && !this.state.ads;
  }

  showStick(originX, originY, dx, dy) {
    if (!this.stickEl) return;
    this.stickEl.style.display = 'block';
    this.stickEl.style.left = `${originX}px`;
    this.stickEl.style.top = `${originY}px`;
    if (this.stickKnobEl) {
      this.stickKnobEl.style.transform =
        `translate(-50%, -50%) translate(${dx * STICK_RADIUS}px, ${dy * STICK_RADIUS}px)`;
    }
  }

  hideStick() {
    if (this.stickEl) this.stickEl.style.display = 'none';
  }

  /* ------------------------------------------------------------- shared -- */

  now() { return performance.now() / 1000; }

  releaseAll() {
    for (const k of Object.keys(this.state)) this.state[k] = false;
    this.touch.move = null;
    this.touch.look = null;
    this.hideStick();
  }

  /** Drains accumulated touch look into the player. Call once per frame. */
  update() {
    if (this.lookDelta.x || this.lookDelta.y) {
      // Scaled to match mouse units, which player.look() expects.
      const k = LOOK_SENSITIVITY / 0.0021;
      this.player.look(this.lookDelta.x * k, this.lookDelta.y * k);
      this.lookDelta.x = 0;
      this.lookDelta.y = 0;
    }
  }
}
