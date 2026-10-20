// Small Chrome DevTools Protocol helper for checking the widget during
// development. It is not part of the shipped application.
//
//   node tools/cdp.mjs eval "document.body.innerText"
//   node tools/cdp.mjs shot "artifacts/widget.png"

import fs from 'node:fs';

const port = process.env.CDP_PORT || '9223';
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const match = process.env.CDP_MATCH || '';
const page = targets.find((target) => target.type === 'page' && target.url.includes(match));
if (!page) throw new Error(`no page target${match ? ` matching ${match}` : ''}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();

const opened = new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  }
});

function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await opened;
const command = process.argv[2] || 'eval';
const argument = process.argv[3] || 'document.body.innerText';

if (command === 'eval') {
  const result = await send('Runtime.evaluate', {
    expression: argument,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log(JSON.stringify(result.result?.value ?? result.result, null, 2));
} else if (command === 'shot') {
  const scale = Number(process.env.CDP_SCALE || 1);
  const size = await send('Runtime.evaluate', {
    expression: '({ width: innerWidth, height: innerHeight })',
    returnByValue: true,
  });
  const result = await send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    omitBackground: true,
    ...(scale > 1 ? {
      clip: {
        x: 0,
        y: 0,
        width: size.result.value.width,
        height: size.result.value.height,
        scale,
      },
    } : {}),
  });
  const dir = argument.split(/[\\/]/).slice(0, -1).join('/') || '.';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(argument, Buffer.from(result.data, 'base64'));
  console.log(argument);
} else {
  throw new Error(`unknown command ${command}`);
}

ws.close();
