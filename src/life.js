'use strict';
// Updating and uninstalling: the same for every app in the family.

const fs = require('fs');
const os = require('os');
const path = require('path');

/** { name, cmd, repo, home } → { update(), uninstall(all) } */
module.exports = function life({ name, cmd, repo, home }) {
  const say = (s) => process.stdout.write(s + '\n');
  function installUrl(kind) {
    let site = '';
    try { site = fs.readFileSync(path.join(home(), 'hub'), 'utf8').trim(); } catch { /* installed from GitHub */ }
    if (/^https?:\/\//.test(site)) return `${site.replace(/\/+$/, '')}/${cmd}/install.${kind}`;
    return `https://raw.githubusercontent.com/${repo}/main/install.${kind}`;
  }
  function update() {
    const { spawnSync } = require('child_process');
    const win = process.platform === 'win32';
    const url = installUrl(win ? 'ps1' : 'sh');
    say(`  Updating ${name} from ${url}`);
    const r = win
      ? spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `irm ${url} | iex`], { stdio: 'inherit' })
      : spawnSync('sh', ['-c', `curl -fsSL "${url}" | sh`], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('The update did not finish. Your current version still works.');
  }
  function uninstall(all) {
    const root = home();
    let launcher = '';
    try { launcher = fs.readFileSync(path.join(root, 'launcher'), 'utf8').trim(); } catch { /* not installed by the installer */ }
    for (const p of [path.join(root, 'app'), path.join(root, 'node')]) fs.rmSync(p, { recursive: true, force: true });
    if (launcher && new RegExp(`${cmd}(\\.cmd)?$`).test(launcher)) fs.rmSync(launcher, { force: true });
    if (all) fs.rmSync(root, { recursive: true, force: true });
    say(`  ${name} is uninstalled.${all ? '' : ` Your settings are still in ${root.replace(os.homedir(), '~')} (add --all to remove them too).`}`);
  }
  return { update, uninstall, installUrl };
};
