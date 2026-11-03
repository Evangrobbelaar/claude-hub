// Claude Hub phone app. Talks straight to the GitHub API with a token kept on this device only.
// Projects = repos with the "claude-hub" topic. Instructions = issues labelled "hub".

const TOPIC = 'claude-hub';
const LABEL = 'hub';
const BOT = '<!-- hub:';

const $ = (sel) => document.querySelector(sel);
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
let token = store.get('hub.token');
let me = null;
let projects = [];
let refreshTimer = null;

// ------------------------------------------------------------------ GitHub

async function gh(method, path, body) {
  const res = await fetch(path.startsWith('http') ? path : `https://api.github.com${path}`, {
    method,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.message || `GitHub error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function loadProjects() {
  const all = [];
  for (let page = 1; ; page++) {
    const repos = await gh('GET', `/user/repos?affiliation=owner,collaborator&sort=pushed&per_page=100&page=${page}`);
    all.push(...repos);
    if (repos.length < 100) break;
  }
  projects = all.filter((r) => (r.topics || []).includes(TOPIC));
  return all;
}

function statusOf(issue) {
  const names = issue.labels.map((l) => l.name);
  if (issue.state === 'closed') return 'done';
  if (names.includes('hub:working')) return 'working';
  if (names.includes('hub:failed')) return 'failed';
  return 'queued';
}
const STATUS_TEXT = { queued: 'Waiting', working: 'Working', done: 'Done', failed: 'Needs you' };
const badge = (s) => `<span class="badge ${s}">${s === 'working' ? '<span class="spinner" style="width:10px;height:10px;border-width:1.5px"></span> ' : ''}${STATUS_TEXT[s]}</span>`;

function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function md(text) {
  const clean = String(text || '').replace(/^<!--.*?-->\s*/s, '');
  if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(clean, { breaks: true }));
  return `<p>${esc(clean).replace(/\n/g, '<br>')}</p>`;
}

async function ensureLabels(fullName) {
  const labels = [['hub', '7c3aed'], ['hub:working', 'f59e0b'], ['hub:failed', 'dc2626']];
  for (const [name, color] of labels) {
    try { await gh('POST', `/repos/${fullName}/labels`, { name, color }); } catch (e) { if (e.status !== 422) throw e; }
  }
}

async function machines() {
  try {
    const gists = await gh('GET', '/gists?per_page=100');
    const g = gists.find((x) => x.files['claude-hub-status.md']);
    if (!g) return [];
    const full = await gh('GET', `/gists/${g.id}`);
    return Object.entries(full.files)
      .filter(([n]) => n.startsWith('machine-'))
      .map(([, f]) => { try { return JSON.parse(f.content); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => a.machine.localeCompare(b.machine));
  } catch { return null; }
}

// ------------------------------------------------------------------ UI helpers

function setBar(title, showBack) {
  $('#title').textContent = title;
  $('#back').hidden = !showBack;
  document.title = title === 'Claude Hub' ? 'Claude Hub' : `${title} · Claude Hub`;
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 2600);
}
function loading() { view.innerHTML = `<p class="empty"><span class="spinner"></span> Loading…</p>`; }
function fail(e) {
  if (e.status === 401) { store.set('hub.token', null); token = null; location.hash = '#/setup'; return; }
  view.innerHTML = `<div class="card err">${esc(e.message)}</div>`;
}
function autoRefresh(ms) {
  clearInterval(refreshTimer);
  if (ms) refreshTimer = setInterval(() => { if (!document.hidden && !document.activeElement?.matches('textarea,input')) route(true); }, ms);
}
const go = (hash) => { location.hash = hash; };

// ------------------------------------------------------------------ views

function viewSetup() {
  setBar('Connect GitHub', false);
  autoRefresh(0);
  view.innerHTML = `
    <div class="card">
      <p>Claude Hub uses GitHub to pass your instructions to Claude on your VPS and laptop. Your token stays on this phone.</p>
      <ol class="steps small">
        <li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → new fine-grained token</a>.</li>
        <li>Name it <b>Claude Hub phone</b>, expiry 1 year, <b>Repository access: All repositories</b>.</li>
        <li>Repository permissions: <b>Issues</b>, <b>Contents</b> and <b>Administration</b> read &amp; write (Administration lets you add and create projects).</li>
        <li>Account permissions: <b>Gists</b> read &amp; write (shows whether your machines are online).</li>
        <li>Generate, copy it and paste it below.</li>
      </ol>
      <form id="f" class="composer">
        <input id="tok" type="password" placeholder="github_pat_…" autocomplete="off" required>
        <button class="btn block">Connect</button>
        <p id="msg" class="small err" hidden></p>
      </form>
    </div>`;
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    token = $('#tok').value.trim();
    try {
      me = await gh('GET', '/user');
      store.set('hub.token', token);
      go('#/');
    } catch (err) {
      $('#msg').hidden = false;
      $('#msg').textContent = `That token didn't work: ${err.message}`;
    }
  };
}

