'use strict';

function fitWindowBounds(bounds, area) {
  const maxWidth = Math.max(1, area.width - 20);
  const maxHeight = Math.max(1, area.height - 20);
  const ratio = Math.max(0.1, (bounds.width - 32) / Math.max(1, bounds.height - 32));
  let width = Math.min(bounds.width, maxWidth);
  let height = Math.min(bounds.height, maxHeight);
  if (bounds.width > maxWidth || bounds.height > maxHeight) {
    width = Math.min(width, Math.max(1, (height - 32) * ratio + 32));
    height = Math.min(height, Math.max(1, (width - 32) / ratio + 32));
  }
  width = Math.round(width); height = Math.round(height);
  return { x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))), width, height };
}
module.exports = {fitWindowBounds};
