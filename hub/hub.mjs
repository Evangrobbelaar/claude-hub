#!/usr/bin/env node
// Claude Hub worker.
//
// Instructions sent from the phone app are GitHub issues labelled "hub" on repos tagged with the
// "claude-hub" topic. This worker picks them up, runs Claude Code on a clean clone of the repo,
// pushes the result to the default branch, optionally deploys, and replies on the issue.
//
// The same file runs on the VPS (always on) and on the laptop (starts at login, also pulls your
// local project folders so they are up to date when you sit down).
//
// Usage: node hub.mjs            run forever
//        node hub.mjs --once     one poll + sync, then exit
//        node hub.mjs --sync     only pull local project folders, then exit

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.HUB_CONFIG || path.join(HERE, 'hub.config.json');
const VERSION = '1.0.0';

const cfg = {
  machine: os.hostname(),
  topic: 'claude-hub',
  label: 'hub',
  pollSeconds: 20,
  claimDelaySeconds: 0,      // laptop waits so the VPS gets first pick
  staleMinutes: 60,          // a "working" claim older than this is considered dead
  taskTimeoutMinutes: 40,
  syncMinutes: 10,
  heartbeatMinutes: 2,
  workDir: path.join(os.homedir(), '.claude-hub', 'work'),
  localProjects: {},         // repo name -> local folder (or array of folders) to keep pulled
  deploy: {},                // repo name -> shell command run after a successful push
  claudeArgs: [],
  notify: process.platform === 'win32',
  ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')),
};

const STATE_PATH = path.join(path.dirname(cfg.workDir), 'state.json');
const LOG_PATH = path.join(path.dirname(cfg.workDir), 'hub.log');
fs.mkdirSync(cfg.workDir, { recursive: true });

const BOT = '<!-- hub:';
const isBot = (c) => (c.body || '').startsWith(BOT);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + '\n');
    if (fs.statSync(LOG_PATH).size > 5e6) fs.renameSync(LOG_PATH, LOG_PATH + '.old');
  } catch {}
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
function writeState(s) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

// ---------------------------------------------------------------- GitHub

function resolveToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim(); } catch {}
  throw new Error('No GitHub token: set GITHUB_TOKEN or log in with `gh auth login`.');
}
const TOKEN = resolveToken();

