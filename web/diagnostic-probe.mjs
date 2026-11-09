'use strict';

// Which controls a diagnostic should probe. The card has two layouts and they
// share no menu button: the wide card uses #quickMenuToggle, the compact strip
// uses #compactMenu. Probing the wrong one reports a 0x0 rectangle and made an
// earlier field report look like a dead button when it was simply invisible.
//
// Pure so both layouts can be asserted without a DOM.

const WIDE = ['quickMenuToggle', 'appVersion', 'updateChip', 'dragBar'];
const COMPACT = ['compactMenu', 'compactExpand', 'compactPill', 'compactDragBar'];

export function pickProbeTargets(compact) {
  return [...(compact ? COMPACT : WIDE)];
}

// The single control whose rectangle decides "is the menu reachable here".
export function menuControlId(compact) {
  return compact ? 'compactMenu' : 'quickMenuToggle';
}
