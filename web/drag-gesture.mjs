// The top strip is both a drag handle and a click target, so a press has to
// resolve into either a click or a drag. A drag starts as soon as the pointer
// travels far enough (a press-and-drag, like any window title bar) or after
// holding still for a moment (a long press on a touchpad). Moving the pointer
// never cancels a press: it either starts the drag or leaves the click intact.

const PRIMARY_BUTTON = 0;
const DEFAULT_THRESHOLD = 4; // Windows' own SM_CXDRAG drag threshold.
const DEFAULT_LONG_PRESS_MS = 150;

const distance = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

export function createDragGesture({ threshold = DEFAULT_THRESHOLD, longPressMs = DEFAULT_LONG_PRESS_MS } = {}) {
  const limit = Number.isFinite(threshold) && threshold >= 0 ? threshold : DEFAULT_THRESHOLD;
  const holdMs = Number.isFinite(longPressMs) && longPressMs >= 0 ? longPressMs : DEFAULT_LONG_PRESS_MS;
  let press = null;
  let dragging = false;

  // Returns true when the press arms a long-press timer; false for any press
  // the caller must ignore (secondary buttons, a drag already in flight).
  function down(x, y, button = PRIMARY_BUTTON) {
    if (button !== PRIMARY_BUTTON || dragging) return false;
    press = { x, y };
    return true;
  }

  // Returns 'start' on the first move that leaves the threshold, else null.
  function move(x, y) {
    if (dragging || !press) return null;
    if (distance(press.x, press.y, x, y) < limit) return null;
    press = null;
    dragging = true;
    return 'start';
  }

  // Returns 'start' when the pointer is still held after the long-press delay.
  function longPress() {
    if (dragging || !press) return null;
    press = null;
    dragging = true;
    return 'start';
  }

  // Returns 'dragged' to suppress the click that follows a drag, 'click' when
  // the press never became a drag, and null when nothing was pressed.
  function up() {
    const outcome = dragging ? 'dragged' : press ? 'click' : null;
    press = null;
    dragging = false;
    return outcome;
  }

  // Releases the state without reporting an outcome, for pointercancel.
  function cancel() {
    press = null;
    dragging = false;
  }

  return {
    down,
    move,
    longPress,
    up,
    cancel,
    holdMs,
    threshold: limit,
    get dragging() { return dragging; },
    get pressing() { return press !== null; },
  };
}