async function gh(method, url, body) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, {
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'claude-hub',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (attempt < 4) { await sleep(2000 * attempt); continue; }
      throw e;
    }
    if (res.status >= 500 && attempt < 4) { await sleep(2000 * attempt); continue; }
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`GitHub ${method} ${url} -> ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }
}

let me;
let projects = new Map(); // full_name -> repo
let projectsAt = 0;

async function refreshProjects(force = false) {
  if (!force && Date.now() - projectsAt < 2 * 60e3) return;
  const found = new Map();
  for (let page = 1; ; page++) {
    const repos = await gh('GET', `/user/repos?affiliation=owner,collaborator&per_page=100&page=${page}`);
    for (const r of repos) if ((r.topics || []).includes(cfg.topic)) found.set(r.full_name, r);
    if (repos.length < 100) break;
  }
  for (const r of found.values()) if (!projects.has(r.full_name)) await ensureLabels(r.full_name);
  projects = found;
  projectsAt = Date.now();
}

const LABELS = [
  ['hub', '7c3aed', 'Instruction for Claude Hub'],
  ['hub:working', 'f59e0b', 'Claude Hub is working on this'],
  ['hub:failed', 'dc2626', 'Claude Hub could not finish this'],
];
async function ensureLabels(fullName) {
  for (const [name, color, description] of LABELS) {
    try { await gh('POST', `/repos/${fullName}/labels`, { name, color, description }); }
    catch (e) { if (e.status !== 422) log('label', fullName, name, e.message); }
  }
}

const hasLabel = (issue, name) => issue.labels.some((l) => (l.name || l) === name);
const removeLabel = (fullName, n, name) =>
  gh('DELETE', `/repos/${fullName}/issues/${n}/labels/${encodeURIComponent(name)}`).catch(() => {});
const listComments = (fullName, n) => gh('GET', `/repos/${fullName}/issues/${n}/comments?per_page=100`);
const comment = (fullName, n, body) => gh('POST', `/repos/${fullName}/issues/${n}/comments`, { body });

// ---------------------------------------------------------------- queue

// An issue needs work when its latest message is from the user (not the hub) and nobody holds a
// live claim on it. Status lives in labels and open/closed state:
//   open, no hub:working  -> queued      open + hub:working -> working
//   open + hub:failed     -> failed      closed             -> done
function needsWork(issue, comments) {
  const last = comments[comments.length - 1];
  const lastUserAt = new Date([...comments].reverse().find((c) => !isBot(c))?.created_at || issue.created_at);
  if (hasLabel(issue, 'hub:working')) {
    const claim = [...comments].reverse().find((c) => c.body.startsWith(`${BOT}claim`));
    const claimedAt = claim ? new Date(claim.created_at) : lastUserAt;
    return Date.now() - claimedAt > cfg.staleMinutes * 60e3 ? 'stale' : false;
  }
  if (last && isBot(last)) return false;
  if (Date.now() - lastUserAt < cfg.claimDelaySeconds * 1000) return false;
  return true;
}

async function claim(fullName, issue) {
  const id = `${cfg.machine}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  await gh('POST', `/repos/${fullName}/issues/${issue.number}/labels`, { labels: ['hub:working'] });
  if (hasLabel(issue, 'hub:failed')) await removeLabel(fullName, issue.number, 'hub:failed');
  const mine = await comment(fullName, issue.number, `${BOT}claim ${id} -->\n🛠️ **${cfg.machine}** is working on this…`);
  await sleep(4000);
  // If two machines claimed at once, the earliest recent claim after the latest user message wins.
  const comments = await listComments(fullName, issue.number);
  const lastUser = comments.findLastIndex((c) => !isBot(c));
  const recent = new Date(mine.created_at) - 120e3;
  const first = comments.slice(lastUser + 1)
    .find((c) => c.body.startsWith(`${BOT}claim`) && new Date(c.created_at) >= recent);
  if (first && first.id !== mine.id) {
    await gh('DELETE', `/repos/${fullName}/issues/comments/${mine.id}`).catch(() => {});
    return null;
  }
  return comments;
}

let busy = null;

// One request across all repos when the token allows it, otherwise one per project.
let perRepo = false;
async function listHubIssues(state, since) {
  const q = `labels=${cfg.label}&state=${state}&per_page=100&sort=created&direction=asc${since ? `&since=${since}` : ''}`;
  if (!perRepo) {
    try { return await gh('GET', `/issues?filter=all&${q}`); }
    catch (e) { if (e.status !== 403 && e.status !== 404) throw e; perRepo = true; }
  }
  const all = [];
  for (const r of projects.values()) {
    for (const i of await gh('GET', `/repos/${r.full_name}/issues?${q}`)) all.push({ ...i, repository: r });
  }
  return all;
}

// Child processes (Claude, deploys) must not inherit the hub's GitHub token.
const childEnv = { ...process.env };
delete childEnv.GITHUB_TOKEN;
delete childEnv.GH_TOKEN;

async function poll() {
  await refreshProjects();
  if (!projects.size) return;
  for (const issue of await listHubIssues('open')) {
    if (issue.pull_request) continue;
    const fullName = issue.repository?.full_name;
    if (!projects.has(fullName)) continue;
    if (issue.user.login !== me.login) continue; // only the owner can give orders
    const comments = issue.comments ? await listComments(fullName, issue.number) : [];
    const verdict = needsWork(issue, comments);
    if (!verdict) continue;
    if (verdict === 'stale') {
      log('stale claim, retrying', fullName, `#${issue.number}`);
      await removeLabel(fullName, issue.number, 'hub:working');
      issue.labels = issue.labels.filter((l) => l.name !== 'hub:working');
    }
    const thread = await claim(fullName, issue);
    if (!thread) { log('lost claim race', fullName, `#${issue.number}`); continue; }
    await runTask(projects.get(fullName), issue, thread);
  }
}

