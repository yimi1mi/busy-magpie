const bytes = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

export function downloadSize(transferred, total) {
  const done = bytes(transferred), size = bytes(total);
  const basis = size || done;
  const power = Math.min(3, basis > 0 ? Math.floor(Math.log(basis) / Math.log(1024)) : 0);
  const unit = ['B', 'KB', 'MB', 'GB'][power];
  const scale = 1024 ** power;
  const format = value => power === 0 ? String(Math.round(value)) : (value / scale).toFixed(1);
  return size > 0
    ? { text: `${format(done)} ${unit} / ${format(size)} ${unit}`, compact: `${format(done)}/${format(size)} ${unit}` }
    : { text: `${format(done)} ${unit} / 未知大小`, compact: `${format(done)} ${unit} / ?` };
}
