// ============================================================================
// The Minions dock tab — the hiring hall.
//
// A horizontal row of cards, each one somewhere between a résumé and a trading
// card: an animated portrait up top, a name and a job title, a mix of genuine
// spec and comedic small print, and the switches that decide what the character
// is allowed to do to your patch. Clicking a card hires whoever is on it — a
// crooked HIRED stamp thumps down across it, and he arrives in the workspace on
// his cart.
//
// Generic. It renders whatever is in the roster (`minionDefs`), so a new
// character is a new `registerMinion` and nothing here changes. The empty desks
// at the end are honest scaffolding: the roster is meant to grow.
// ============================================================================

import { DockTabHandle, registerDockTab } from '../dockpanel';
import type { MinionBody } from './body';
import {
  isHired,
  minionDefs,
  minionOpt,
  onRosterChange,
  recentHireEvent,
  resetMinionOpts,
  setHired,
  setMinionOpt,
  wasEmployed,
  type MinionDef,
  type MinionOption,
} from './roster';

/**
 * The empty desks. They hire nobody — but they are not filler: each one is a
 * character that has been **designed and not built**, so the row advertises the
 * actual roster instead of inventing jobs. Specs live in `docs/15-minions.md`
 * ▸ *The roster in design*; keep the two in step.
 *
 * The first two here were an electrician and a groundskeeper, which were mine
 * rather than anybody's design, and were both more men in overalls. A roster of
 * one idea in five costumes is the thing this folder is built to avoid.
 */
const VACANCIES: Array<{ title: string; role: string; blurb: string }> = [
  {
    title: 'POSITION VACANT',
    role: 'SURVEY & ACOUSTICS',
    blurb: 'Something that can tell you what the room is actually doing, rather than what you hoped. Interviewing.',
  },
  { title: 'NOW HIRING', role: '???', blurb: 'We don’t know what this one does yet either. Applications open.' },
];

interface CardAnim {
  body: MinionBody;
  canvas: HTMLCanvasElement;
  t0: number;
}

function build(body: HTMLElement): DockTabHandle {
  body.classList.add('dock-minions');

  const bar = document.createElement('div');
  bar.className = 'dock-bar';
  const hint = document.createElement('span');
  hint.className = 'dock-hint';
  hint.textContent = 'Minions';
  bar.appendChild(hint);

  const rail = document.createElement('div');
  rail.className = 'minion-rail';
  body.append(bar, rail);

  const anims: CardAnim[] = [];

  // **Rebuild only when employment actually changed.** `onRosterChange` fires on
  // every option toggle as well as on hire and fire, and `refresh`/`onShow` fire
  // whenever you look at the tab — and a rebuild throws away every card element,
  // which restarts the portraits and re-triggers the stamp. Flicking one switch
  // on one card should not restamp the row, and opening the tab should not
  // animate anything at all. The signature below is the only thing the cards'
  // structure depends on, so comparing it is exactly the right guard.
  let lastSig: string | null = null;
  const rebuild = (): void => {
    const sig = minionDefs()
      .map((d) => d.id + (isHired(d.id) ? ':h' : wasEmployed(d.id) ? ':x' : ':-'))
      .join('|');
    if (sig === lastSig) return;
    lastSig = sig;

    rail.innerHTML = '';
    anims.length = 0;
    let hiredCount = 0;
    for (const def of minionDefs()) {
      if (isHired(def.id)) hiredCount++;
      rail.appendChild(buildCard(def, anims));
    }
    for (const v of VACANCIES) rail.appendChild(buildVacancy(v));
    hint.textContent = hiredCount ? `Minions — ${hiredCount} on the payroll` : 'Minions — nobody hired yet';
  };

  // The tab is built once and lives for the session (dockpanel builds each tab
  // a single time), so this subscription is never torn down — which is correct,
  // the roster can change from anywhere and the card row must follow.
  onRosterChange(rebuild);
  rebuild();

  return {
    refresh: rebuild,
    onShow: rebuild,
    onHide: () => {
      /* portraits stop animating when the tab is hidden — dockFrame only ticks
         the visible tab. */
    },
    onFrame: () => {
      const now = performance.now() / 1000;
      for (const a of anims) {
        const g = a.canvas.getContext('2d');
        if (!g) continue;
        const dpr = window.devicePixelRatio || 1;
        const w = a.canvas.clientWidth;
        const h = a.canvas.clientHeight;
        if (a.canvas.width !== Math.round(w * dpr) || a.canvas.height !== Math.round(h * dpr)) {
          a.canvas.width = Math.round(w * dpr);
          a.canvas.height = Math.round(h * dpr);
        }
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, w, h);
        a.body.portrait(g, w, h, now - a.t0);
      }
    },
  };
}