// ---------------------------------------------------------------- running a task

const authHeader = 'AUTHORIZATION: basic ' + Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
const gitEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
  GIT_CONFIG_VALUE_0: authHeader,
  GIT_CONFIG_KEY_1: 'credential.helper',
  GIT_CONFIG_VALUE_1: '',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function prepareClone(repo) {
  const dir = path.join(cfg.workDir, repo.name);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    git(cfg.workDir, 'clone', `https://github.com/${repo.full_name}.git`, dir);
  }
  git(dir, 'fetch', '--prune', 'origin');
  git(dir, 'checkout', '-f', '-B', repo.default_branch, `origin/${repo.default_branch}`);
  git(dir, 'reset', '--hard', `origin/${repo.default_branch}`);
  git(dir, 'clean', '-fd'); // keeps ignored files such as node_modules
  git(dir, 'config', 'user.name', cfg.gitName || `Claude Hub (${cfg.machine})`);
  git(dir, 'config', 'user.email', cfg.gitEmail || `${me.login}@users.noreply.github.com`);
  return dir;
}

function buildPrompt(repo, issue, thread, dir) {
  const convo = [`### Instruction: ${issue.title}\n${issue.body || ''}`];
  for (const c of thread) {
    if (c.body.startsWith(`${BOT}claim`)) continue;
    if (isBot(c)) convo.push(`### Your earlier reply\n${c.body.replace(/^<!--.*?-->\s*/s, '')}`);
    else convo.push(`### User\n${c.body}`);
  }
  return `You are Claude Code running unattended inside "Claude Hub". The instruction below was sent from the user's phone; they are not at a computer and cannot answer questions until you reply.

Project: ${repo.full_name} (branch ${repo.default_branch})
Working copy: ${dir}
Machine: ${cfg.machine} (${process.platform})

Rules:
- Do what the latest message asks. If something is ambiguous, make the most sensible choice and state the assumption.
- If the project has tests or a build, run them and fix anything you broke.
- Commit your work with clear commit messages. Do not push, switch branches or change git remotes: the hub pushes to ${repo.default_branch} for you.
- Never print secrets, tokens or passwords.
- If the message is a question rather than a change request, just answer it.
- Finish with a short summary written for a phone screen: what you changed, anything the user must do, and any assumptions. Plain language, no long code blocks.

Conversation so far (oldest first):

${convo.join('\n\n')}`;
}