async function viewHome(quiet) {
  setBar('Claude Hub', false);
  if (!quiet) loading();
  autoRefresh(30000);
  const [, ms] = await Promise.all([loadProjects(), machines()]);
  const recent = (await Promise.all(projects.map((p) =>
    gh('GET', `/repos/${p.full_name}/issues?labels=${LABEL}&state=all&sort=updated&per_page=5`)
      .then((list) => list.map((i) => ({ ...i, repo: p })))
      .catch(() => []),
  ))).flat().sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

  const active = recent.filter((i) => statusOf(i) !== 'done');
  const machineHtml = ms == null
    ? '<span class="small muted">Machine status unavailable (token needs Gists read).</span>'
    : ms.length === 0
      ? '<span class="small muted">No machine has checked in yet.</span>'
      : ms.map((m) => {
          const online = Date.now() - new Date(m.at) < 6 * 60e3;
          const cls = online ? (m.busy ? 'busy' : 'on') : '';
          const state = online ? (m.busy ? `busy: ${esc(m.busy)}` : 'online') : `offline · ${ago(m.at)}`;
          return `<span class="machine"><span class="dot ${cls}"></span><b>${esc(m.machine)}</b><span class="muted small">${state}</span></span>`;
        }).join('');

  const row = (i) => `
    <a class="row" href="#/t/${encodeURIComponent(i.repo.name)}/${i.number}">
      <div class="main"><div class="name">${esc(i.title)}</div><div class="sub">${esc(i.repo.name)} · ${ago(i.updated_at)}</div></div>
      ${badge(statusOf(i))}
    </a>`;

  view.innerHTML = `
    <div class="machines">${machineHtml}</div>
    ${active.length ? `<h2>In progress</h2><div class="list">${active.map(row).join('')}</div>` : ''}
    <h2>Projects</h2>
    <div class="list">
      ${projects.map((p) => {
        const open = recent.filter((i) => i.repo.id === p.id && statusOf(i) !== 'done').length;
        return `<a class="row" href="#/p/${encodeURIComponent(p.name)}">
          <div class="main"><div class="name">${esc(p.name)}</div><div class="sub">${esc(p.description || (p.private ? 'Private' : 'Public'))}</div></div>
          ${open ? `<span class="count">${open} open</span>` : ''}
          <svg class="chev" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </a>`;
      }).join('') || '<div class="empty">No projects yet.</div>'}
    </div>
    <div class="actions"><a class="btn secondary" href="#/add">+ Add or create project</a></div>
    <h2>Recent</h2>
    <div class="list">${recent.slice(0, 12).map(row).join('') || '<div class="empty">Nothing sent yet.</div>'}</div>
    <p class="small muted" style="margin-top:28px">Signed in as ${esc(me.login)} · <a href="#" id="logout">Disconnect</a></p>`;
  $('#logout').onclick = (e) => { e.preventDefault(); if (confirm('Remove the GitHub token from this phone?')) { store.set('hub.token', null); token = null; go('#/setup'); } };
}

function composer(placeholder, label) {
  return `
    <form id="compose" class="composer">
      <textarea id="text" placeholder="${esc(placeholder)}" required></textarea>
      <button class="btn block" id="send">${esc(label)}</button>
    </form>`;
}

