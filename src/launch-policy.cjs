'use strict';

function heartbeat(settings, now = Date.now(), stopped = false) {
  const pauseUntil = Math.max(0, Number(settings.pauseUntil) || 0);
  const configuredKeepAlive = settings.keepAlive !== false && !stopped;
  return { at: now, keepAlive: configuredKeepAlive && pauseUntil <= now,
    configuredKeepAlive, pauseUntil: stopped ? 0 : pauseUntil, stopped };
}

function heartbeatState(beat, modifiedAt, now = Date.now(), aliveMs = 30000) {
  if (beat && typeof beat === 'object') {
    if (beat.stopped || Number(beat.pauseUntil) > now) return 'off';
    if ((beat.configuredKeepAlive ?? beat.keepAlive) === false) return 'off';
  }
  return now - modifiedAt < aliveMs ? 'alive' : 'dead';
}

module.exports = {heartbeat, heartbeatState};
