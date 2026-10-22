const COLORS = ['#a18bff', '#61d7e7', '#f2af75', '#8edcb9', '#dd9ce5', '#7fa9ff', '#f0cd76', '#ee8f9f'];
const positive = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

export function modelValue(data, metric = 'total') {
  if (metric === 'input') return positive(data?.input);
  if (metric === 'output') return positive(data?.output);
  if (metric === 'cache') return positive(data?.cache_read);
  return ['input', 'output', 'cache_read', 'cache_write'].reduce((sum, key) => sum + positive(data?.[key]), 0);
}

export function modelColor(key) {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

export function modelUsage(data, metric = 'total') {
  const total = modelValue(data, metric);
  const rows = (Array.isArray(data?.models) ? data.models : []).map((item, index) => {
    const key = String(item.id || `${item.provider || ''}/${item.model || item.name || index}/${item.host || ''}`);
    const value = modelValue(item, metric);
    return { key, name: String(item.model || item.name || '未命名模型'), provider: String(item.provider || ''),
      value, share: total > 0 ? value / total : 0, color: modelColor(key), calls: positive(item.calls) };
  }).sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  const sum = rows.reduce((n, row) => n + row.value, 0);
  return { total, rows, consistent: sum <= total, unassigned: Math.max(0, total - sum) };
}

const NS = 'http://www.w3.org/2000/svg';
export function paintModelTracks(svg, rows, width, height, spacing = 3) {
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const existing = new Map([...svg.children].map(node => [node.dataset.key, node]));
  const wanted = new Set(rows.map(row => row.key));
  for (const [key, node] of existing) if (!wanted.has(key)) node.remove();
  rows.forEach((row, index) => {
    let group = existing.get(row.key);
    if (!group) {
      group = document.createElementNS(NS, 'g');
      group.dataset.key = row.key;
      for (const name of ['base', 'value']) {
        const p = document.createElementNS(NS, 'path');
        p.setAttribute('class', `model-track-${name}`);
        p.setAttribute('pathLength', '100');
        group.append(p);
      }
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('class', 'model-track-dot');
      dot.setAttribute('r', spacing > 3 ? '2.2' : '1.3');
      group.append(dot);
      svg.append(group);
    }
    const inset = 1.5 + index * spacing;
    const radius = Math.max(1, height / 2 - inset);
    const left = inset, right = width - inset, y = height / 2;
    const d = `M ${width / 2} ${inset} H ${right - radius} A ${radius} ${radius} 0 0 1 ${right} ${y} A ${radius} ${radius} 0 0 1 ${right - radius} ${height - inset} H ${left + radius} A ${radius} ${radius} 0 0 1 ${left} ${y} A ${radius} ${radius} 0 0 1 ${left + radius} ${inset} Z`;
    group.style.setProperty('--model-color', row.color);
    const [base, value, dot] = group.children;
    base.setAttribute('d', d); value.setAttribute('d', d);
    const share = Math.max(0, Math.min(1, row.share));
    value.style.strokeDasharray = `${share * 100} 100`;
    value.style.visibility = share > 0 ? '' : 'hidden';
    const point = value.getPointAtLength(value.getTotalLength() * share);
    dot.setAttribute('cx', point.x); dot.setAttribute('cy', point.y);
    dot.style.display = share > 0 ? '' : 'none';
  });
}