async function viewProject(name, quiet) {
  setBar(name, true);
  if (!quiet) loading();
  autoRefresh(20000);
  if (!projects.length) await loadProjects();
  const p = projects.find((x) => x.name === name);
  if (!p) { view.innerHTML = '<div class="empty">Project not found.</div>'; return; }
  const draftKey = `hub.draft.${p.full_name}`;
  const issues = await gh('GET', `/repos/${p.full_name}/issues?labels=${LABEL}&state=all&sort=created&per_page=40`);
  view.innerHTML = `
    ${composer(`What should Claude do in ${p.name}?`, 'Send to Claude')}
    <p class="small muted">Changes go straight to <b>${esc(p.default_branch)}</b>. <a href="${esc(p.html_url)}" target="_blank" rel="noopener">Open on GitHub</a></p>
    <h2>Instructions</h2>
    <div class="list">
      ${issues.filter((i) => !i.pull_request).map((i) => `
        <a class="row" href="#/t/${encodeURIComponent(p.name)}/${i.number}">
          <div class="main"><div class="name">${esc(i.title)}</div><div class="sub">#${i.number} · ${ago(i.created_at)}</div></div>
          ${badge(statusOf(i))}
        </a>`).join('') || '<div class="empty">No instructions yet. Type one above.</div>'}
    </div>`;
  const text = $('#text');
  text.value = store.get(draftKey) || '';
  text.oninput = () => store.set(draftKey, text.value);
  $('#compose').onsubmit = async (e) => {
    e.preventDefault();
    const msg = text.value.trim();
    if (!msg) return;
    $('#send').disabled = true;
    try {
      const firstLine = msg.split('\n')[0];
      const title = firstLine.length > 72 ? firstLine.slice(0, 70) + '…' : firstLine;
      const issue = await gh('POST', `/repos/${p.full_name}/issues`, { title, body: msg, labels: [LABEL] });
      store.set(draftKey, null);
      toast('Sent to Claude');
      go(`#/t/${encodeURIComponent(p.name)}/${issue.number}`);
    } catch (err) {
      toast(`Could not send: ${err.message}`);
      $('#send').disabled = false;
    }
  };
}

