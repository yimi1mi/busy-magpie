'use strict';

// Decides whether a click should dismiss the quick menu. Kept free of DOM
// globals so the split-state failure can be tested: a stale `open=true` must
// never swallow the pointerdown that drag / resize / the dots button need.
//
// `target` only has to provide `closest(selector)` and be accepted by the
// `contains` methods of menu/button; that is enough for both real Elements and
// a small test double.

const HANDOFF = '.drag-bar, .resize-handle, [data-menu-action], #compactPill, #compactExpand, #compactMenu';

export function shouldDismissMenu(open, target, menu, button) {
  if (!open) return false;
  if (!target || typeof target.closest !== 'function') return false;
  if (menu?.contains?.(target) || button?.contains?.(target)) return false;
  // Gestures and compact controls own their own events even while the menu is
  // showing. Only a click on the card's plain surface dismisses it.
  if (target.closest(HANDOFF)) return false;
  return Boolean(target.closest('#card'));
}

export { HANDOFF as MENU_HANDOFF_SELECTOR };
