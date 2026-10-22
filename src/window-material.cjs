'use strict';

function windowMaterial(platform, release) {
  const [major, , build] = String(release).split('.').map(Number);
  if (platform === 'win32' && (major > 10 || (major === 10 && build >= 22621))) {
    return { kind: 'acrylic', options: { transparent: false, backgroundMaterial: 'acrylic', roundedCorners: true, hasShadow: true } };
  }
  if (platform === 'darwin') {
    return { kind: 'vibrancy', options: { transparent: true, vibrancy: 'under-window', visualEffectState: 'active', roundedCorners: true, hasShadow: true } };
  }
  return { kind: 'none', options: { transparent: true, roundedCorners: false, hasShadow: false } };
}

module.exports = { windowMaterial };