// ---------------------------------------------------------------------------

function buildCard(def: MinionDef, anims: CardAnim[]): HTMLElement {
  const hired = isHired(def.id);
  const exEmployee = !hired && wasEmployed(def.id);
  // `thump` only when this very card's state was changed by a click a moment
  // ago — not when it is merely being re-rendered. See `recentHireEvent`.
  const ev = recentHireEvent();
  const thump = !!ev && ev.id === def.id && performance.now() - ev.at < 900;
  const card = document.createElement('div');
  card.className =
    'minion-card' + (hired ? ' hired' : '') + (exEmployee ? ' exemployee' : '') + (thump ? ' thump' : '');
  // The résumé lives in a scrolling sheet so the card frame itself has a stable
  // size — which is what lets the stamps sit at a fixed offset rather than at a
  // percentage of something that changes. See the note by `.minion-stamp`.
  const sheet = document.createElement('div');
  sheet.className = 'minion-sheet';
  card.appendChild(sheet);

  // ---- identity, first ----
  const head = document.createElement('div');
  head.className = 'minion-head';
  head.innerHTML =
    `<div class="minion-name">${esc(def.card.full)}</div>` +
    `<div class="minion-role">${esc(def.card.role)}</div>` +
    `<div class="minion-sub">${esc(def.card.sub)}</div>`;
  sheet.appendChild(head);

  // ---- mugshot, below the name (head-on) ----
  const port = document.createElement('div');
  port.className = 'minion-portrait';
  const cv = document.createElement('canvas');
  port.appendChild(cv);
  // A booth board across the bottom — generic mugshot furniture, so it is here
  // rather than in the character's own painter.
  const board = document.createElement('div');
  board.className = 'minion-idstrip';
  board.innerHTML = `<span>LP&nbsp;DEPT.&nbsp;OF&nbsp;PATCHES</span><span>${esc(def.card.initials)}&nbsp;·&nbsp;${def.card.sub.split('·')[0].trim()}</span>`;
  port.appendChild(board);
  sheet.appendChild(port);

  // ---- quote, under the mugshot ----
  const quote = document.createElement('div');
  quote.className = 'minion-quote';
  quote.textContent = def.card.quote;
  sheet.appendChild(quote);

  anims.push({ body: def.makeBody(), canvas: cv, t0: performance.now() / 1000 });

  // ---- résumé facts ----
  const facts = document.createElement('div');
  facts.className = 'minion-facts';
  for (const [k, v] of def.card.facts) {
    const row = document.createElement('div');
    row.className = 'minion-fact';
    row.innerHTML = `<span class="fk">${esc(k)}</span><span class="fv">${esc(v)}</span>`;
    facts.appendChild(row);
  }
  sheet.appendChild(facts);

  // ---- switches, grouped ----
  const groups: Array<[MinionOption['group'], string]> = [
    ['duties', 'DUTIES'],
    ['manners', 'CONDUCT'],
    ['terms', 'TERMS'],
  ];
  const opts = document.createElement('div');
  opts.className = 'minion-opts';
  for (const [group, title] of groups) {
    const list = def.options.filter((o) => o.group === group);
    if (!list.length) continue;
    const gh = document.createElement('div');
    gh.className = 'minion-optgroup';
    gh.textContent = title;
    opts.appendChild(gh);
    for (const o of list) opts.appendChild(buildOption(def.id, o));
  }
  sheet.appendChild(opts);

  // ---- small print ----
  const fine = document.createElement('div');
  fine.className = 'minion-fineprint';
  fine.textContent = def.card.smallPrint;
  sheet.appendChild(fine);

  // ---- hire / fire ----
  const foot = document.createElement('div');
  foot.className = 'minion-foot';
  const btn = document.createElement('button');
  btn.className = 'minion-hire';
  btn.textContent = hired ? 'On the payroll — let him go' : exEmployee ? 'TAKE HIM BACK' : 'HIRE';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setHired(def.id, !isHired(def.id));
  });
  foot.appendChild(btn);
  sheet.appendChild(foot);

  // The whole card is clickable to hire (the user asked for "clicking the card"
  // to do it), but not when the click is on a control inside it.
  card.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('.minion-opt') || t.closest('button')) return;
    if (!isHired(def.id)) setHired(def.id, true);
  });
  // Right-click resets his switches to the defaults.
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    resetMinionOpts(def.id);
  });

  // ---- the stamps ----
  // Both always exist; CSS decides which the card's state shows. Two elements
  // rather than one with swapped text, because a fired card carries BOTH — the
  // red one struck across the green one, which is the point.
  const hiredStamp = document.createElement('div');
  hiredStamp.className = 'minion-stamp st-hired';
  hiredStamp.textContent = 'HIRED';
  const firedStamp = document.createElement('div');
  firedStamp.className = 'minion-stamp st-fired';
  firedStamp.textContent = 'FIRED';
  // Into the SHEET, not the card: the stamp is ink on the paper, so it travels
  // with the résumé when it scrolls and never moves when the dock is resized.
  sheet.append(hiredStamp, firedStamp);

  return card;
}