function runClaude(dir, prompt) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions', ...cfg.claudeArgs];
    const child = spawn(cfg.claudePath || 'claude', args, { cwd: dir, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => { err += '\nTimed out.'; child.kill('SIGKILL'); }, cfg.taskTimeoutMinutes * 60e3);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, text: `Could not start Claude: ${e.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let json;
      try { json = JSON.parse(out.trim().split('\n').pop()); } catch {}
      if (json && !json.is_error) return resolve({ ok: true, text: json.result || '(no summary)', cost: json.total_cost_usd, turns: json.num_turns });
      resolve({ ok: false, text: (json?.result || err || out || `Claude exited with code ${code}`).slice(-3000) });
    });
    child.stdin.end(prompt);
  });
}

function runShell(cmd, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, env: childEnv });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 20 * 60e3);
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out: out.slice(-1500) }); });
  });
}

function pushWithRetry(dir, branch) {
  try { git(dir, 'push', 'origin', `HEAD:${branch}`); return; } catch {}
  git(dir, 'pull', '--rebase', 'origin', branch); // someone pushed meanwhile
  git(dir, 'push', 'origin', `HEAD:${branch}`);
}

async function runTask(repo, issue, thread) {
  const fullName = repo.full_name;
  const started = Date.now();
  busy = `${repo.name} #${issue.number}`;
  heartbeat().catch(() => {});
  log('start', fullName, `#${issue.number}`, issue.title);
  let body, ok = false;
  try {
    const dir = prepareClone(repo);
    const before = git(dir, 'rev-parse', 'HEAD');
    const result = await runClaude(dir, buildPrompt(repo, issue, thread, dir));

    if (git(dir, 'status', '--porcelain')) {
      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', `${issue.title} (#${issue.number})`);
    }
    const commits = git(dir, 'log', '--format=%H %s', `${before}..HEAD`).split('\n').filter(Boolean);
    let pushNote = '', deployNote = '';
    if (commits.length) {
      try {
        pushWithRetry(dir, repo.default_branch);
        pushNote = `**Pushed to \`${repo.default_branch}\`:**\n` + commits.reverse()
          .map((l) => `- [\`${l.slice(0, 7)}\`](https://github.com/${fullName}/commit/${l.slice(0, 40)}) ${l.slice(41)}`).join('\n');
        const deployCmd = cfg.deploy[repo.name];
        if (deployCmd) {
          const d = await runShell(deployCmd, dir);
          deployNote = d.ok ? '🚀 **Deployed.**' : `⚠️ **Deploy failed:**\n\`\`\`\n${d.out}\n\`\`\``;
        }
      } catch (e) {
        result.ok = false;
        pushNote = `⚠️ **Could not push:** ${e.message.slice(0, 500)}`;
      }
    } else if (result.ok) {
      pushNote = '_No code changes._';
    }
    ok = result.ok;
    const mins = ((Date.now() - started) / 60e3).toFixed(1);
    const meta = `${cfg.machine} · ${mins} min`;
    body = `${BOT}result ${cfg.machine} ${ok ? 'ok' : 'fail'} -->\n${ok ? '✅ **Done**' : '❌ **Not finished**'} · ${meta}\n\n${result.text}\n\n${pushNote}\n\n${deployNote}`.trim();
  } catch (e) {
    body = `${BOT}result ${cfg.machine} fail -->\n❌ **Hub error** on ${cfg.machine}\n\n\`\`\`\n${String(e.stderr || e.message).slice(-1500)}\n\`\`\``;
  }
  // Never let a token end up in a public comment.
  body = body.split(TOKEN).join('***');
  await comment(fullName, issue.number, body);
  await removeLabel(fullName, issue.number, 'hub:working');
  if (ok) await gh('PATCH', `/repos/${fullName}/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' });
  else await gh('POST', `/repos/${fullName}/issues/${issue.number}/labels`, { labels: ['hub:failed'] });
  log(ok ? 'done' : 'failed', fullName, `#${issue.number}`);
  busy = null;
  heartbeat().catch(() => {});
  if (Object.keys(cfg.localProjects).length) await syncLocal(false);
}

// ---------------------------------------------------------------- laptop: keep local folders pulled

async function syncLocal(announce) {
  const pulled = [], skipped = [];
  for (const [name, dirs] of Object.entries(cfg.localProjects)) {
    for (const dir of [].concat(dirs)) {
      try {
        if (!fs.existsSync(path.join(dir, '.git'))) continue;
        git(dir, 'fetch', 'origin');
        const branch = git(dir, 'branch', '--show-current');
        let upstream;
        try { upstream = git(dir, 'rev-parse', '--abbrev-ref', '@{u}'); } catch { skipped.push(`${name}: branch "${branch}" has no upstream`); continue; }
        const behind = Number(git(dir, 'rev-list', '--count', `HEAD..${upstream}`));
        if (!behind) continue;
        if (git(dir, 'status', '--porcelain', '--untracked-files=no')) { skipped.push(`${name}: ${behind} new commit(s), not pulled (you have unsaved local edits)`); continue; }
        git(dir, 'merge', '--ff-only', upstream);
        pulled.push(`${name} (+${behind})`);
      } catch (e) {
        skipped.push(`${name}: ${String(e.stderr || e.message).split('\n')[0]}`);
      }
    }
  }
  if (pulled.length) log('pulled', pulled.join(', '));
  for (const s of skipped) log('sync skipped', s);

  if (!announce) return;
  // Tell the user what happened while they were away.
  const state = readState();
  const since = state.lastSeen || new Date(Date.now() - 7 * 864e5).toISOString();
  let finished = [];
  try {
    const done = await listHubIssues('closed', since);
    finished = done.filter((i) => i.closed_at > since && projects.has(i.repository?.full_name)).map((i) => `${i.repository.name}: ${i.title}`);
  } catch {}
  state.lastSeen = new Date().toISOString();
  writeState(state);
  const lines = [];
  if (finished.length) lines.push(`${finished.length} done from your phone: ${finished.slice(0, 3).join('; ')}`);
  if (pulled.length) lines.push(`Pulled: ${pulled.join(', ')}`);
  if (skipped.length) lines.push(`Check: ${skipped.slice(0, 2).join('; ')}`);
  if (lines.length) notify('Claude Hub', lines.join('\n'));
}

function notify(title, text) {
  if (!cfg.notify || process.platform !== 'win32') return;
  const ps = `
$ErrorActionPreference='SilentlyContinue'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $x.GetElementsByTagName('text')
$t.Item(0).AppendChild($x.CreateTextNode($env:HUB_TITLE)) > $null
$t.Item(1).AppendChild($x.CreateTextNode($env:HUB_TEXT)) > $null
$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))`;
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    env: { ...process.env, HUB_TITLE: title, HUB_TEXT: text.slice(0, 400) }, stdio: 'ignore', windowsHide: true,
  }).on('error', () => {});
}

