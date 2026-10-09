const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = __dirname;
const URL = 'http://127.0.0.1:5173';
const open = () => spawn('cmd.exe', ['/d', '/c', 'start', '""', URL], { windowsHide: true, stdio: 'ignore' }).unref();
function lanUrls() {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === 'IPv4' && !item.internal) urls.push(`http://${item.address}:5173`);
    }
  }
  return [...new Set(urls)];
}
function printAddresses() {
  console.log(`本机访问: ${URL}`);
  const urls = lanUrls();
  if (urls.length) console.log(`局域网访问: ${urls.join('  ')}`);
  else console.log('局域网访问: 未找到本机 IPv4 地址，请检查网络连接。');
  console.log('若其他设备无法打开，请在 Windows 防火墙中允许 Node.js 通过“专用网络”。');
}
async function check() {
  try {
    const res = await fetch(URL, { signal: AbortSignal.timeout(1200) });
    const html = await res.text();
    return html.includes('竞技机器人') && html.includes('root') ? 'ours' : 'occupied';
  } catch { return 'free'; }
}
function npm(args) {
  const npmPath = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const result = spawnSync(process.execPath, [npmPath, ...args], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed. ${result.error?.message || ''}`);
}
(async () => {
  const state = await check();
  if (state === 'ours') { printAddresses(); open(); return; }
  if (state === 'occupied') throw new Error('Port 5173 is used by another app. Close that app, then retry.');
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'))) npm(['ci']);
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) npm(['run', 'build']);
  const logs = path.join(ROOT, 'output', 'runtime');
  fs.mkdirSync(logs, { recursive: true });
  const out = fs.openSync(path.join(logs, 'server.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--host', '0.0.0.0', '--port', '5173', '--strictPort'], { cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', out, out] });
  child.on('error', e => { console.error(e.message); process.exitCode = 1; });
  child.unref();
  fs.closeSync(out);
  fs.writeFileSync(path.join(logs, 'server.pid'), String(child.pid));
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (await check() === 'ours') { printAddresses(); open(); return; }
  }
  throw new Error('The local server did not start. See output/runtime/server.log.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
