export function acceleratorFromEvent(event, platform = 'win32') {
  if (['Control','Alt','Shift','Meta','Process','Dead'].includes(event.key)) return '';
  const modifiers = [];
  if (event.ctrlKey) modifiers.push('Control');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push(platform === 'darwin' ? 'Command' : 'Super');
  const named = { ' ': 'Space', ArrowUp:'Up', ArrowDown:'Down', ArrowLeft:'Left', ArrowRight:'Right', '+':'Plus' };
  const key = /^Key[A-Z]$/.test(event.code || '') ? event.code.slice(3)
    : /^Digit\d$/.test(event.code || '') ? event.code.slice(5)
      : named[event.key] || (/^[a-z0-9]$/i.test(event.key || '') ? event.key.toUpperCase() : event.key);
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|Space|Up|Down|Left|Right|Plus|Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown)$/.test(key || '')) return '';
  if (!modifiers.length && !/^F\d+$/.test(key)) return '';
  return [...modifiers,key].join('+');
}