function buildOption(minionId: string, o: MinionOption): HTMLElement {
  const row = document.createElement('label');
  row.className = 'minion-opt';
  row.title = o.hint;
  if (o.type === 'bool') {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = minionOpt(minionId, o.id) === true;
    cb.addEventListener('change', () => setMinionOpt(minionId, o.id, cb.checked));
    const tx = document.createElement('span');
    tx.className = 'minion-opt-label';
    tx.textContent = o.label;
    row.append(cb, tx);
  } else {
    const tx = document.createElement('span');
    tx.className = 'minion-opt-label';
    const val = document.createElement('span');
    val.className = 'minion-opt-val';
    const cur = Number(minionOpt(minionId, o.id));
    val.textContent = fmtOpt(cur, o.unit);
    tx.textContent = o.label;
    const sl = document.createElement('input');
    sl.type = 'range';
    sl.min = String(o.min ?? 0);
    sl.max = String(o.max ?? 1);
    sl.step = String(o.step ?? 0.1);
    sl.value = String(cur);
    sl.addEventListener('input', () => {
      const v = Number(sl.value);
      val.textContent = fmtOpt(v, o.unit);
      setMinionOpt(minionId, o.id, v);
    });
    const top = document.createElement('div');
    top.className = 'minion-opt-top';
    top.append(tx, val);
    row.append(top, sl);
    row.classList.add('range');
  }
  return row;
}

function buildVacancy(v: { title: string; role: string; blurb: string }): HTMLElement {
  const card = document.createElement('div');
  card.className = 'minion-card vacant';
  card.innerHTML =
    `<div class="minion-portrait vacant"><div class="vacant-mark">?</div></div>` +
    `<div class="minion-head"><div class="minion-name">${esc(v.title)}</div>` +
    `<div class="minion-role">${esc(v.role)}</div></div>` +
    `<div class="minion-fineprint vacant-blurb">${esc(v.blurb)}</div>` +
    `<div class="minion-foot"><button class="minion-hire" disabled>NO APPLICANTS</button></div>`;
  return card;
}

function fmtOpt(v: number, unit?: string): string {
  const s = Number.isInteger(v) ? String(v) : v.toFixed(1);
  return unit ? s + unit : s;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

registerDockTab({
  id: 'minions',
  title: 'Minions',
  // A dock icon has to match its neighbours (⚙ ◫ ◎ ⊞), and that means a glyph
  // the platform's TEXT font can draw. `🛠` is outside the BMP and no UI font
  // carries it, so Chromium fell back to the colour emoji font and it rendered
  // as the one full-colour thing on the rail — reported exactly that way. The
  // emoji *property* is not the test (⚙ is an emoji code point and renders as
  // line art); font coverage is. U+263B is in Miscellaneous Symbols, is not in
  // emoji-data at all, and is old enough to be in essentially every font.
  icon: '☻',
  hint: 'Minions — hire a little character to keep your patch in order',
  order: 25,
  build,
});
