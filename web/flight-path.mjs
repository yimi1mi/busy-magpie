// The Routing page's horizontal wires meet halfway, with horizontal
// tangents at both cards. The same curve is used for the wire and its bird.
export function wireCurve(from, to) {
  const mid = (from.x + to.x) / 2;
  return `M ${from.x} ${from.y} C ${mid} ${from.y} ${mid} ${to.y} ${to.x} ${to.y}`;
}

// Routing's through-magpie connector follows the incoming/outgoing tangents.
// Returning to the same side makes a small turn inside the hub.
export function hubCurve(from, to, size) {
  const dx = to.x - from.x, dy = to.y - from.y, distance = Math.hypot(dx, dy);
  let c1, c2;
  if (distance < 4) {
    const reach = size * 0.42, bend = reach * 0.6;
    const nx = from.ty, ny = -from.tx;
    c1 = [from.x + from.tx * reach - nx * bend, from.y + from.ty * reach - ny * bend];
    c2 = [to.x - to.tx * reach + nx * bend, to.y - to.ty * reach + ny * bend];
  } else {
    const reach = distance * 0.38, bend = Math.min(16, distance * 0.12);
    const nx = dy / distance, ny = -dx / distance;
    c1 = [from.x + from.tx * reach + nx * bend, from.y + from.ty * reach + ny * bend];
    c2 = [to.x - to.tx * reach + nx * bend, to.y - to.ty * reach + ny * bend];
  }
  return `M ${from.x} ${from.y} C ${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${to.x} ${to.y}`;
}

export const glideProgress = progress => (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, progress)))) / 2;