// ---------------------------------------------------------------- heartbeat (shown in the phone app)

let statusGist = null;
async function heartbeat() {
  if (!statusGist) {
    const gists = await gh('GET', '/gists?per_page=100');
    statusGist = gists.find((g) => g.files['claude-hub-status.md'])?.id;
    if (!statusGist) {
      statusGist = (await gh('POST', '/gists', {
        description: 'Claude Hub machine status', public: false,
        files: { 'claude-hub-status.md': { content: 'Heartbeats from Claude Hub workers. Read by the phone app.' } },
      })).id;
    }
  }
  const content = JSON.stringify({ machine: cfg.machine, at: new Date().toISOString(), busy, version: VERSION, platform: process.platform }, null, 2);
  await gh('PATCH', `/gists/${statusGist}`, { files: { [`machine-${cfg.machine}.json`]: { content } } });
}

// ---------------------------------------------------------------- main

async function main() {
  const mode = process.argv[2];
  me = await gh('GET', '/user');
  log(`Claude Hub ${VERSION} on ${cfg.machine} as ${me.login}`);
  await refreshProjects(true);
  log(`projects: ${[...projects.keys()].join(', ') || '(none tagged with topic "' + cfg.topic + '")'}`);

  if (Object.keys(cfg.localProjects).length) await syncLocal(true);
  if (mode === '--sync') return;
  await heartbeat().catch((e) => log('heartbeat', e.message));

  let lastSync = Date.now(), lastBeat = Date.now();
  for (;;) {
    try { await poll(); } catch (e) { log('poll error', e.message); busy = null; }
    if (mode === '--once') return;
    if (Object.keys(cfg.localProjects).length && Date.now() - lastSync > cfg.syncMinutes * 60e3) {
      await syncLocal(false).catch((e) => log('sync error', e.message));
      lastSync = Date.now();
    }
    if (Date.now() - lastBeat > cfg.heartbeatMinutes * 60e3) {
      await heartbeat().catch((e) => log('heartbeat', e.message));
      lastBeat = Date.now();
    }
    await sleep(cfg.pollSeconds * 1000);
  }
}

main().catch((e) => { log('fatal', e.stack || e.message); process.exit(1); });
