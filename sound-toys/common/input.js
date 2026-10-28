// Gamepad-first input. Keyboard mirrors the same virtual buttons so every
// action is reachable either way. Call Input.update() once per frame.
(function () {
  'use strict';

  // W3C "standard" gamepad mapping.
  const PAD_INDEX = {
    a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7,
    select: 8, start: 9, ls: 10, rs: 11, up: 12, down: 13, left: 14, right: 15,
  };

  const KEY_MAP = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    KeyZ: 'a', Space: 'a', KeyX: 'b', KeyC: 'x', KeyV: 'y',
    KeyQ: 'lb', KeyE: 'rb', Digit1: 'lt', Digit3: 'rt',
    Enter: 'start', Tab: 'select',
    // Right stick on the keyboard.
    KeyI: 'rup', KeyK: 'rdown', KeyJ: 'rleft', KeyL: 'rright',
  };

  // Buttons that auto-repeat while held (menus, value nudging).
  const REPEATS = new Set(['up', 'down', 'left', 'right', 'rup', 'rdown', 'rleft', 'rright', 'lt', 'rt']);
  const REPEAT_DELAY = 0.32;
  const REPEAT_RATE = 0.06;
  const STICK_DEADZONE = 0.5;

  const keysDown = new Set();
  // Keys that went down since the last update, so taps shorter than a
  // frame still register.
  const keysTapped = new Set();
  const held = {};
  const prevHeld = {};
  const holdTime = {};
  const nextRepeat = {};
  const pressedNow = new Set();
  const axes = { lx: 0, ly: 0, rx: 0, ry: 0 };
  let lastTime = performance.now() / 1000;
  let padName = null;

  window.addEventListener('keydown', (e) => {
    const b = KEY_MAP[e.code];
    if (!b) return;
    // Leave typing in form fields alone.
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.code !== 'Tab') return;
    e.preventDefault();
    keysDown.add(e.code);
    keysTapped.add(e.code);
  });
  window.addEventListener('keyup', (e) => keysDown.delete(e.code));
  window.addEventListener('blur', () => keysDown.clear());

  function activePad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  function update() {
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, now - lastTime);
    lastTime = now;
    pressedNow.clear();

    const cur = {};
    for (const code of keysDown) cur[KEY_MAP[code]] = true;
    for (const code of keysTapped) cur[KEY_MAP[code]] = true;
    keysTapped.clear();

    const pad = activePad();
    padName = pad ? pad.id : null;
    axes.lx = axes.ly = axes.rx = axes.ry = 0;
    if (pad) {
      for (const [name, i] of Object.entries(PAD_INDEX)) {
        const btn = pad.buttons[i];
        if (btn && (btn.pressed || btn.value > 0.5)) cur[name] = true;
      }
      const ax = pad.axes;
      axes.lx = ax[0] || 0; axes.ly = ax[1] || 0;
      axes.rx = ax[2] || 0; axes.ry = ax[3] || 0;
      // Sticks also act as directional buttons.
      if (axes.lx < -STICK_DEADZONE) cur.left = true;
      if (axes.lx > STICK_DEADZONE) cur.right = true;
      if (axes.ly < -STICK_DEADZONE) cur.up = true;
      if (axes.ly > STICK_DEADZONE) cur.down = true;
      if (axes.rx < -STICK_DEADZONE) cur.rleft = true;
      if (axes.rx > STICK_DEADZONE) cur.rright = true;
      if (axes.ry < -STICK_DEADZONE) cur.rup = true;
      if (axes.ry > STICK_DEADZONE) cur.rdown = true;
    }

    const names = new Set([...Object.keys(cur), ...Object.keys(held)]);
    for (const name of names) {
      prevHeld[name] = held[name] || false;
      held[name] = !!cur[name];
      if (held[name] && !prevHeld[name]) {
        pressedNow.add(name);
        holdTime[name] = 0;
        nextRepeat[name] = REPEAT_DELAY;
      } else if (held[name]) {
        holdTime[name] += dt;
        if (REPEATS.has(name) && holdTime[name] >= nextRepeat[name]) {
          pressedNow.add(name);
          nextRepeat[name] += REPEAT_RATE;
        }
      }
    }
  }

  window.Input = {
    update,
    // True on the frame a button goes down (and on auto-repeat for directions).
    pressed: (name) => pressedNow.has(name),
    held: (name) => !!held[name],
    axis: (name) => axes[name],
    padName: () => padName,
  };
})();
