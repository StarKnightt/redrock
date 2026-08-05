/* The synthetic gamepad, shared.
 *
 * This was the top of tools/pad.mjs and nothing about it has changed; it moved
 * here the moment a SECOND tool needed a pad (tools/pausekey.mjs). Two fakes
 * would be two definitions of what a gamepad is, and the one that was not
 * being maintained would quietly stop resembling the one that was — which is
 * the bug where a gate passes against a device no player owns.
 *
 * `KIT` is a function to be handed to `page.evaluate`, not called here: it is
 * serialised into the page, installs `window.__padkit`, and every field on it
 * has to be reachable from inside that one function body. That is why it has
 * no imports and closes over nothing.
 *
 * The fake is honest. 17 buttons each `{pressed, touched, value}`, four axes,
 * `mapping: 'standard'`, `connected: true`, `index: 0`, and a timestamp that
 * advances on every mutation AND on every frame, because a real pad's does and
 * because a consumer is entitled to ignore one whose does not.
 *
 * The button indices are written out rather than imported from
 * src/core/input.js, deliberately: a gate that reads its expectations out of
 * the file under test cannot notice that file changing.
 */
export const B = {
  south: 0, east: 1, west: 2, north: 3,
  l1: 4, r1: 5, l2: 6, r2: 7,
  select: 8, start: 9,
  dpadUp: 12, dpadDown: 13,
};

export const KIT = () => {
  const g = window.__game;
  /* The rAF loop must not step behind a probe. Every section re-asserts this
     because a section that forgets it measures frames it did not ask for. */
  g.setPaused(true);

  const pad = {
    index: 0,
    id: 'redrock synthetic pad (standard mapping)',
    mapping: 'standard',
    connected: true,
    timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 },
      () => ({ pressed: false, touched: false, value: 0 })),
  };
  const real = navigator.getGamepads ? navigator.getGamepads.bind(navigator) : null;

  const k = {
    pad,
    rows: [],
    install() { navigator.getGamepads = () => [pad, null, null, null]; },
    uninstall() { navigator.getGamepads = real || (() => []); },
    /* Every poll of a live pad returns a fresher timestamp, whether or not
       anything on it moved. */
    stamp() { pad.timestamp += 1000 / 60; },
    axis(i, v) { pad.axes[i] = v; k.stamp(); },
    /* A digital button, as a well-behaved pad reports one. */
    btn(i, v) {
      const b = pad.buttons[i];
      b.value = v; b.pressed = v > 0.1; b.touched = b.pressed;
      k.stamp();
    },
    /* A badly-behaved one, field by field. */
    raw(i, o) { Object.assign(pad.buttons[i], o); k.stamp(); },
    clear() {
      pad.axes.fill(0);
      for (const b of pad.buttons) { b.pressed = false; b.touched = false; b.value = 0; }
      pad.connected = true;
      pad.mapping = 'standard';
      k.stamp();
    },
    step(n = 1) { for (let j = 0; j < n; j++) { k.stamp(); g.step(1 / 60); } },
    read() {
      const i = g.input;
      return {
        steer: i.steer, throttle: i.throttle, brake: i.brake, handbrake: i.handbrake,
        lookBack: i.lookBack, reset: i.resetPressed, skip: i.skipPressed,
        pause: i.pausePressed, confirm: i.confirmPressed,
        up: i.menuUpPressed, down: i.menuDownPressed,
      };
    },
    frame() { k.step(1); return k.read(); },
    /* On `window`, which is exactly the target Input attaches to. */
    key(code, down) {
      window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup',
        { code, bubbles: true, cancelable: true }));
    },
    /* Back to a car that can move: restart() arms the countdown
       unconditionally (main.js:1523), so a probe that wants the car to drive
       has to put the lights out itself. */
    grid() {
      g.autopilot(false);
      g.botInput = null;
      g.restart();
      g.countdown.skip();
      g.ending.skip();
      g.pause.close();
      k.clear();
    },
    row(name, ok, got, want) { k.rows.push({ name, ok: !!ok, got: String(got), want: String(want) }); },
    near(a, b, tol) { return Math.abs(a - b) <= tol; },
    take() { const r = k.rows; k.rows = []; return { rows: r }; },
  };
  window.__padkit = k;
  return true;
};
