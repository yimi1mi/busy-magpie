const triesOf = route => Array.isArray(route?.tries) ? route.tries : [];
const active = route => Boolean(route) && (!route.done || triesOf(route).some(attempt => !attempt.done));
const succeeded = attempt => Number(attempt.status) < 400 && !attempt.fail;

// One request owns one playback, including every attempt at the same account.
// Waiting is woken by a new trace or cancellation, never by an elapsed timeout.
export class RequestFlight {
  constructor(route) {
    this.id = String(route.id);
    this.route = route;
    this.active = true;
    this.attempt = -1;
    this.location = 'agent';
    this.waiters = new Set();
  }

  update(route) {
    this.route = route;
    this.wake();
  }

  cancel() {
    this.active = false;
    this.wake();
  }

  wake() {
    for (const check of [...this.waiters]) check();
  }

  until(predicate) {
    return new Promise(resolve => {
      const check = () => {
        if (!this.active || predicate(this.route)) {
          this.waiters.delete(check);
          resolve(this.active);
        }
      };
      this.waiters.add(check);
      check();
    });
  }

  async play(move, hold) {
    const travel = async (to, ms, error = false) => {
      if (!this.active) return false;
      await move({ from: this.location, to, attempt: this.attempt, ms, error });
      if (!this.active) return false;
      this.location = to;
      return true;
    };
    try {
      if (!triesOf(this.route).length) {
        if (!await travel('hub', 620)) return;
        hold('hub');
      }
      for (let i = 0; this.active; i++) {
        if (!await this.until(route => triesOf(route).length > i || route.done)) return;
        if (!triesOf(this.route)[i]) return;
        this.attempt = i;
        if (!await travel('account', this.location === 'agent' ? 1400 : 900)) return;
        hold('account');
        if (!await this.until(route => Boolean(triesOf(route)[i]?.done))) return;
        const attempt = triesOf(this.route)[i];
        if (succeeded(attempt)) {
          if (!await this.until(route => Boolean(route.done))) return;
          await travel('agent', 1400);
          return;
        }
        // The trace's retry/rest flags say whether the error returns to
        // magpie for another attempt, or is the answer the agent receives.
        const hasNext = triesOf(this.route).length > i + 1;
        const retry = hasNext || attempt.rest || (attempt.again && !attempt.gone);
        if (!retry) {
          await travel('agent', 1350, true);
          return;
        }
        if (!await travel('hub', 620, true)) return;
        hold('hub');
      }
    } finally {
      this.cancel();
    }
  }
}

// Discovery is separate from the cards: folding requests into one row must
// not fold their playbacks. Initial history stays still; later new IDs play
// even when a fast request is already complete in its first snapshot.
export class FlightBook {
  constructor() {
    this.sessions = new Map();
    this.seen = new Set();
    this.initialized = false;
    this.enabled = false;
    this.pid = 0;
    this.seq = 0;
  }

  stop() {
    for (const session of this.sessions.values()) session.cancel();
    this.sessions.clear();
    this.enabled = false;
  }

  update(trace, enabled) {
    if (!trace) { this.stop(); return; }
    const pid = Number(trace.pid || trace.by?.pid) || 0;
    const seq = Number(trace.seq) || 0;
    if (this.initialized && ((pid && this.pid && pid !== this.pid) || seq < this.seq)) {
      this.stop();
      this.seen.clear();
      this.initialized = false;
    }
    const routes = Array.isArray(trace.routes) ? trace.routes : [];
    const current = new Map(routes.map(route => [String(route.id), route]));
    const resuming = !this.enabled;
    for (const [id, session] of this.sessions) {
      if (enabled && current.has(id)) session.update(current.get(id));
      else { session.cancel(); this.sessions.delete(id); }
    }
    if (enabled) {
      for (const [id, route] of current) {
        if (this.sessions.has(id)) continue;
        const fresh = this.initialized && !this.seen.has(id);
        if ((fresh && !resuming) || ((!this.initialized || resuming) && active(route))) {
          this.sessions.set(id, new RequestFlight(route));
        }
      }
    }
    this.seen = new Set(current.keys());
    this.initialized = true;
    this.enabled = Boolean(enabled);
    this.pid = pid;
    this.seq = seq;
  }

  finish(session) {
    if (this.sessions.get(session.id) !== session) return false;
    this.sessions.delete(session.id);
    return true;
  }
}