async function viewThread(name, number, quiet) {
  setBar(`${name} #${number}`, true);
  if (!quiet) loading();
  if (!projects.length) await loadProjects();
  const p = projects.find((x) => x.name === name);
  if (!p) { view.innerHTML = '<div class="empty">Project not found.</div>'; return; }
  const [issue, comments] = await Promise.all([
    gh('GET', `/repos/${p.full_name}/issues/${number}`),
    gh('GET', `/repos/${p.full_name}/issues/${number}/comments?per_page=100`),
  ]);
  const status = statusOf(issue);
  autoRefresh(status === 'done' ? 0 : 8000);
  const draftKey = `hub.draft.${p.full_name}#${number}`;

  const parts = [`<div class="msg you"><div class="who"><span>You</span><span>${ago(issue.created_at)}</span></div><div class="body">${md(issue.body || issue.title)}</div></div>`];
  comments.forEach((c, idx) => {
    const body = c.body || '';
    if (body.startsWith(`${BOT}claim`)) {
      const later = comments.slice(idx + 1).some((x) => (x.body || '').startsWith(BOT));
      const m = body.match(/\*\*(.+?)\*\*/);
      parts.push(`<div class="event">${later ? '🛠️' : '<span class="spinner"></span>'} ${esc(m ? m[1] : 'Claude')} ${later ? 'picked this up' : 'is working on it…'} · ${ago(c.created_at)}</div>`);
    } else if (body.startsWith(BOT)) {
      parts.push(`<div class="msg claude"><div class="who"><span>Claude</span><span>${ago(c.created_at)}</span></div><div class="body">${md(body)}</div></div>`);
    } else {
      parts.push(`<div class="msg you"><div class="who"><span>You</span><span>${ago(c.created_at)}</span></div><div class="body">${md(body)}</div></div>`);
    }
  });
  if (status === 'queued') parts.push(`<div class="event"><span class="spinner"></span> Waiting for a machine to pick this up…</div>`);

  view.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <div style="flex:1;font-weight:650">${esc(issue.title)}</div>${badge(status)}
    </div>
    <div class="thread">${parts.join('')}</div>
    <h2>${status === 'done' ? 'Follow up' : 'Add to this'}</h2>
    ${composer(status === 'done' ? 'Ask for a tweak or next step…' : 'Add more detail…', status === 'working' ? 'Queue this reply' : 'Send')}
    <p class="small muted"><a href="${esc(issue.html_url)}" target="_blank" rel="noopener">View on GitHub</a></p>`;

  const text = $('#text');
  text.value = store.get(draftKey) || '';
  text.oninput = () => store.set(draftKey, text.value);
  $('#compose').onsubmit = async (e) => {
    e.preventDefault();
    const msg = text.value.trim();
    if (!msg) return;
    $('#send').disabled = true;
    try {
      await gh('POST', `/repos/${p.full_name}/issues/${number}/comments`, { body: msg });
      if (issue.state === 'closed') await gh('PATCH', `/repos/${p.full_name}/issues/${number}`, { state: 'open' });
      if (issue.labels.some((l) => l.name === 'hub:failed')) await gh('DELETE', `/repos/${p.full_name}/issues/${number}/labels/hub:failed`).catch(() => {});
      store.set(draftKey, null);
      toast('Sent');
      route(true);
    } catch (err) {
      toast(`Could not send: ${err.message}`);
      $('#send').disabled = false;
    }
  };
}

async function viewAdd() {
  setBar('Add project', true);
  autoRefresh(0);
  loading();
  const all = await loadProjects();
  const others = all.filter((r) => !(r.topics || []).includes(TOPIC) && r.permissions?.admin);
  view.innerHTML = `
    <h2>Start a new project</h2>
    <form id="new" class="card composer">
      <input id="name" type="text" placeholder="project-name" pattern="[A-Za-z0-9._-]+" autocapitalize="off" autocomplete="off" required>
      <textarea id="first" placeholder="What should Claude build first? (optional)"></textarea>
      <label class="small"><input type="checkbox" id="priv" checked> Private repository</label>
      <button class="btn block" id="create">Create project</button>
    </form>
    <h2>Add an existing GitHub repo</h2>
    <div class="list">
      ${others.map((r) => `
        <button class="row" data-repo="${esc(r.full_name)}">
          <div class="main"><div class="name">${esc(r.name)}</div><div class="sub">${r.private ? 'Private' : 'Public'} · updated ${ago(r.pushed_at)}</div></div>
          <span class="count">Add</span>
        </button>`).join('') || '<div class="empty">Every repo is already added.</div>'}
    </div>`;

  for (const b of view.querySelectorAll('[data-repo]')) {
    b.onclick = async () => {
      const full = b.dataset.repo;
      b.disabled = true;
      try {
        const { names } = await gh('GET', `/repos/${full}/topics`);
        await gh('PUT', `/repos/${full}/topics`, { names: [...new Set([...names, TOPIC])] });
        await ensureLabels(full);
        toast(`${full.split('/')[1]} added`);
        go(`#/p/${encodeURIComponent(full.split('/')[1])}`);
      } catch (err) { toast(`Could not add: ${err.message}`); b.disabled = false; }
    };
  }
  $('#new').onsubmit = async (e) => {
    e.preventDefault();
    $('#create').disabled = true;
    const name = $('#name').value.trim();
    try {
      const repo = await gh('POST', '/user/repos', { name, private: $('#priv').checked, auto_init: true });
      await gh('PUT', `/repos/${repo.full_name}/topics`, { names: [TOPIC] });
      await ensureLabels(repo.full_name);
      const first = $('#first').value.trim();
      if (first) {
        const line = first.split('\n')[0];
        await gh('POST', `/repos/${repo.full_name}/issues`, { title: line.length > 72 ? line.slice(0, 70) + '…' : line, body: first, labels: [LABEL] });
      }
      toast('Project created. Machines see it within 2 minutes.');
      await loadProjects();
      go(`#/p/${encodeURIComponent(repo.name)}`);
    } catch (err) { toast(`Could not create: ${err.message}`); $('#create').disabled = false; }
  };
}

// ------------------------------------------------------------------ router

async function route(quiet = false) {
  if (!token) { if (location.hash !== '#/setup') go('#/setup'); else viewSetup(); return; }
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (parts[0] === 'setup') { viewSetup(); return; }
  try {
    if (!me) me = await gh('GET', '/user');
    if (parts[0] === 'p' && parts[1]) await viewProject(parts[1], quiet);
    else if (parts[0] === 't' && parts[1]) await viewThread(parts[1], Number(parts[2]), quiet);
    else if (parts[0] === 'add') await viewAdd();
    else await viewHome(quiet);
  } catch (e) { if (!quiet) fail(e); }
}

$('#back').onclick = () => {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  go(parts[0] === 't' ? `#/p/${parts[1]}` : '#/');
};
$('#refresh').onclick = () => route(false);
window.addEventListener('hashchange', () => route(false));
document.addEventListener('visibilitychange', () => { if (!document.hidden && token) route(true); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
route();
