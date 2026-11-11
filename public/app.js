/* Spese del matrimonio — PWA
   I dati vivono sul telefono (localStorage) e, se i due telefoni sono
   collegati con un codice di coppia, si sincronizzano in tempo reale
   tramite il server Cloudflare (cartella worker/). Il server riceve solo
   dati cifrati con una chiave ricavata dal codice. Per ogni spesa vince
   la modifica più recente. */
'use strict';

(() => {
  const KEY = 'spese-nozze:v1';
  const SYNC_KEY = 'spese-nozze:sync';
  const APP_ID = 'spese-nozze';
  const VERSION = '1.3.0';

  const DEFAULT_CATEGORIES = [
    'Location e ricevimento', 'Catering', 'Chiesa o Comune', 'Abito sposa', 'Abito sposo',
    'Fedi', 'Foto e video', 'Fiori e allestimenti', 'Musica', 'Partecipazioni e stampa',
    'Bomboniere e confetti', 'Trucco e acconciatura', 'Torta', 'Auto e trasporti',
    'Viaggio di nozze', 'Wedding planner', 'Altro'
  ];
  const PAY_TYPES = ['Acconto', 'Rata', 'Saldo', 'Extra'];
  const METHODS = ['Bonifico', 'Contanti', 'Carta', 'Assegno', 'Altro'];

  /* ---------------- utilità ---------------- */
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  const now = () => Date.now();
  const toInt = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : 0; };

  // Formattazione all'italiana con il punto anche sulle migliaia a 4 cifre (Intl scrive "6850 €")
  function num(c) {
    const neg = c < 0; c = Math.abs(Math.round(c));
    const int = String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const dec = c % 100 ? ',' + String(c % 100).padStart(2, '0') : '';
    return (neg ? '−' : '') + int + dec;
  }
  const money = (c) => `${num(c)} €`;
  const moneyBig = (c) => `${num(c)}<span class="cur">€</span>`;
  const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

  /** "1.500,50" · "1500.5" · "1.500" · "€ 2 000" -> centesimi. null se vuoto, NaN se non valido */
  function parseAmount(str) {
    if (str == null) return null;
    let s = String(str).trim().replace(/[€\s ']/g, '');
    if (!s) return null;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
    return Math.round(parseFloat(s) * 100);
  }
  const amountToInput = (c) => (c ? (c / 100).toLocaleString('it-IT', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2, useGrouping: false }) : '');

  const pad = (n) => String(n).padStart(2, '0');
  const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayISO = () => isoOf(new Date());
  const addDays = (iso, n) => { const d = parseISO(iso); d.setDate(d.getDate() + n); return isoOf(d); };
  const parseISO = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
  const validISO = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const fmtDate = (s, o) => (validISO(s) ? parseISO(s).toLocaleDateString('it-IT', o || { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const daysFrom = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000);

  /* ---------------- stato ---------------- */
  function blank() {
    return {
      v: 1,
      settings: { name1: '', name2: '', date: '', budget: 0, extraPayers: ['Insieme', 'Famiglie'], updatedAt: 0 },
      categories: [...DEFAULT_CATEGORIES],
      catU: 0,
      items: [],
      guests: [],
      gcfg: { spare: 0, ordered: 0, updatedAt: 0 },
      meta: { onboarded: false, lastBackup: 0, lastSync: 0 }
    };
  }
  function normPay(p) {
    return {
      id: p.id || uid(), amount: Math.max(0, toInt(p.amount)), status: p.status === 'due' ? 'due' : 'paid',
      date: validISO(p.date) ? p.date : '', type: PAY_TYPES.includes(p.type) ? p.type : 'Acconto',
      method: String(p.method || ''), payer: String(p.payer || ''), note: String(p.note || '')
    };
  }
  function normItem(i) {
    return {
      id: i.id || uid(), name: String(i.name || ''), category: String(i.category || 'Altro'),
      total: Math.max(0, toInt(i.total)), estimate: !!i.estimate, notes: String(i.notes || ''), contact: String(i.contact || ''),
      payments: Array.isArray(i.payments) ? i.payments.map(normPay) : [],
      createdAt: toInt(i.createdAt) || now(), updatedAt: toInt(i.updatedAt), deleted: !!i.deleted, sample: !!i.sample
    };
  }
  function normMember(m) {
    return { id: m.id || uid(), name: String(m.name || '').trim(), kind: ['adulto', 'bambino', 'neonato'].includes(m.kind) ? m.kind : 'adulto', rsvp: m.rsvp === 'si' || m.rsvp === 'no' ? m.rsvp : '' };
  }
  function normGuest(g) {
    const inv = g.invite || {};
    return {
      id: g.id || uid(), name: String(g.name || '').trim(), side: g.side === 'a' || g.side === 'b' ? g.side : '',
      members: Array.isArray(g.members) ? g.members.map(normMember).filter((m) => m.name) : [],
      invite: { delivered: !!inv.delivered, date: validISO(inv.date) ? inv.date : '', how: String(inv.how || '') },
      favors: Math.max(0, Math.min(99, g.favors == null ? 1 : toInt(g.favors))), notes: String(g.notes || ''),
      createdAt: toInt(g.createdAt) || now(), updatedAt: toInt(g.updatedAt), deleted: !!g.deleted, sample: !!g.sample
    };
  }
  const normGcfg = (c) => ({ spare: Math.max(0, toInt((c || {}).spare)), ordered: Math.max(0, toInt((c || {}).ordered)), updatedAt: toInt((c || {}).updatedAt) });
  function normalize(s) {
    const b = blank();
    s = s && typeof s === 'object' ? s : {};
    const settings = { ...b.settings, ...(s.settings || {}) };
    settings.budget = Math.max(0, toInt(settings.budget));
    if (!Array.isArray(settings.extraPayers)) settings.extraPayers = b.settings.extraPayers;
    return {
      v: 1,
      settings,
      categories: Array.isArray(s.categories) && s.categories.length ? s.categories.map(String) : b.categories,
      catU: Math.max(0, toInt(s.catU)),
      items: Array.isArray(s.items) ? s.items.map(normItem) : [],
      guests: Array.isArray(s.guests) ? s.guests.map(normGuest) : [],
      gcfg: normGcfg(s.gcfg),
      meta: { ...b.meta, ...(s.meta || {}) }
    };
  }
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return normalize(JSON.parse(raw));
    } catch (e) { console.warn('Lettura dati non riuscita', e); }
    return blank();
  }
  let saveFailed = false;
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); saveFailed = false; }
    catch (e) {
      if (!saveFailed) toast('Salvataggio non riuscito: il browser non concede spazio. Esporta un backup dalle impostazioni.');
      saveFailed = true;
    }
    if (typeof scheduleFlush === 'function') scheduleFlush();
  }
  const touchCategories = () => { state.catU = Math.max(now(), (state.catU || 0) + 1); };

  let state = load();
  const ui = { tab: 'home', filter: 'all', q: '', cat: '', gfilter: 'all', gq: '', gside: 'a' };
  try { const t = sessionStorage.getItem('spese-nozze:tab'); if (t) ui.tab = t; } catch (e) { /* niente */ }
  { const t = new URLSearchParams(location.search).get('tab'); if (['home', 'items', 'due', 'guests', 'settings'].includes(t)) ui.tab = t; }

  const live = () => state.items.filter((i) => !i.deleted);
  const findItem = (id) => state.items.find((i) => i.id === id && !i.deleted);
  const touch = (item) => { item.updatedAt = Math.max(now(), (item.updatedAt || 0) + 1); };
  const payers = () => {
    const s = state.settings;
    return [s.name1, s.name2, ...(s.extraPayers || [])].map((x) => String(x || '').trim()).filter(Boolean)
      .filter((x, i, a) => a.indexOf(x) === i);
  };

  /* ---------------- calcoli ---------------- */
  function itemStats(it) {
    let paid = 0, sched = 0;
    for (const p of it.payments) { if (p.status === 'paid') paid += p.amount; else sched += p.amount; }
    const agreed = it.total || 0;
    const total = Math.max(agreed, paid + sched);
    const toPay = total - paid;
    const unscheduled = total - paid - sched;
    const excess = agreed > 0 && paid + sched > agreed ? paid + sched - agreed : 0;
    return { paid, sched, agreed, total, toPay, unscheduled, excess, settled: total > 0 && toPay === 0 };
  }
  function totals() {
    const t = { total: 0, paid: 0, toPay: 0, sched: 0, unscheduled: 0, estimate: 0, count: 0, byCat: new Map(), byPayer: new Map(), noAmount: 0 };
    for (const it of live()) {
      const s = itemStats(it);
      t.count++;
      t.total += s.total; t.paid += s.paid; t.toPay += s.toPay; t.sched += s.sched; t.unscheduled += s.unscheduled;
      if (it.estimate) t.estimate += s.total;
      if (s.total === 0) t.noAmount++;
      const c = t.byCat.get(it.category) || { name: it.category, total: 0, paid: 0, toPay: 0, n: 0 };
      c.total += s.total; c.paid += s.paid; c.toPay += s.toPay; c.n++;
      t.byCat.set(it.category, c);
      for (const p of it.payments) {
        if (p.status !== 'paid') continue;
        const k = p.payer || 'Non indicato';
        t.byPayer.set(k, (t.byPayer.get(k) || 0) + p.amount);
      }
    }
    return t;
  }
  function allPayments(status) {
    const out = [];
    for (const it of live()) for (const p of it.payments) if (!status || p.status === status) out.push({ it, p });
    return out;
  }

  /* ---------------- componenti ---------------- */
  const ICON_CHECK = '<svg class="check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_LATE = '<svg class="check" style="color:currentColor" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7.5v5.5M12 16.5v.01" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
  const ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  /** Barra segmentata: pagato | da pagare | (budget libero) */
  function bar({ paid, toPay, free = 0, budgetMark = null, thin = false, label = '', noPct = false }) {
    const whole = paid + toPay + free;
    if (whole <= 0) return `<div class="bar${thin ? ' thin' : ''}" role="img" aria-label="Nessun importo"><span class="seg free" style="flex:1"></span></div>`;
    const seg = (cls, v, inner = '') => (v > 0 ? `<span class="seg ${cls}" style="flex:${v} 1 0">${inner}</span>` : '');
    const showPct = !thin && !noPct && paid / whole > 0.14;
    const inner = showPct ? `<span class="in">${pct(paid, paid + toPay)}%</span>` : '';
    const mark = budgetMark != null ? `<span class="budget-mark" style="left:calc(${(budgetMark * 100).toFixed(2)}% - 1px)" aria-hidden="true"></span>` : '';
    return `<div class="bar${thin ? ' thin' : ''}" role="img" aria-label="${esc(label || `Pagato ${money(paid)}, da pagare ${money(toPay)}`)}">${seg('paid', paid, inner)}${seg('topay', toPay)}${seg('free', free)}${mark}</div>`;
  }

  function countdown() {
    const d = state.settings.date;
    if (!validISO(d)) return '';
    const n = daysFrom(todayISO(), d);
    const when = fmtDate(d, { day: 'numeric', month: 'long', year: 'numeric' });
    if (n > 1) return `${when}, mancano ${n} giorni`;
    if (n === 1) return `${when}, manca un giorno`;
    if (n === 0) return 'È oggi. Auguri!';
    return `Sposati il ${when}`;
  }

  function payRow({ it, p }, { showItem = true, actions = true } = {}) {
    const today = todayISO();
    const late = p.status === 'due' && p.date && p.date < today;
    const d = p.date ? parseISO(p.date) : null;
    const dateHtml = d
      ? `<time datetime="${p.date}"><b>${d.getDate()}</b>${esc(d.toLocaleDateString('it-IT', { month: 'short' }))} ${d.getFullYear() !== new Date().getFullYear() ? d.getFullYear() : ''}</time>`
      : '<time><b>—</b>senza data</time>';
    const bits = [p.type, p.status === 'paid' ? [p.payer, p.method].filter(Boolean).join(', ') : '', p.note].filter(Boolean);
    let sub = esc(bits.join(' – '));
    if (late) sub = `<span class="late-label">${ICON_LATE}Scaduta da ${daysFrom(p.date, today)} ${daysFrom(p.date, today) === 1 ? 'giorno' : 'giorni'}</span>${sub ? ' ' + sub : ''}`;
    const title = showItem ? esc(it.name) : esc(p.type);
    const subLine = showItem ? sub : esc([p.status === 'paid' ? [p.payer, p.method].filter(Boolean).join(', ') : '', p.note].filter(Boolean).join(' – '));
    const subFinal = !showItem && late ? `<span class="late-label">${ICON_LATE}Scaduta</span> ${subLine}` : (showItem ? sub : subLine);
    const amt = `${p.status === 'paid' ? ICON_CHECK + ' ' : ''}${money(p.amount)}`;
    const act = actions && p.status === 'due'
      ? `<div class="actions"><button type="button" class="btn small primary" data-action="mark-paid" data-item="${it.id}" data-pay="${p.id}">Segna pagato</button></div>`
      : '';
    return `<li class="pay-li"><div class="pay${late ? ' late' : ''}" data-action="edit-pay" data-item="${it.id}" data-pay="${p.id}" role="button" tabindex="0" aria-label="${esc(`${p.status === 'paid' ? 'Pagato' : 'Da pagare'} ${money(p.amount)}, ${it.name}, ${p.type}${p.date ? ', ' + fmtDate(p.date) : ''}. Modifica`)}">
      ${dateHtml}
      <div class="what"><strong>${title}</strong>${subFinal ? `<span>${subFinal}</span>` : ''}</div>
      <span class="amt">${amt}</span>
      ${act}
    </div></li>`;
  }

  function itemRow(it) {
    const s = itemStats(it);
    const tags = `${it.estimate ? '<span class="tag">stima</span>' : ''}${s.settled ? '<span class="tag ok">saldato</span>' : ''}`;
    const meta = s.total === 0
      ? '<span>Importo da definire</span>'
      : `<span>${money(s.paid)} pagati</span><span class="${s.toPay ? 'topay-txt' : ''}">${s.toPay ? money(s.toPay) + ' da pagare' : 'Niente da pagare'}</span>`;
    return `<li><button type="button" class="row" data-action="open-item" data-id="${it.id}">
      <span class="row-top"><span class="row-name">${esc(it.name)}${tags}</span><span class="row-amt">${s.total ? money(s.total) : ''}</span></span>
      ${s.total ? bar({ paid: s.paid, toPay: s.toPay, thin: true }) : ''}
      <span class="row-meta">${meta}</span>
    </button></li>`;
  }

  /* ---------------- viste ---------------- */
  const IMG = { hero: 'img/illustrazione.webp', rings: 'img/anelli.webp', coins: 'img/monete.webp' };
  const ICON_CAL = '<svg class="stat-icon" viewBox="0 0 48 48" aria-hidden="true"><rect x="5" y="9" width="38" height="34" rx="7" fill="#FFF8F2" stroke="#5A3B2E" stroke-width="2.5"/><path d="M5 19v-3a7 7 0 0 1 7-7h24a7 7 0 0 1 7 7v3z" fill="#EFA8A0" stroke="#5A3B2E" stroke-width="2.5" stroke-linejoin="round"/><path d="M15 5v8M33 5v8" stroke="#5A3B2E" stroke-width="2.5" stroke-linecap="round"/><circle cx="16" cy="27" r="2.3" fill="#D49A35"/><circle cx="24" cy="27" r="2.3" fill="#D49A35"/><circle cx="32" cy="27" r="2.3" fill="#C9D3C6"/><circle cx="16" cy="35" r="2.3" fill="#C9D3C6"/><circle cx="24" cy="35" r="2.3" fill="#6B8F6E"/></svg>';
  const pageHead = (title, sub = '') => `<header class="page-head"><div><h1 class="page-title">${title}</h1>${sub ? `<p class="page-sub">${sub}</p>` : ''}</div><img class="page-art" src="${IMG.rings}" alt="" width="92" height="74"></header>`;
  const emptyArt = (title, text, buttons = '') => `<section class="empty"><img class="empty-art" src="${IMG.hero}" alt="" width="240" height="238"><h2>${title}</h2><p>${text}</p>${buttons ? `<div class="btns">${buttons}</div>` : ''}</section>`;

  function dueTile({ it, p }) {
    const late = p.date && p.date < todayISO();
    const d = p.date ? parseISO(p.date) : null;
    const month = d ? d.toLocaleDateString('it-IT', { month: 'short' }).replace('.', '') : 'senza';
    const year = d && d.getFullYear() !== new Date().getFullYear() ? ` ${String(d.getFullYear()).slice(2)}` : '';
    const label = `${it.name}, ${p.type}, ${money(p.amount)}${d ? `, ${fmtDate(p.date)}` : ', senza data'}${late ? ', scaduta' : ''}. Modifica`;
    return `<li><button type="button" class="tile${late ? ' late' : ''}" data-action="edit-pay" data-item="${it.id}" data-pay="${p.id}" aria-label="${esc(label)}">
      <span class="tile-cal" aria-hidden="true"><span class="tile-month">${esc(month + year)}</span><span class="tile-day">${d ? d.getDate() : '–'}</span></span>
      <span class="tile-name">${esc(it.name)}</span>
      <span class="tile-amt">${money(p.amount)}</span>
      ${late ? `<span class="tile-late">${ICON_LATE}Scaduta</span>` : `<span class="tile-type">${esc(p.type)}</span>`}
    </button></li>`;
  }

  function guestsHomeCard() {
    if (!liveGuests().length) return '';
    const gs = guestStats();
    return `<section class="card" aria-labelledby="h-ginv"><div class="card-head"><h2 id="h-ginv">Invitati</h2><button type="button" class="link" data-action="tab" data-tab="guests">Apri la lista</button></div>
        ${bar({ paid: gs.yes, toPay: gs.wait, free: gs.no, noPct: true, thin: true, label: `${gs.yes} confermati, ${gs.wait} in attesa, ${gs.no} non vengono` })}
        <p class="g-home"><span><strong>${gs.yes}</strong> confermati su ${gs.people}</span><span><strong>${gs.wait}</strong> in attesa</span></p>
        <p class="g-home muted"><span>Partecipazioni consegnate ${gs.delivered} su ${gs.households}</span><span>Bomboniere ${gs.favors}</span></p>
      </section>`;
  }

  function viewHome() {
    const s = state.settings;
    const names = [s.name1, s.name2].map((x) => x.trim()).filter(Boolean);
    const t = totals();
    const cd = countdown();
    let h = `<header class="home-head"><h1 class="couple">${names.length ? esc(names.join(' e ')) : 'Il nostro matrimonio'}</h1>${cd ? `<p class="countdown">${esc(cd)}</p>` : ''}${sync.conf.code ? syncPill() : ''}</header>`;

    if (live().some((i) => i.sample)) {
      h += `<div class="sample-banner"><span>Stai guardando dati di esempio.</span><button type="button" class="link" data-action="clear-sample">Elimina l'esempio</button></div>`;
    }

    if (!t.count) {
      return h + guestsHomeCard() + emptyArt('Iniziate dalla prima spesa',
        "Inserite un fornitore con l'importo concordato e l'acconto già versato. L'app calcola quanto avete pagato, quanto resta e quando scade ogni rata.",
        '<button type="button" class="btn primary" data-action="new-item">Aggiungi spesa</button><button type="button" class="btn" data-action="load-sample">Vedi un esempio</button>');
    }

    const budget = s.budget || 0;
    const free = budget > t.total ? budget - t.total : 0;
    const mark = budget > 0 && budget < t.total ? budget / t.total : null;
    h += `<section class="card hero" aria-labelledby="h-total">
      <div class="hero-top">
        <img class="hero-art" src="${IMG.rings}" alt="" width="124" height="100">
        <div class="hero-fig"><h2 class="hero-label" id="h-total">Costo totale</h2><p class="big">${moneyBig(t.total)}</p></div>
      </div>
      ${t.estimate ? `<p class="hero-note">Include ${money(t.estimate)} di preventivi non ancora confermati</p>` : ''}
      ${bar({ paid: t.paid, toPay: t.toPay, free, budgetMark: mark, label: `Pagato ${money(t.paid)} su ${money(t.total)}, da pagare ${money(t.toPay)}${budget ? `, budget ${money(budget)}` : ''}` })}
      ${budget ? (t.total > budget
        ? `<p class="budget-line over">Budget ${money(budget)}: <strong>siete sopra di ${money(t.total - budget)}</strong></p>`
        : `<p class="budget-line"><i class="sw free"></i>Budget ${money(budget)}: restano <strong>${money(budget - t.total)}</strong> non impegnati</p>`)
        : `<p class="budget-line"><button type="button" class="link" data-action="tab" data-tab="settings">Imposta un budget</button> per vedere quanto margine vi resta.</p>`}
    </section>
    <div class="duo">
      <section class="card stat" aria-labelledby="h-paid">
        <img class="stat-art" src="${IMG.coins}" alt="" width="84" height="40">
        <h2 class="stat-label" id="h-paid"><i class="sw paid"></i>Già pagato</h2>
        <p class="stat-val">${money(t.paid)}</p>
        <p class="stat-sub">${pct(t.paid, t.total)}% del totale</p>
      </section>
      <section class="card stat" aria-labelledby="h-topay">
        ${ICON_CAL}
        <h2 class="stat-label" id="h-topay"><i class="sw topay"></i>Da pagare</h2>
        <p class="stat-val">${money(t.toPay)}</p>
        <p class="stat-sub">${t.unscheduled ? `${money(t.unscheduled)} senza data` : 'Tutto in calendario'}</p>
      </section>
    </div>`;

    // pagamenti in scadenza
    const due = allPayments('due').sort((a, b) => (a.p.date || '9999').localeCompare(b.p.date || '9999'));
    const lateN = due.filter((x) => x.p.date && x.p.date < todayISO()).length;
    h += `<section class="card" aria-labelledby="h-due"><div class="card-head"><h2 id="h-due">Pagamenti in scadenza</h2>${due.length ? '<button type="button" class="link" data-action="tab" data-tab="due">Vedi tutti</button>' : ''}</div>`;
    if (lateN) h += `<div class="callout warn"><p><strong>${lateN === 1 ? 'Un pagamento è scaduto' : `${lateN} pagamenti sono scaduti`}.</strong> Segnateli come pagati o spostate la data.</p></div>`;
    h += due.length
      ? `<ul class="tiles">${due.slice(0, 10).map(dueTile).join('')}</ul>`
      : '<p class="muted">Nessuna scadenza in programma.</p>';
    if (t.unscheduled > 0) {
      const n = live().filter((i) => itemStats(i).unscheduled > 0).length;
      h += `<div class="callout"><p><strong>${money(t.unscheduled)}</strong> da pagare ${n === 1 ? 'non ha' : 'non hanno'} ancora una data (${n} ${n === 1 ? 'spesa' : 'spese'}).</p><button type="button" class="link" data-action="tab" data-tab="due">Programma i saldi</button></div>`;
    }
    h += '</section>';

    h += guestsHomeCard();

    // per tipo di spesa
    const cats = [...t.byCat.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    h += `<section class="card" aria-labelledby="h-cat"><div class="card-head"><h2 id="h-cat">Per tipo di spesa</h2></div><ul class="list">${cats.map((c) => `
      <li><button type="button" class="row" data-action="open-cat" data-cat="${esc(c.name)}">
        <span class="row-top"><span class="row-name">${esc(c.name)}${c.n > 1 ? ` <span class="muted small">(${c.n})</span>` : ''}</span><span class="row-amt">${c.total ? money(c.total) : '–'}</span></span>
        ${c.total ? bar({ paid: c.paid, toPay: c.toPay, thin: true }) : ''}
        <span class="row-meta"><span>${money(c.paid)} pagati</span><span class="${c.toPay ? 'topay-txt' : ''}">${c.toPay ? money(c.toPay) + ' da pagare' : (c.total ? 'Saldato' : 'Importo da definire')}</span></span>
      </button></li>`).join('')}</ul></section>`;

    // chi ha pagato
    if (t.paid > 0) {
      const ps = [...t.byPayer.entries()].sort((a, b) => b[1] - a[1]);
      h += `<section class="card" aria-labelledby="h-who"><div class="card-head"><h2 id="h-who">Chi ha pagato</h2></div><ul class="list">${ps.map(([k, v]) => `<li class="payer"><span>${esc(k)}</span><span>${money(v)}<small>${pct(v, t.paid)}%</small></span></li>`).join('')}</ul></section>`;
    }

    // promemoria backup
    const lb = state.meta.lastBackup || 0;
    if (t.count >= 3 && now() - lb > 14 * 86400000 && !sync.conf.code) {
      h += `<p class="foot">${lb ? `Ultimo backup ${new Date(lb).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' })}.` : 'Non avete ancora salvato un backup.'} <button type="button" class="link" data-action="backup">Salva backup ora</button></p>`;
    }
    return h;
  }

  function viewItems() {
    const t = totals();
    let h = pageHead('Spese', t.count ? `${t.count} ${t.count === 1 ? 'voce' : 'voci'}, ${money(t.toPay)} ancora da pagare` : '');
    if (t.count) {
      h += `<label class="vh" for="q">Cerca una spesa</label><input id="q" class="search" type="search" placeholder="Cerca fornitore o nota" value="${esc(ui.q)}" autocomplete="off" enterkeyhint="search">`;
      const chip = (k, l) => `<button type="button" class="chip" data-action="filter" data-f="${k}" aria-pressed="${ui.filter === k}">${l}</button>`;
      h += `<div class="chips" role="group" aria-label="Filtra">${chip('all', 'Tutte')}${chip('open', 'Da saldare')}${chip('settled', 'Saldate')}${chip('estimate', 'Stime')}</div>`;
    }
    return h + `<div id="items-list">${itemsList()}</div>`;
  }
  function itemsList() {
    const q = ui.q.trim().toLowerCase();
    const items = live().filter((it) => {
      const s = itemStats(it);
      if (ui.filter === 'open' && !(s.toPay > 0 || s.total === 0)) return false;
      if (ui.filter === 'settled' && !s.settled) return false;
      if (ui.filter === 'estimate' && !it.estimate) return false;
      if (ui.cat && it.category !== ui.cat) return false;
      if (q && !(`${it.name} ${it.category} ${it.notes}`.toLowerCase().includes(q))) return false;
      return true;
    });
    const count = live().length;
    let h = '';
    if (ui.cat) h += `<p class="small filter-note">Categoria: <strong>${esc(ui.cat)}</strong> <button type="button" class="link" data-action="clear-cat">Mostra tutte</button></p>`;

    if (!items.length) {
      h += count
        ? '<p class="muted filter-note">Nessuna spesa corrisponde a questi filtri.</p>'
        : emptyArt('Ancora nessuna spesa', 'Aggiungete il primo fornitore: bastano nome, tipo di spesa e importo concordato.', '<button type="button" class="btn primary" data-action="new-item">Aggiungi spesa</button>');
      return h;
    }
    const order = [...state.categories];
    for (const it of items) if (!order.includes(it.category)) order.push(it.category);
    for (const cat of order) {
      const group = items.filter((i) => i.category === cat).sort((a, b) => itemStats(b).total - itemStats(a).total);
      if (!group.length) continue;
      const sum = group.reduce((a, i) => a + itemStats(i).total, 0);
      h += `<section class="card"><div class="card-head"><h2>${esc(cat)}</h2><span class="muted small">${money(sum)}</span></div><ul class="list">${group.map(itemRow).join('')}</ul></section>`;
    }
    return h;
  }

  function viewDue() {
    const today = todayISO();
    const in30 = addDays(today, 30);
    const due = allPayments('due').sort((a, b) => (a.p.date || '9999').localeCompare(b.p.date || '9999'));
    const late = due.filter((x) => x.p.date && x.p.date < today);
    const soon = due.filter((x) => x.p.date && x.p.date >= today && x.p.date <= in30);
    const later = due.filter((x) => !x.p.date || x.p.date > in30);
    const unsched = live().map((it) => ({ it, s: itemStats(it) })).filter((x) => x.s.unscheduled > 0).sort((a, b) => b.s.unscheduled - a.s.unscheduled);
    const paid = allPayments('paid').sort((a, b) => (b.p.date || '').localeCompare(a.p.date || ''));
    const sum = (arr) => arr.reduce((a, x) => a + x.p.amount, 0);
    const t = totals();

    let h = pageHead('Scadenze', t.count ? `${money(t.sched)} programmati, ${money(t.unscheduled)} ancora senza data` : '');
    const block = (title, arr, cls = '') => arr.length
      ? `<section class="card${cls}"><div class="card-head"><h2>${title}</h2><span class="muted small">${money(sum(arr))}</span></div><ul class="list">${arr.map((x) => payRow(x)).join('')}</ul></section>`
      : '';
    if (!due.length && !unsched.length && !paid.length) {
      return h + emptyArt('Niente in calendario', 'Quando aggiungete una rata o un saldo con una data, compare qui in ordine di scadenza.');
    }
    h += block('Scadute', late, ' card-late');
    h += block('Nei prossimi 30 giorni', soon);
    h += block('Più avanti', later);
    if (!due.length) h += '<p class="muted filter-note">Nessuna rata in programma.</p>';
    if (unsched.length) {
      h += `<section class="card"><div class="card-head"><h2>Da programmare</h2><span class="muted small">${money(t.unscheduled)}</span></div>
        <p class="muted small card-intro">Importi ancora da pagare per cui non avete fissato una data.</p>
        <ul class="list">${unsched.map(({ it, s }) => `<li><div class="pay" style="grid-template-columns:1fr auto">
          <div class="what"><strong>${esc(it.name)}</strong><span>${esc(it.category)}</span></div>
          <span class="amt">${money(s.unscheduled)}</span>
          <div class="actions" style="grid-column:1/-1"><button type="button" class="btn small" data-action="schedule" data-item="${it.id}">Fissa una scadenza</button><button type="button" class="btn small primary" data-action="pay-rest" data-item="${it.id}">Registra pagamento</button></div>
        </div></li>`).join('')}</ul></section>`;
    }
    if (paid.length) {
      h += `<section class="card"><div class="card-head"><h2>Pagamenti fatti</h2><span class="muted small">${money(sum(paid))}</span></div><ul class="list">${paid.map((x) => payRow(x, { actions: false })).join('')}</ul></section>`;
    }
    return h;
  }

  function viewSettings() {
    const s = state.settings;
    const counts = new Map();
    for (const it of live()) counts.set(it.category, (counts.get(it.category) || 0) + 1);
    const lastSync = state.meta.lastSync ? new Date(state.meta.lastSync).toLocaleString('it-IT', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '';
    return `${pageHead('Impostazioni')}
    <form data-form="settings" class="card set-section" autocomplete="off" novalidate>
      <h2>Il matrimonio</h2>
      <div class="grid2">
        <label class="field"><span>Primo nome</span><input type="text" name="name1" value="${esc(s.name1)}" placeholder="Es. Giulia" autocapitalize="words"></label>
        <label class="field"><span>Secondo nome</span><input type="text" name="name2" value="${esc(s.name2)}" placeholder="Es. Marco" autocapitalize="words"></label>
      </div>
      <label class="field"><span>Data del matrimonio</span><input type="date" name="date" value="${esc(s.date)}"></label>
      <label class="field"><span>Budget complessivo</span><input type="text" name="budget" inputmode="decimal" value="${esc(amountToInput(s.budget))}" placeholder="Es. 35.000"><span class="hint">Facoltativo. Serve a vedere quanto margine vi resta.</span></label>
      <label class="field"><span>Altri che possono pagare</span><input type="text" name="extraPayers" value="${esc((s.extraPayers || []).join(', '))}" placeholder="Insieme, Famiglie"><span class="hint">Separati da virgola. I vostri nomi sono già inclusi.</span></label>
      <div class="form-actions"><button class="btn primary" type="submit">Salva</button></div>
    </form>

    <section class="card set-section" aria-labelledby="h-sync" id="sync-section">
      <h2 id="h-sync">Sincronizzazione</h2>
      ${sync.conf.code
        ? `<p>Questo telefono è collegato: ogni spesa inserita qui o sull'altro telefono compare subito su entrambi.</p>
           ${syncPill()}
           <div class="btns"><button type="button" class="btn" data-action="sync-show">Mostra il codice di coppia</button><button type="button" class="btn danger" data-action="sync-unpair">Scollega questo telefono</button></div>`
        : `<p>Collegate i due telefoni: ogni spesa inserita da uno compare subito sull'altro. I dati viaggiano cifrati e solo i vostri telefoni possono leggerli.</p>
           <div class="btns"><button type="button" class="btn primary" data-action="sync-create">Crea un codice di coppia</button><button type="button" class="btn" data-action="sync-join">Ho già un codice</button></div>
           <p class="small muted" style="margin-top:.75rem">Il codice si crea su un solo telefono. L'altro lo inserisce con «Ho già un codice».</p>`}
      ${lastSync ? `<p class="small muted" style="margin-top:.75rem">Ultimo aggiornamento ricevuto: ${esc(lastSync)}</p>` : ''}
    </section>

    <section class="card set-section" aria-labelledby="h-share">
      <h2 id="h-share">Condividi l'app</h2>
      <p>Mandate la pagina di presentazione a chi sta per sposarsi. Ogni coppia usa il proprio codice: le vostre spese restano solo vostre.</p>
      <div class="btns"><button type="button" class="btn primary" data-action="share-app">Condividi l'app</button><a class="btn" href="/scopri/">Vedi la presentazione</a></div>
    </section>

    <section class="card set-section" aria-labelledby="h-bk">
      <h2 id="h-bk">Backup ed esportazione</h2>
      <p>Il backup è un file con tutte le spese: tenetelo nel cloud o mandatelo via mail. Il CSV si apre con Excel o Numbers.</p>
      <div class="btns"><button type="button" class="btn" data-action="backup">Salva backup</button><button type="button" class="btn" data-action="import-file">Importa da file</button><button type="button" class="btn" data-action="export-csv">Esporta CSV</button></div>
    </section>

    <section class="card set-section" aria-labelledby="h-cats">
      <h2 id="h-cats">Tipi di spesa</h2>
      <ul class="list" style="margin-top:.75rem">${state.categories.map((c, i) => `<li class="cat-item"><span>${esc(c)}${counts.get(c) ? `<small>${counts.get(c)}</small>` : ''}</span><span class="btns">
        <button type="button" class="icon-btn" data-action="cat-up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Sposta su ${esc(c)}">Su</button>
        <button type="button" class="icon-btn" data-action="cat-rename" data-i="${i}" aria-label="Rinomina ${esc(c)}">Rinomina</button>
        <button type="button" class="icon-btn" data-action="cat-del" data-i="${i}" ${counts.get(c) ? 'disabled title="Contiene delle spese"' : ''} aria-label="Elimina ${esc(c)}">Elimina</button>
      </span></li>`).join('')}</ul>
      <form class="add-cat" data-form="add-cat"><label class="vh" for="newcat">Nuovo tipo di spesa</label><input id="newcat" name="cat" type="text" placeholder="Nuovo tipo di spesa" autocomplete="off"><button class="btn small" type="submit">Aggiungi</button></form>
    </section>

    <section class="card set-section" aria-labelledby="h-reset">
      <h2 id="h-reset">Cancella tutto</h2>
      ${sync.conf.code
        ? '<p>Scollega questo telefono e ne cancella spese e impostazioni. Sull\'altro telefono e sul server i dati restano.</p><div class="btns"><button type="button" class="btn danger" data-action="reset">Scollega e cancella da questo telefono</button></div>'
        : '<p>Elimina tutte le spese e le impostazioni da questo telefono. Salvate prima un backup.</p><div class="btns"><button type="button" class="btn danger" data-action="reset">Cancella tutti i dati</button></div>'}
    </section>
    <p class="foot">Spese del matrimonio, versione ${VERSION}. Funziona anche offline.</p>`;
  }

  /* ---------------- invitati ----------------
     Un "nucleo" riceve una partecipazione e, di solito, una bomboniera.
     Ogni persona del nucleo ha la sua risposta: sì, no o in attesa (''). */
  const KINDS = { adulto: 'Adulto', bambino: 'Bambino', neonato: 'Neonato' };
  const HOW = ['A mano', 'Per posta', 'Digitale'];
  const ICON_ENVELOPE = '<svg class="stat-icon" viewBox="0 0 48 48" aria-hidden="true"><rect x="5" y="11" width="38" height="28" rx="6" fill="#FFF8F2" stroke="#5A3B2E" stroke-width="2.5"/><path d="M7 14l17 13 17-13" fill="none" stroke="#5A3B2E" stroke-width="2.5" stroke-linejoin="round"/><circle cx="24" cy="27" r="5" fill="#6B8F6E" stroke="#5A3B2E" stroke-width="2"/></svg>';
  const ICON_GIFT = '<svg class="stat-icon" viewBox="0 0 48 48" aria-hidden="true"><rect x="8" y="20" width="32" height="22" rx="4" fill="#FFF8F2" stroke="#5A3B2E" stroke-width="2.5"/><rect x="5" y="14" width="38" height="8" rx="3" fill="#EFA8A0" stroke="#5A3B2E" stroke-width="2.5"/><path d="M24 14v28" stroke="#5A3B2E" stroke-width="2.5"/><path d="M24 14c-3-6-11-7-11-2 0 3 6 2 11 2zm0 0c3-6 11-7 11-2 0 3-6 2-11 2z" fill="#D49A35" stroke="#5A3B2E" stroke-width="2.2" stroke-linejoin="round"/></svg>';

  const liveGuests = () => state.guests.filter((g) => !g.deleted);
  const findGuest = (id) => state.guests.find((g) => g.id === id && !g.deleted);
  const touchGcfg = () => { state.gcfg.updatedAt = Math.max(now(), (state.gcfg.updatedAt || 0) + 1); };
  const sideLabel = (side) => {
    const s = state.settings;
    if (side === 'a') return `Lato ${s.name1 || 'sposa'}`;
    if (side === 'b') return `Lato ${s.name2 || 'sposo'}`;
    return 'Di entrambi';
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function householdStats(g) {
    let yes = 0, no = 0, wait = 0;
    for (const m of g.members) { if (m.rsvp === 'si') yes++; else if (m.rsvp === 'no') no++; else wait++; }
    const allNo = g.members.length > 0 && no === g.members.length;
    return { yes, no, wait, n: g.members.length, allNo };
  }
  function guestStats() {
    const s = { households: 0, people: 0, yes: 0, no: 0, wait: 0, delivered: 0,
      yesBy: { adulto: 0, bambino: 0, neonato: 0 }, favorsYes: 0, favorsWait: 0, spare: state.gcfg.spare || 0 };
    for (const g of liveGuests()) {
      s.households++;
      if (g.invite.delivered) s.delivered++;
      const h = householdStats(g);
      s.people += h.n; s.yes += h.yes; s.no += h.no; s.wait += h.wait;
      for (const m of g.members) if (m.rsvp === 'si') s.yesBy[m.kind] = (s.yesBy[m.kind] || 0) + 1;
      if (!h.allNo) { if (h.yes > 0) s.favorsYes += g.favors; else s.favorsWait += g.favors; }
    }
    s.favors = s.favorsYes + s.favorsWait + s.spare;
    return s;
  }
  function membersSummary(g) {
    const h = householdStats(g);
    if (!h.n) return 'Nessuna persona';
    if (h.allNo) return h.n === 1 ? 'Non viene' : 'Non vengono';
    if (h.yes === h.n) return h.n === 1 ? 'Viene' : `${h.n} persone, vengono tutti`;
    if (h.wait === h.n) return `${plural(h.n, 'persona', 'persone')}, in attesa di risposta`;
    return [h.yes ? `${h.yes} sì` : '', h.wait ? `${h.wait} in attesa` : '', h.no ? `${h.no} no` : ''].filter(Boolean).join(', ');
  }

  function guestRow(g) {
    const fav = householdStats(g).allNo ? '' : plural(g.favors, 'bomboniera', 'bomboniere');
    return `<li><button type="button" class="row" data-action="open-guest" data-id="${g.id}">
      <span class="row-top"><span class="row-name">${esc(g.name)}</span>${g.invite.delivered ? `<span class="g-badge ok">${ICON_CHECK}Consegnata</span>` : '<span class="g-badge todo">Da consegnare</span>'}</span>
      <span class="row-meta"><span>${esc(membersSummary(g))}</span><span>${fav}</span></span>
    </button></li>`;
  }

  function viewGuests() {
    const s = guestStats();
    let h = pageHead('Invitati', s.households ? `${plural(s.people, 'persona', 'persone')} in ${plural(s.households, 'nucleo', 'nuclei')}` : '');
    if (!s.households) {
      return h + emptyArt('La lista degli invitati',
        'Aggiungete i nuclei familiari: a ogni nucleo va una partecipazione. Per ogni persona segnerete se viene, e l\'app conta da sola le bomboniere da comprare.',
        '<button type="button" class="btn primary" data-action="new-guest">Aggiungi un nucleo</button><button type="button" class="btn" data-action="guest-bulk">Incolla un elenco</button>');
    }
    const pctYes = pct(s.yes, s.people);
    h += `<section class="card hero" aria-labelledby="h-gyes">
      <div class="hero-fig"><h2 class="hero-label" id="h-gyes">Confermati</h2><p class="big">${s.yes}<span class="of">su ${s.people}</span></p></div>
      ${bar({ paid: s.yes, toPay: s.wait, free: s.no, noPct: true, label: `${s.yes} confermati, ${s.wait} in attesa, ${s.no} non vengono` })}
      <p class="g-legend"><span><i class="sw paid"></i>Vengono <strong>${s.yes}</strong></span><span><i class="sw topay"></i>In attesa <strong>${s.wait}</strong></span><span><i class="sw free"></i>Non vengono <strong>${s.no}</strong></span></p>
      ${s.yes ? `<p class="budget-line">Per il catering: ${[plural(s.yesBy.adulto, 'adulto', 'adulti'), s.yesBy.bambino ? plural(s.yesBy.bambino, 'bambino', 'bambini') : '', s.yesBy.neonato ? plural(s.yesBy.neonato, 'neonato', 'neonati') : ''].filter(Boolean).join(', ')} confermati (${pctYes}% degli invitati)</p>` : ''}
    </section>
    <div class="duo">
      <section class="card stat" aria-labelledby="h-inv">
        ${ICON_ENVELOPE}
        <h2 class="stat-label" id="h-inv">Partecipazioni consegnate</h2>
        <p class="stat-val">${s.delivered}<span class="of"> su ${s.households}</span></p>
        <p class="stat-sub">${state.gcfg.ordered ? (state.gcfg.ordered >= s.households ? `Ordinate ${state.gcfg.ordered}, ne avanzano ${state.gcfg.ordered - s.households}` : `Ordinate ${state.gcfg.ordered}, ne mancano ${s.households - state.gcfg.ordered}`) : 'Una per nucleo'}</p>
      </section>
      <section class="card stat" aria-labelledby="h-fav">
        ${ICON_GIFT}
        <h2 class="stat-label" id="h-fav">Bomboniere da comprare</h2>
        <p class="stat-val">${s.favors}</p>
        <p class="stat-sub">${[`${s.favorsYes} per chi viene`, s.favorsWait ? `${s.favorsWait} in attesa` : '', s.spare ? `${s.spare} di scorta` : ''].filter(Boolean).join(', ')}</p>
      </section>
    </div>`;
    h += `<label class="vh" for="gq">Cerca un invitato</label><input id="gq" class="search" type="search" placeholder="Cerca nome o nucleo" value="${esc(ui.gq)}" autocomplete="off" enterkeyhint="search">`;
    const chip = (k, l) => `<button type="button" class="chip" data-action="gfilter" data-f="${k}" aria-pressed="${ui.gfilter === k}">${l}</button>`;
    h += `<div class="chips" role="group" aria-label="Filtra">${chip('all', 'Tutti')}${chip('todo', 'Da consegnare')}${chip('wait', 'In attesa')}${chip('yes', 'Vengono')}${chip('no', 'Non vengono')}</div>`;
    h += `<div id="guests-list">${guestsList()}</div>`;
    h += `<section class="card set-section" aria-labelledby="h-gcfg">
      <h2 id="h-gcfg">Bomboniere e partecipazioni</h2>
      <div class="g-cfg-row"><span>Bomboniere di scorta</span><span class="stepper"><button type="button" data-action="gspare" data-d="-1" aria-label="Una in meno">−</button><output aria-live="polite">${s.spare}</output><button type="button" data-action="gspare" data-d="1" aria-label="Una in più">+</button></span></div>
      <form data-form="gcfg" class="g-cfg-row" novalidate><label for="gordered">Partecipazioni ordinate</label><span class="g-inline"><input id="gordered" name="ordered" type="text" inputmode="numeric" value="${state.gcfg.ordered || ''}" placeholder="0"><button class="btn small" type="submit">Salva</button></span></form>
      <div class="btns"><button type="button" class="btn" data-action="guest-bulk">Incolla un elenco</button><button type="button" class="btn" data-action="export-guests-csv">Esporta CSV</button></div>
    </section>`;
    return h;
  }
  function guestsList() {
    const q = ui.gq.trim().toLowerCase();
    const list = liveGuests().filter((g) => {
      const h = householdStats(g);
      if (ui.gfilter === 'todo' && g.invite.delivered) return false;
      if (ui.gfilter === 'wait' && !h.wait) return false;
      if (ui.gfilter === 'yes' && !h.yes) return false;
      if (ui.gfilter === 'no' && !h.no) return false;
      if (q && !(`${g.name} ${g.members.map((m) => m.name).join(' ')} ${g.notes}`.toLowerCase().includes(q))) return false;
      return true;
    });
    if (!list.length) return '<p class="muted filter-note">Nessun invitato corrisponde a questi filtri.</p>';
    let h = '';
    for (const side of ['a', 'b', '']) {
      const group = list.filter((g) => (g.side || '') === side).sort((x, y) => x.name.localeCompare(y.name, 'it'));
      if (!group.length) continue;
      const people = group.reduce((a, g) => a + g.members.length, 0);
      h += `<section class="card"><div class="card-head"><h2>${esc(sideLabel(side))}</h2><span class="muted small">${plural(people, 'persona', 'persone')}</span></div><ul class="list">${group.map(guestRow).join('')}</ul></section>`;
    }
    return h;
  }

  /* scheda del nucleo: risposte, consegna, bomboniere */
  function openGuest(id, opts = {}) {
    const g = findGuest(id);
    if (!g) { closeSheet(); return; }
    const h = householdStats(g);
    const inv = g.invite.delivered
      ? `<p><strong>${ICON_CHECK} Partecipazione consegnata</strong>${g.invite.date ? ` il ${esc(fmtDate(g.invite.date))}` : ''}${g.invite.how ? ` (${esc(g.invite.how.toLowerCase())})` : ''}</p>
         <button type="button" class="link" data-action="undeliver" data-g="${g.id}">Non è ancora stata consegnata</button>`
      : `<p><strong>Partecipazione da consegnare.</strong> Segnatela come consegnata:</p>
         <div class="deliver-btns">${HOW.map((w) => `<button type="button" class="btn small${w === 'A mano' ? ' primary' : ''}" data-action="deliver" data-g="${g.id}" data-how="${w}">${w}</button>`).join('')}</div>`;
    const rsvpBtns = (m) => [['si', 'Sì'], ['', '?'], ['no', 'No']].map(([v, l]) =>
      `<button type="button" data-action="rsvp" data-g="${g.id}" data-m="${m.id}" data-v="${v}" aria-pressed="${m.rsvp === v}" aria-label="${esc(m.name)}: ${v === 'si' ? 'viene' : v === 'no' ? 'non viene' : 'in attesa'}">${l}</button>`).join('');
    const html = `${head(g.name, sideLabel(g.side), `<button type="button" class="btn small" data-action="edit-guest" data-id="${g.id}">Modifica</button>`)}
      <div class="g-block">${inv}</div>
      <div class="card-head g-sub"><h3 class="subhead">Chi viene</h3>${h.n > 1 ? `<span class="btns"><button type="button" class="icon-btn" data-action="rsvp-all" data-g="${g.id}" data-v="si">Tutti sì</button><button type="button" class="icon-btn" data-action="rsvp-all" data-g="${g.id}" data-v="no">Tutti no</button></span>` : ''}</div>
      <ul class="list members">${g.members.map((m) => `<li class="m"><span class="m-name">${esc(m.name)}${m.kind !== 'adulto' ? ` <span class="tag">${KINDS[m.kind].toLowerCase()}</span>` : ''}</span><span class="rsvp" role="group" aria-label="Risposta di ${esc(m.name)}">${rsvpBtns(m)}</span></li>`).join('')}</ul>
      <div class="card-head g-sub"><h3 class="subhead">Bomboniere</h3>
        <span class="stepper"><button type="button" data-action="gfavors" data-g="${g.id}" data-d="-1" aria-label="Una bomboniera in meno">−</button><output aria-live="polite">${g.favors}</output><button type="button" data-action="gfavors" data-g="${g.id}" data-d="1" aria-label="Una bomboniera in più">+</button></span></div>
      <p class="small muted">${h.allNo ? 'Il nucleo non viene: le sue bomboniere non sono conteggiate.' : 'Di solito una per nucleo. Si contano se almeno una persona viene o se la risposta è ancora in attesa.'}</p>
      ${g.notes ? `<div class="detail-notes"><p>${esc(g.notes)}</p></div>` : ''}`;
    openSheet(html, { refresh: () => openGuest(id, { focus: false }), focus: opts.focus !== false });
  }

  const memberRow = (m = {}) => `<div class="m-row">
      <input type="hidden" name="m_id" value="${esc(m.id || '')}"><input type="hidden" name="m_rsvp" value="${esc(m.rsvp || '')}">
      <label class="vh">Nome</label><input type="text" name="m_name" value="${esc(m.name || '')}" placeholder="Nome e cognome" autocapitalize="words">
      <label class="vh">Età</label><select name="m_kind">${Object.entries(KINDS).map(([k, l]) => `<option value="${k}" ${k === (m.kind || 'adulto') ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button type="button" class="x" data-action="remove-member-row" aria-label="Togli questa persona">${ICON_X}</button>
    </div>`;
  const sidePicker = (cur) => `<fieldset class="field"><legend>Di chi sono invitati</legend><div class="seg-ctl">
      ${[['a', state.settings.name1 || 'Sposa'], ['b', state.settings.name2 || 'Sposo'], ['', 'Entrambi']].map(([v, l]) => `<label><input type="radio" name="side" value="${v}" ${v === (cur || '') ? 'checked' : ''}><span>${esc(l)}</span></label>`).join('')}
    </div></fieldset>`;

  function openGuestForm(id) {
    const g = id ? findGuest(id) : null;
    const members = g ? g.members : [{}];
    openSheet(`${head(g ? 'Modifica nucleo' : 'Nuovo nucleo')}
      <form data-form="guest" data-id="${g ? g.id : ''}" novalidate autocomplete="off">
        <label class="field"><span>Nome del nucleo</span><input type="text" name="name" value="${esc(g ? g.name : '')}" placeholder="Es. Famiglia Rossi, Zia Tina e zio Mario" autocapitalize="words" ${g ? '' : 'autofocus'}><span class="hint">Se lo lasciate vuoto, uso i nomi delle persone.</span></label>
        ${sidePicker(g ? g.side : ui.gside)}
        <fieldset class="field"><legend>Persone</legend><div id="m-rows">${members.map(memberRow).join('')}</div>
          <button type="button" class="link fill-btn" data-action="add-member-row">Aggiungi una persona</button>
          <span class="hint">Bambini e neonati si contano a parte per il catering.</span></fieldset>
        <label class="field"><span>Bomboniere per questo nucleo</span><input type="text" name="favors" inputmode="numeric" value="${g ? g.favors : 1}"></label>
        <label class="field"><span>Note</span><textarea name="notes" placeholder="Indirizzo, intolleranze, chi consegna la partecipazione…">${esc(g ? g.notes : '')}</textarea></label>
        <div class="form-actions"><button class="btn primary" type="submit">${g ? 'Salva modifiche' : 'Aggiungi nucleo'}</button>${g ? `<button class="btn danger" type="button" data-action="del-guest" data-id="${g.id}">Elimina</button>` : ''}</div>
      </form>`);
  }

  function openGuestBulk() {
    openSheet(`${head('Incolla un elenco')}
      <form data-form="guestBulk" novalidate autocomplete="off">
        <label class="field"><span>Un nucleo per riga</span><textarea name="list" rows="9" placeholder="Famiglia Rossi: Mario, Anna, Luca (b)&#10;Zia Tina e zio Mario&#10;Giulia Bianchi" autofocus></textarea>
          <span class="hint">Separate le persone con una virgola o con «e». Scrivete (b) dopo i bambini e (n) dopo i neonati. Per dare un nome al nucleo scrivetelo prima dei due punti.</span></label>
        ${sidePicker(ui.gside)}
        <div class="form-actions"><button class="btn primary" type="submit">Aggiungi alla lista</button></div>
      </form>`);
  }
  function parseGuestLines(text) {
    return String(text || '').split(/\n+/).map((l) => l.trim().replace(/^[-•*\d.)\s]+/, '').trim()).filter(Boolean).map((line) => {
      let name = '', rest = line;
      const i = line.indexOf(':');
      if (i > 0) { name = line.slice(0, i).trim(); rest = line.slice(i + 1); }
      const members = rest.split(/,|;|\s+e\s+|\s+\+\s+/i).map((x) => x.trim()).filter(Boolean).map((p) => {
        let kind = 'adulto';
        const m = p.match(/\(\s*(b|bimb[oa]|bambin[oa]|n|neonat[oa])\s*\)\s*$/i);
        if (m) { kind = /^n/i.test(m[1]) ? 'neonato' : 'bambino'; p = p.slice(0, m.index).trim(); }
        return { id: uid(), name: p, kind, rsvp: '' };
      });
      if (!name) name = rest.replace(/\(\s*(b|bimb[oa]|bambin[oa]|n|neonat[oa])\s*\)/gi, '').replace(/\s+/g, ' ').trim();
      return { name, members };
    }).filter((x) => x.members.length);
  }

  function csvGuests() {
    const q = (v) => { const s = String(v ?? ''); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows = [['Nucleo', 'Lato', 'Persona', 'Età', 'Risposta', 'Partecipazione', 'Consegnata il', 'Come', 'Bomboniere', 'Note']];
    const list = liveGuests().sort((a, b) => (a.side || 'z').localeCompare(b.side || 'z') || a.name.localeCompare(b.name, 'it'));
    for (const g of list) {
      g.members.forEach((m, i) => rows.push([
        g.name, sideLabel(g.side), m.name, KINDS[m.kind], m.rsvp === 'si' ? 'Viene' : m.rsvp === 'no' ? 'Non viene' : 'In attesa',
        g.invite.delivered ? 'Consegnata' : 'Da consegnare', g.invite.date ? fmtDate(g.invite.date, { day: '2-digit', month: '2-digit', year: 'numeric' }) : '', g.invite.how,
        i === 0 ? (householdStats(g).allNo ? 0 : g.favors) : '', i === 0 ? g.notes : ''
      ]));
    }
    const s = guestStats();
    rows.push([]);
    rows.push(['Totale', '', `${s.people} persone`, '', `${s.yes} vengono, ${s.wait} in attesa, ${s.no} no`, `${s.delivered} consegnate su ${s.households}`, '', '', s.favors]);
    return '﻿' + rows.map((r) => r.map(q).join(';')).join('\r\n');
  }

  function sampleGuests() {
    const d = (n) => addDays(todayISO(), n);
    const G = (name, side, members, extra = {}) => normGuest({ name, side, members: members.map(([n, kind = 'adulto', rsvp = '']) => ({ name: n, kind, rsvp })), sample: true, updatedAt: now(), ...extra });
    return [
      G('Famiglia Rossi', 'a', [['Mario Rossi', 'adulto', 'si'], ['Anna Rossi', 'adulto', 'si'], ['Luca', 'bambino', 'si']], { invite: { delivered: true, date: d(-20), how: 'A mano' } }),
      G('Zia Tina e zio Piero', 'a', [['Tina'], ['Piero']], { invite: { delivered: true, date: d(-12), how: 'Per posta' } }),
      G('Nonna Elena', 'a', [['Elena', 'adulto', 'si']], { invite: { delivered: true, date: d(-30), how: 'A mano' } }),
      G('Paolo e Sara', 'b', [['Paolo', 'adulto', 'si'], ['Sara', 'adulto', 'no']], { invite: { delivered: true, date: d(-8), how: 'Digitale' } }),
      G('Famiglia Bianchi', 'b', [['Giorgio Bianchi'], ['Laura Bianchi'], ['Emma', 'neonato']]),
      G('Colleghi di lavoro', '', [['Marco'], ['Chiara'], ['Davide', 'adulto', 'no']], { favors: 3 })
    ];
  }

  /* ---------------- rendering ---------------- */
  const view = $('#view');
  function render({ keepScroll = true } = {}) {
    const y = window.scrollY;
    const html = ui.tab === 'items' ? viewItems() : ui.tab === 'due' ? viewDue() : ui.tab === 'guests' ? viewGuests() : ui.tab === 'settings' ? viewSettings() : viewHome();
    view.innerHTML = html;
    document.querySelectorAll('.tabs button').forEach((b) => {
      if (b.dataset.tab === ui.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    const fab = $('#fab');
    const onGuests = ui.tab === 'guests';
    fab.dataset.action = onGuests ? 'new-guest' : 'new-item';
    $('#fab-label').textContent = onGuests ? 'Aggiungi invitati' : 'Aggiungi spesa';
    fab.hidden = ui.tab === 'settings' || (ui.tab === 'home' && !live().length) || (onGuests && !liveGuests().length);
    if (keepScroll) window.scrollTo(0, y);
  }
  function go(tab) {
    ui.tab = tab;
    try { sessionStorage.setItem('spese-nozze:tab', tab); } catch (e) { /* niente */ }
    render({ keepScroll: false });
    window.scrollTo(0, 0);
  }
  function commit(msg, undoSnapshot) {
    save();
    render();
    if (sheet.open && sheetRefresh) sheetRefresh();
    if (msg) toast(msg, undoSnapshot);
  }

  /* ---------------- foglio ---------------- */
  const sheet = $('#sheet');
  const sheetBody = $('#sheet-body');
  let sheetRefresh = null;
  let lastFocus = null;
  function openSheet(html, { refresh = null, focus = true } = {}) {
    if (!sheet.open) lastFocus = document.activeElement;
    sheetBody.innerHTML = html;
    sheetBody.scrollTop = 0;
    sheetRefresh = refresh;
    if (!sheet.open) {
      if (typeof sheet.showModal === 'function') sheet.showModal(); else sheet.setAttribute('open', '');
      document.body.classList.add('locked');
    }
    if (focus) {
      const f = sheetBody.querySelector('[autofocus]') || sheetBody.querySelector('h2');
      if (f) { if (!f.hasAttribute('tabindex') && f.tagName === 'H2') f.setAttribute('tabindex', '-1'); f.focus({ preventScroll: true }); }
    }
  }
  function closeSheet() {
    if (sheet.open) { if (typeof sheet.close === 'function') sheet.close(); else sheet.removeAttribute('open'); }
  }
  sheet.addEventListener('close', () => {
    // l'evento arriva in ritardo: se nel frattempo il foglio è stato riaperto, non va toccato
    if (sheet.open) return;
    document.body.classList.remove('locked');
    sheetRefresh = null;
    sheetBody.innerHTML = '';
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
  });
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
  const head = (title, kicker = '', extra = '') => `<div class="sheet-head"><div>${kicker ? `<p class="kicker">${esc(kicker)}</p>` : ''}<h2 id="sheet-title">${esc(title)}</h2></div><div style="display:flex;gap:.25rem;align-items:center">${extra}<button type="button" class="x" data-action="close" aria-label="Chiudi">${ICON_X}</button></div></div>`;

  /* dettaglio spesa */
  function openItem(id, opts = {}) {
    const it = findItem(id);
    if (!it) { closeSheet(); return; }
    const s = itemStats(it);
    const pays = [...it.payments].sort((a, b) => (a.status === b.status ? 0 : a.status === 'paid' ? -1 : 1) || (a.date || '9999').localeCompare(b.date || '9999'));
    const contact = it.contact.trim();
    let contactHtml = '';
    if (contact) {
      const tel = contact.replace(/[^\d+]/g, '');
      contactHtml = /@/.test(contact) ? `<a href="mailto:${esc(contact)}">${esc(contact)}</a>` : (tel.length >= 6 ? `<a href="tel:${esc(tel)}">${esc(contact)}</a>` : esc(contact));
    }
    const html = `${head(it.name, it.category + (it.estimate ? ', preventivo' : ''), `<button type="button" class="btn small" data-action="edit-item" data-id="${it.id}">Modifica</button>`)}
      <dl class="figs">
        <div><dt>${it.total ? 'Concordato' : 'Totale'}</dt><dd>${s.total ? money(s.total) : 'da definire'}</dd></div>
        <div><dt>Pagato</dt><dd>${money(s.paid)}</dd></div>
        <div class="em"><dt>Da pagare</dt><dd>${money(s.toPay)}</dd></div>
      </dl>
      ${s.total ? bar({ paid: s.paid, toPay: s.toPay, thin: true }) : ''}
      ${s.excess ? `<div class="callout warn"><p>I pagamenti superano di ${money(s.excess)} l'importo concordato. Aggiornate l'importo o correggete un pagamento.</p></div>` : ''}
      ${s.unscheduled > 0 ? `<div class="callout"><p>${money(s.unscheduled)} da pagare senza una data.</p><div class="btns" style="margin-top:.6rem"><button type="button" class="btn small" data-action="schedule" data-item="${it.id}">Fissa una scadenza</button><button type="button" class="btn small primary" data-action="pay-rest" data-item="${it.id}">Registra pagamento</button></div></div>` : ''}
      <h3 class="subhead">Pagamenti</h3>
      ${pays.length ? `<ul class="list" style="margin-top:.5rem">${pays.map((p) => payRow({ it, p }, { showItem: false })).join('')}</ul>` : '<p class="muted" style="margin-top:.4rem">Nessun pagamento registrato.</p>'}
      <div class="btns" style="margin-top:1rem"><button type="button" class="btn primary" data-action="new-pay" data-item="${it.id}" data-status="paid">Registra pagamento</button><button type="button" class="btn" data-action="new-pay" data-item="${it.id}" data-status="due">Aggiungi scadenza</button></div>
      ${contactHtml || it.notes ? `<div class="detail-notes">${contactHtml ? `<p>${contactHtml}</p>` : ''}${it.notes ? `<p style="margin-top:.5rem">${esc(it.notes)}</p>` : ''}</div>` : ''}`;
    openSheet(html, { refresh: () => openItem(id, { focus: false }), focus: opts.focus !== false });
  }

  /* modulo spesa */
  function catOptions(selected) {
    const list = [...state.categories];
    if (selected && !list.includes(selected)) list.push(selected);
    return list.map((c) => `<option ${c === selected ? 'selected' : ''}>${esc(c)}</option>`).join('') + '<option value="__new">Nuova categoria…</option>';
  }
  function payerOptions(selected) {
    const list = payers();
    if (selected && !list.includes(selected)) list.push(selected);
    return '<option value="">Non indicato</option>' + list.map((p) => `<option ${p === selected ? 'selected' : ''}>${esc(p)}</option>`).join('');
  }
  function methodOptions(selected) {
    return '<option value="">Non indicato</option>' + METHODS.map((m) => `<option ${m === selected ? 'selected' : ''}>${m}</option>`).join('');
  }
  function openItemForm(id) {
    const it = id ? findItem(id) : null;
    const isNew = !it;
    const cat = it ? it.category : (ui.cat || state.categories[0] || 'Altro');
    const html = `${head(isNew ? 'Nuova spesa' : 'Modifica spesa')}
      <form data-form="item" data-id="${it ? it.id : ''}" novalidate autocomplete="off">
        <label class="field"><span>Fornitore o voce</span><input type="text" name="name" value="${esc(it ? it.name : '')}" placeholder="Es. Villa Le Rose" required ${isNew ? 'autofocus' : ''} autocapitalize="sentences"></label>
        <label class="field"><span>Tipo di spesa</span><select name="category">${catOptions(cat)}</select></label>
        <label class="field"><span>Importo totale concordato</span><input type="text" name="total" inputmode="decimal" value="${esc(it ? amountToInput(it.total) : '')}" placeholder="Es. 12.500"><span class="hint">Se non lo sapete ancora lasciate vuoto.</span></label>
        <label class="check-field"><input type="checkbox" name="estimate" ${it && it.estimate ? 'checked' : ''}><span>È un preventivo, l'importo non è ancora confermato</span></label>
        ${isNew ? `<h3 class="subhead">Acconto già versato</h3>
        <div class="grid2">
          <label class="field"><span>Importo</span><input type="text" name="dep" inputmode="decimal" placeholder="Facoltativo"></label>
          <label class="field"><span>Pagato il</span><input type="date" name="depDate" value="${todayISO()}"></label>
        </div>
        <label class="field"><span>Chi ha pagato</span><select name="depPayer">${payerOptions('')}</select></label>` : ''}
        <label class="field"><span>Contatto</span><input type="text" name="contact" value="${esc(it ? it.contact : '')}" placeholder="Telefono o email, facoltativo"></label>
        <label class="field"><span>Note</span><textarea name="notes" placeholder="Cosa è incluso, condizioni, penali…">${esc(it ? it.notes : '')}</textarea></label>
        <div class="form-actions">
          <button class="btn primary" type="submit">${isNew ? 'Aggiungi spesa' : 'Salva modifiche'}</button>
          ${isNew ? '' : `<button class="btn danger" type="button" data-action="del-item" data-id="${it.id}">Elimina</button>`}
        </div>
      </form>`;
    openSheet(html);
  }

  /* modulo pagamento */
  function openPayForm(itemId, payId, preset = {}) {
    const it = findItem(itemId);
    if (!it) return;
    const p = payId ? it.payments.find((x) => x.id === payId) : null;
    const s = itemStats(it);
    const status = p ? p.status : (preset.status || 'paid');
    const amount = p ? p.amount : (preset.amount || 0);
    const type = p ? p.type : (preset.type || (s.paid === 0 ? 'Acconto' : 'Rata'));
    const date = p ? p.date : (preset.date ?? (status === 'paid' ? todayISO() : ''));
    // residuo disponibile per il pulsante "tutto il residuo"
    const rest = s.unscheduled + (p && p.status === 'due' ? p.amount : 0);
    const html = `${head(p ? 'Modifica pagamento' : (status === 'paid' ? 'Registra pagamento' : 'Nuova scadenza'), it.name)}
      <form data-form="pay" data-item="${it.id}" data-pay="${p ? p.id : ''}" novalidate autocomplete="off">
        <fieldset class="field"><legend>Stato</legend>
          <div class="seg-ctl">
            <label><input type="radio" name="status" value="paid" ${status === 'paid' ? 'checked' : ''}><span>Già pagato</span></label>
            <label><input type="radio" name="status" value="due" ${status === 'due' ? 'checked' : ''}><span>Da pagare</span></label>
          </div>
        </fieldset>
        <fieldset class="field"><legend>Tipo</legend>
          <div class="seg-ctl">${PAY_TYPES.map((t) => `<label><input type="radio" name="type" value="${t}" ${t === type ? 'checked' : ''}><span>${t}</span></label>`).join('')}</div>
        </fieldset>
        <label class="field"><span>Importo</span><input type="text" name="amount" inputmode="decimal" value="${esc(amountToInput(amount))}" placeholder="Es. 1.500" ${p ? '' : 'autofocus'}>
          ${rest > 0 ? `<button type="button" class="link fill-btn" data-action="fill-rest" data-v="${rest}">Usa tutto il residuo: ${money(rest)}</button>` : ''}
        </label>
        <label class="field"><span data-date-label>${status === 'paid' ? 'Pagato il' : 'Scadenza'}</span><input type="date" name="date" value="${esc(date)}"></label>
        <div class="grid2" data-paid-only ${status === 'paid' ? '' : 'hidden'}>
          <label class="field"><span>Chi ha pagato</span><select name="payer">${payerOptions(p ? p.payer : '')}</select></label>
          <label class="field"><span>Metodo</span><select name="method">${methodOptions(p ? p.method : '')}</select></label>
        </div>
        <label class="field"><span>Nota</span><input type="text" name="note" value="${esc(p ? p.note : '')}" placeholder="Es. alla firma del contratto"></label>
        <div class="form-actions">
          <button class="btn primary" type="submit">${p ? 'Salva modifiche' : (status === 'paid' ? 'Registra pagamento' : 'Aggiungi scadenza')}</button>
          <button class="btn" type="button" data-action="open-item" data-id="${it.id}">Indietro</button>
          ${p ? `<button class="btn danger" type="button" data-action="del-pay" data-item="${it.id}" data-pay="${p.id}">Elimina</button>` : ''}
        </div>
      </form>`;
    openSheet(html);
  }

  function fieldError(input, msg) {
    input.setAttribute('aria-invalid', 'true');
    const label = input.closest('.field');
    let e = label && label.querySelector('.err');
    if (!e && label) { e = document.createElement('span'); e.className = 'err'; label.appendChild(e); }
    if (e) e.textContent = msg;
    input.focus();
  }

  /* ---------------- toast ---------------- */
  const toastEl = $('#toast');
  let toastTimer = null;
  function toast(msg, undoSnapshot) {
    clearTimeout(toastTimer);
    toastEl.innerHTML = `<span>${esc(msg)}</span>${undoSnapshot ? '<button type="button" data-action="undo">Annulla</button>' : ''}`;
    toastEl.hidden = false;
    toastEl._undo = undoSnapshot || null;
    // il toast deve stare sopra al dialog modale
    if (sheet.open) sheet.appendChild(toastEl); else document.body.appendChild(toastEl);
    toastTimer = setTimeout(() => { toastEl.hidden = true; toastEl._undo = null; }, undoSnapshot ? 6000 : 3500);
  }
  const snapshot = () => JSON.stringify(state);

  /* ---------------- backup e import ---------------- */
  function payload() {
    return { app: APP_ID, v: 1, exportedAt: now(), settings: state.settings, categories: state.categories, catU: state.catU, items: state.items.filter((i) => !i.sample && !i.deleted), guests: state.guests.filter((g) => !g.sample && !g.deleted), gcfg: state.gcfg };
  }
  const b64u = {
    enc(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
    dec(str) { const s = str.replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(s + '==='.slice((s.length + 3) % 4)); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  };
  function parseIncoming(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('Il contenuto non è leggibile.'); }
    if (!data || data.app !== APP_ID || !Array.isArray(data.items)) throw new Error('Questi dati non provengono da questa app.');
    return normalize(data);
  }
  function describeIncoming(inc) {
    const n = inc.items.filter((i) => !i.deleted).length;
    const gn = inc.guests.filter((g) => !g.deleted).length;
    const names = [inc.settings.name1, inc.settings.name2].filter(Boolean).join(' e ');
    return `${n} ${n === 1 ? 'spesa' : 'spese'}${gn ? ` e ${gn} ${gn === 1 ? 'nucleo' : 'nuclei'} di invitati` : ''}${names ? ` di ${names}` : ''}`;
  }
  function mergeIncoming(inc) {
    let added = 0, updated = 0, removed = 0;
    // l'esempio non va mescolato a dati reali
    state.items = state.items.filter((i) => !i.sample);
    const map = new Map(state.items.map((i) => [i.id, i]));
    for (const it of inc.items) {
      const cur = map.get(it.id);
      if (!cur) { map.set(it.id, it); if (!it.deleted) added++; continue; }
      if ((it.updatedAt || 0) > (cur.updatedAt || 0)) {
        if (it.deleted && !cur.deleted) removed++; else if (!it.deleted) updated++;
        map.set(it.id, it);
      }
    }
    state.items = [...map.values()];
    if ((inc.settings.updatedAt || 0) > (state.settings.updatedAt || 0)) state.settings = inc.settings;
    const before = state.categories.length;
    for (const c of inc.categories) if (!state.categories.includes(c)) state.categories.push(c);
    if (state.categories.length !== before) touchCategories();
    state.guests = state.guests.filter((g) => !g.sample);
    const gmap = new Map(state.guests.map((g) => [g.id, g]));
    for (const g of inc.guests) {
      const cur = gmap.get(g.id);
      if (!cur) { gmap.set(g.id, g); if (!g.deleted) added++; continue; }
      if ((g.updatedAt || 0) > (cur.updatedAt || 0)) { if (!g.deleted) updated++; gmap.set(g.id, g); }
    }
    state.guests = [...gmap.values()];
    if ((inc.gcfg.updatedAt || 0) > (state.gcfg.updatedAt || 0)) state.gcfg = inc.gcfg;
    return { added, updated, removed };
  }
  /** Sostituisce i dati con quelli importati. Le nuove versioni devono "vincere"
      anche sull'altro telefono, quindi ricevono la data di adesso. */
  function replaceWith(inc) {
    const t = now();
    const keep = new Set(inc.items.map((i) => i.id));
    const tombs = state.items.filter((i) => !i.sample && !i.deleted && !keep.has(i.id)).map((i) => normItem({ id: i.id, deleted: true, updatedAt: t }));
    inc.items.forEach((i) => { i.updatedAt = t; });
    const gkeep = new Set(inc.guests.map((g) => g.id));
    const gtombs = state.guests.filter((g) => !g.sample && !g.deleted && !gkeep.has(g.id)).map((g) => normGuest({ id: g.id, deleted: true, updatedAt: t }));
    inc.guests.forEach((g) => { g.updatedAt = t; });
    state = { ...inc, items: [...inc.items, ...tombs], guests: [...inc.guests, ...gtombs], gcfg: { ...inc.gcfg, updatedAt: t }, settings: { ...inc.settings, updatedAt: t }, catU: t, meta: { ...state.meta, onboarded: true } };
  }
  function openIncoming(inc, source) {
    const html = `${head('Dati da importare', source)}
      <p>Contiene ${esc(describeIncoming(inc))}.</p>
      <p class="muted" style="margin-top:.6rem">Unendo, ogni spesa prende la versione modificata più di recente tra le due. Sostituendo, le spese attuali vengono rimpiazzate${sync.conf.code ? ' anche sull\'altro telefono' : ''}.</p>
      <div class="form-actions"><button type="button" class="btn primary" data-action="merge-confirm">Unisci ai miei dati</button><button type="button" class="btn danger" data-action="replace-confirm">Sostituisci tutto</button></div>`;
    pendingIncoming = inc;
    openSheet(html);
  }
  let pendingIncoming = null;

  /* ---------------- sincronizzazione in tempo reale ----------------
     Protocollo con il server (worker/index.js):
       → {t:'hello', since}         ← {t:'sync', records, seq, reset}
       → {t:'put', records}         ← {t:'ack', ack, seq}
                                    ← {t:'changes', records, seq}  (modifiche dell'altro telefono)
     Un record è {id, u (data modifica), d (eliminato), c (contenuto cifrato)}. */
  const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{25}$/;
  const newPairCode = () => Array.from(crypto.getRandomValues(new Uint8Array(25)), (x) => CROCKFORD[x & 31]).join('');
  const normCode = (s) => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  const fmtCode = (c) => (c.match(/.{1,5}/g) || []).join('-');

  function loadSync() {
    try {
      const s = JSON.parse(localStorage.getItem(SYNC_KEY) || 'null');
      if (s && CODE_RE.test(s.code || '')) return { code: s.code, lastSeq: Math.max(0, toInt(s.lastSeq)), pushed: s.pushed && typeof s.pushed === 'object' ? s.pushed : {} };
    } catch (e) { /* niente */ }
    return { code: '', lastSeq: 0, pushed: {} };
  }
  const sync = {
    conf: loadSync(), status: 'off', ws: null, key: null, room: '', retry: 0,
    retryTimer: 0, pingTimer: 0, flushTimer: 0, lastPong: 0, inflight: {},
    queue: Promise.resolve(), hiddenAt: 0, lastToast: 0
  };
  if (sync.conf.code) sync.status = 'connecting';
  function saveSync() { try { localStorage.setItem(SYNC_KEY, JSON.stringify(sync.conf)); } catch (e) { /* niente */ } }

  async function deriveKeys(code) {
    const enc = new TextEncoder();
    const roomBuf = await crypto.subtle.digest('SHA-256', enc.encode(`ourwedding:room:${code}`));
    const keyBuf = await crypto.subtle.digest('SHA-256', enc.encode(`ourwedding:key:${code}`));
    sync.room = Array.from(new Uint8Array(roomBuf), (b) => b.toString(16).padStart(2, '0')).join('');
    sync.key = await crypto.subtle.importKey('raw', keyBuf, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  async function encrypt(id, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(id) }, sync.key, new TextEncoder().encode(JSON.stringify(obj))));
    const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
    return b64u.enc(out);
  }
  async function decrypt(id, c) {
    const bytes = b64u.dec(c);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: new TextEncoder().encode(id) }, sync.key, bytes.subarray(12));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  function localRecords() {
    const out = [];
    for (const it of state.items) {
      if (it.sample) continue;
      const { sample, ...data } = it;
      out.push({ id: it.id, u: it.updatedAt || 0, d: it.deleted, obj: it.deleted ? { id: it.id, deleted: true } : data });
    }
    if (state.settings.updatedAt) out.push({ id: '_settings', u: state.settings.updatedAt, d: false, obj: state.settings });
    if (state.catU) out.push({ id: '_categories', u: state.catU, d: false, obj: state.categories });
    for (const g of state.guests) {
      if (g.sample) continue;
      const { sample, ...data } = g;
      out.push({ id: g.id, u: g.updatedAt || 0, d: g.deleted, k: 'g', obj: g.deleted ? { id: g.id, deleted: true } : data });
    }
    if (state.gcfg.updatedAt) out.push({ id: '_guestcfg', u: state.gcfg.updatedAt, d: false, k: 'g', obj: state.gcfg });
    return out;
  }
  const pending = () => localRecords().filter((r) => r.u > (sync.conf.pushed[r.id] || 0) && r.u > (sync.inflight[r.id] || 0));

  function scheduleFlush() {
    if (!sync.conf.code) return;
    clearTimeout(sync.flushTimer);
    sync.flushTimer = setTimeout(flush, 120);
    setSyncStatus();
  }
  async function flush() {
    const ws = sync.ws;
    if (!ws || ws.readyState !== 1 || !sync.key) return;
    const recs = pending();
    for (let i = 0; i < recs.length; i += 100) {
      const chunk = recs.slice(i, i + 100);
      chunk.forEach((r) => { sync.inflight[r.id] = r.u; });
      const records = await Promise.all(chunk.map(async (r) => ({ id: r.id, u: r.u, d: r.d ? 1 : 0, k: r.k || 'i', c: await encrypt(r.id, r.obj) })));
      if (sync.ws !== ws || ws.readyState !== 1) { sync.inflight = {}; return; }
      ws.send(JSON.stringify({ t: 'put', records }));
    }
    setSyncStatus();
  }

  /** Applica i record arrivati dal server. Restituisce true se qualcosa è cambiato. */
  async function applyRemote(records) {
    let changed = false;
    for (const r of records || []) {
      sync.conf.pushed[r.id] = Math.max(sync.conf.pushed[r.id] || 0, r.u);
      let obj;
      try { obj = await decrypt(r.id, r.c); } catch (e) { continue; }
      if (r.k === 'g') {
        if (r.id === '_guestcfg') {
          if (r.u > (state.gcfg.updatedAt || 0)) { state.gcfg = normGcfg({ ...obj, updatedAt: r.u }); changed = true; }
          continue;
        }
        const g = normGuest({ ...obj, id: r.id, updatedAt: r.u, deleted: !!r.d || !!obj.deleted, sample: false });
        const gi = state.guests.findIndex((x) => x.id === r.id);
        if (gi < 0) { state.guests.push(g); changed = true; }
        else if (r.u > (state.guests[gi].updatedAt || 0)) { state.guests[gi] = g; changed = true; }
        continue;
      }
      if (r.id === '_settings') {
        if (r.u > (state.settings.updatedAt || 0)) { state.settings = { ...normalize({ settings: obj }).settings, updatedAt: r.u }; changed = true; }
        continue;
      }
      if (r.id === '_categories') {
        if (r.u > (state.catU || 0) && Array.isArray(obj) && obj.length) { state.categories = obj.map(String); state.catU = r.u; changed = true; }
        continue;
      }
      const it = normItem({ ...obj, id: r.id, updatedAt: r.u, deleted: !!r.d || !!obj.deleted, sample: false });
      const idx = state.items.findIndex((i) => i.id === r.id);
      if (idx < 0) { state.items.push(it); changed = true; }
      else if (r.u > (state.items[idx].updatedAt || 0)) { state.items[idx] = it; changed = true; }
    }
    return changed;
  }
  function afterRemote(notify) {
    state.meta.lastSync = now();
    if (live().some((i) => !i.sample) || liveGuests().some((g) => !g.sample)) state.meta.onboarded = true;
    save();
    render();
    // il dettaglio aperto si aggiorna; un modulo in compilazione resta com'è
    if (sheet.open && sheetRefresh) sheetRefresh();
    if (notify && now() - sync.lastToast > 4000) { sync.lastToast = now(); toast("Aggiornato dall'altro telefono"); }
  }
  async function handleMessage(m) {
    if (m.t === 'sync') {
      if (m.reset) sync.conf.pushed = {};
      const changed = await applyRemote(m.records);
      sync.conf.lastSeq = toInt(m.seq);
      saveSync();
      if (changed) afterRemote(false);
      setSyncStatus('online');
      flush();
    } else if (m.t === 'changes') {
      const changed = await applyRemote(m.records);
      sync.conf.lastSeq = Math.max(sync.conf.lastSeq, toInt(m.seq));
      saveSync();
      if (changed) afterRemote(true);
    } else if (m.t === 'ack') {
      for (const a of m.ack || []) {
        sync.conf.pushed[a.id] = Math.max(sync.conf.pushed[a.id] || 0, a.u);
        if ((sync.inflight[a.id] || 0) <= a.u) delete sync.inflight[a.id];
      }
      sync.conf.lastSeq = Math.max(sync.conf.lastSeq, toInt(m.seq));
      saveSync();
      setSyncStatus();
      if (pending().length) scheduleFlush();
    }
  }

  async function connect() {
    clearTimeout(sync.retryTimer);
    if (!sync.conf.code) { setSyncStatus('off'); return; }
    if (sync.ws && sync.ws.readyState <= 1) return;
    if (!window.crypto || !crypto.subtle) { setSyncStatus('offline'); return; }
    if (!sync.key) await deriveKeys(sync.conf.code);
    if (navigator.onLine === false) { setSyncStatus('offline'); return; }
    setSyncStatus(sync.retry > 2 ? 'offline' : 'connecting');
    const url = new URL(`/api/rooms/${sync.room}/ws`, location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try { ws = new WebSocket(url.href); } catch (e) { reconnectLater(); return; }
    sync.ws = ws;
    sync.inflight = {};
    ws.onopen = () => {
      sync.retry = 0;
      sync.lastPong = Date.now();
      ws.send(JSON.stringify({ t: 'hello', since: sync.conf.lastSeq, v: 2 }));
      flush();
      clearInterval(sync.pingTimer);
      sync.pingTimer = setInterval(() => {
        if (sync.ws !== ws || ws.readyState !== 1) return;
        if (Date.now() - sync.lastPong > 50000) { dropConnection(); return; }
        try { ws.send('ping'); } catch (e) { /* niente */ }
      }, 20000);
    };
    ws.onmessage = (e) => {
      if (e.data === 'pong') { sync.lastPong = Date.now(); return; }
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      sync.lastPong = Date.now();
      sync.queue = sync.queue.then(() => handleMessage(m)).catch((err) => console.warn('Sincronizzazione', err));
    };
    ws.onclose = () => { if (sync.ws === ws) { sync.ws = null; clearInterval(sync.pingTimer); sync.inflight = {}; reconnectLater(); } };
    ws.onerror = () => { /* segue onclose */ };
  }
  function dropConnection() {
    const ws = sync.ws;
    sync.ws = null;
    clearInterval(sync.pingTimer);
    sync.inflight = {};
    if (ws) { try { ws.close(); } catch (e) { /* niente */ } }
  }
  function reconnectLater() {
    if (!sync.conf.code) return;
    clearTimeout(sync.retryTimer);
    const delays = [500, 1500, 3000, 6000, 12000, 20000, 30000];
    const d = delays[Math.min(sync.retry, delays.length - 1)];
    sync.retry++;
    setSyncStatus(navigator.onLine === false || sync.retry > 2 ? 'offline' : 'connecting');
    sync.retryTimer = setTimeout(connect, d);
  }
  function reconnectNow() { sync.retry = 0; dropConnection(); connect(); }

  function syncText() {
    const n = sync.conf.code ? pending().length : 0;
    const mods = `${n} ${n === 1 ? 'modifica' : 'modifiche'}`;
    switch (sync.status) {
      case 'online': return n ? 'Invio in corso…' : 'Sincronizzato in tempo reale';
      case 'connecting': return 'Connessione in corso…';
      case 'offline': return n ? `Offline, ${mods} da inviare` : 'Offline, si aggiorna al ritorno della rete';
      default: return '';
    }
  }
  const syncPill = () => `<p class="sync-pill" data-sync-pill data-state="${sync.status}"><i aria-hidden="true"></i><span>${esc(syncText())}</span></p>`;
  function setSyncStatus(s) {
    if (s) sync.status = s;
    document.querySelectorAll('[data-sync-pill]').forEach((el) => {
      el.dataset.state = sync.status;
      const sp = el.querySelector('span');
      if (sp) sp.textContent = syncText();
    });
  }
  function pairWith(code) {
    dropConnection();
    clearTimeout(sync.retryTimer);
    sync.conf = { code, lastSeq: 0, pushed: {} };
    sync.key = null;
    sync.retry = 0;
    saveSync();
    // l'esempio non va mai inviato all'altro telefono
    state.items = state.items.filter((i) => !i.sample);
    state.guests = state.guests.filter((g) => !g.sample);
    save();
    connect();
  }
  function unpair() {
    dropConnection();
    clearTimeout(sync.retryTimer);
    sync.conf = { code: '', lastSeq: 0, pushed: {} };
    sync.key = null;
    saveSync();
    setSyncStatus('off');
  }
  function openPairCode() {
    const code = sync.conf.code;
    const link = `${location.origin}${location.pathname}#coppia=${code}`;
    openSheet(`${head('Codice di coppia')}
      <p>Sull'altro telefono aprite l'app, andate in <strong>Impostazioni</strong>, toccate <strong>Ho già un codice</strong> e inserite:</p>
      <p class="pair-code" id="pair-code" aria-label="${esc(fmtCode(code).split('').join(' '))}">${fmtCode(code).split('-').map((g) => `<span>${esc(g)}</span>`).join('-<wbr>')}</p>
      <div class="form-actions"><button type="button" class="btn primary" data-action="copy-pair">Copia codice</button>${navigator.share ? '<button type="button" class="btn" data-action="share-pair">Condividi</button>' : ''}</div>
      <p class="small muted" style="margin-top:1.25rem">Chi ha questo codice può vedere e modificare le vostre spese: tenetelo tra voi due.</p>
      <input type="hidden" id="pair-link" value="${esc(link)}">`);
  }
  function openPairJoin(prefill = '') {
    openSheet(`${head('Collega questo telefono')}
      <form data-form="pair" novalidate autocomplete="off">
        <label class="field"><span>Codice di coppia</span><input type="text" name="code" value="${esc(prefill ? fmtCode(normCode(prefill)) : '')}" placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" autocapitalize="characters" spellcheck="false" autofocus><span class="hint">Lo trovate sull'altro telefono in Impostazioni, Mostra il codice di coppia.</span></label>
        ${live().some((i) => !i.sample) ? '<p class="small muted" style="margin-top:1rem">Le spese già presenti su questo telefono verranno unite a quelle dell\'altro.</p>' : ''}
        <div class="form-actions"><button class="btn primary" type="submit">Collega</button></div>
      </form>`);
  }

  async function shareOrDownload(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    try {
      const file = new File([blob], filename, { type: mime });
      if (navigator.canShare && navigator.canShare({ files: [file] }) && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
        await navigator.share({ files: [file], title: filename });
        return true;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return false;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  }
  function csv() {
    const q = (v) => { const s = String(v ?? ''); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const n = (c) => (c / 100).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
    const rows = [['Categoria', 'Voce', 'Totale', 'Pagato', 'Da pagare', 'Programmato', 'Senza data', 'Preventivo', 'Prossima scadenza', 'Contatto', 'Note']];
    const items = live().sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    for (const it of items) {
      const s = itemStats(it);
      const next = it.payments.filter((p) => p.status === 'due' && p.date).sort((a, b) => a.date.localeCompare(b.date))[0];
      rows.push([it.category, it.name, n(s.total), n(s.paid), n(s.toPay), n(s.sched), n(s.unscheduled), it.estimate ? 'sì' : 'no', next ? `${fmtDate(next.date, { day: '2-digit', month: '2-digit', year: 'numeric' })} (${n(next.amount)})` : '', it.contact, it.notes]);
    }
    const t = totals();
    rows.push([]);
    rows.push(['Totale', '', n(t.total), n(t.paid), n(t.toPay), n(t.sched), n(t.unscheduled)]);
    return '﻿' + rows.map((r) => r.map(q).join(';')).join('\r\n');
  }

  /* ---------------- esempio ---------------- */
  function sampleItems() {
    const d = (n) => addDays(todayISO(), n);
    const [a, b] = [state.settings.name1 || 'Giulia', state.settings.name2 || 'Marco'];
    const P = (amount, status, date, type, extra = {}) => ({ amount: amount * 100, status, date, type, ...extra });
    const I = (name, category, total, payments, extra = {}) => normItem({ name, category, total: total * 100, payments, sample: true, updatedAt: now(), ...extra });
    return [
      I('Villa Le Rose', 'Location e ricevimento', 16800, [P(3000, 'paid', d(-200), 'Acconto', { payer: 'Insieme', method: 'Bonifico', note: 'alla firma' }), P(6000, 'due', d(24), 'Rata')], { notes: '120 ospiti, menù di carne, open bar fino alle 2' }),
      I('Studio Luce', 'Foto e video', 3200, [P(800, 'paid', d(-150), 'Acconto', { payer: b, method: 'Bonifico' }), P(2400, 'due', d(190), 'Saldo')]),
      I('Atelier Bianco', 'Abito sposa', 2400, [P(1000, 'paid', d(-120), 'Acconto', { payer: a, method: 'Carta' }), P(1400, 'due', d(-3), 'Saldo', { note: 'alla seconda prova' })]),
      I('Gioielleria Conti', 'Fedi', 1100, [P(1100, 'paid', d(-40), 'Saldo', { payer: 'Insieme', method: 'Carta' })]),
      I('Verde Salvia', 'Fiori e allestimenti', 2500, [], { estimate: true }),
      I('Duo Aria', 'Musica', 1200, [P(300, 'paid', d(-60), 'Acconto', { payer: b, method: 'Contanti' })]),
      I('Tipografia Rossi', 'Partecipazioni e stampa', 450, [P(450, 'paid', d(-90), 'Saldo', { payer: a, method: 'Bonifico' })]),
      I('Confetteria Pelino', 'Bomboniere e confetti', 900, [P(200, 'paid', d(-10), 'Acconto', { payer: 'Famiglie', method: 'Contanti' })], { estimate: true })
    ];
  }

  /* ---------------- azioni ---------------- */
  const actions = {
    tab: (el) => { closeSheet(); if (el.dataset.tab !== 'items') ui.cat = ''; go(el.dataset.tab); },
    close: () => closeSheet(),
    'new-item': () => openItemForm(null),
    'open-item': (el) => openItem(el.dataset.id),
    'edit-item': (el) => openItemForm(el.dataset.id),
    'open-cat': (el) => { ui.cat = el.dataset.cat; ui.filter = 'all'; ui.q = ''; go('items'); },
    'clear-cat': () => { ui.cat = ''; render(); },
    filter: (el) => { ui.filter = el.dataset.f; render(); },
    'new-pay': (el) => openPayForm(el.dataset.item, null, { status: el.dataset.status }),
    'edit-pay': (el) => openPayForm(el.dataset.item, el.dataset.pay),
    schedule: (el) => { const it = findItem(el.dataset.item); if (it) openPayForm(it.id, null, { status: 'due', amount: itemStats(it).unscheduled, type: 'Saldo', date: validISO(state.settings.date) ? state.settings.date : '' }); },
    'pay-rest': (el) => { const it = findItem(el.dataset.item); if (it) openPayForm(it.id, null, { status: 'paid', amount: itemStats(it).unscheduled, type: itemStats(it).paid ? 'Saldo' : 'Acconto' }); },
    'fill-rest': (el) => { const inp = el.closest('form').elements.amount; inp.value = amountToInput(Number(el.dataset.v)); inp.removeAttribute('aria-invalid'); inp.focus(); },
    'mark-paid': (el) => {
      const it = findItem(el.dataset.item); if (!it) return;
      const p = it.payments.find((x) => x.id === el.dataset.pay); if (!p) return;
      const snap = snapshot();
      p.status = 'paid';
      const t = todayISO();
      if (!p.date || p.date > t) p.date = t;
      touch(it);
      commit(`${money(p.amount)} a ${it.name} segnati come pagati`, snap);
    },
    'del-item': (el) => {
      const it = findItem(el.dataset.id); if (!it) return;
      const snap = snapshot();
      const keep = { id: it.id, deleted: true, updatedAt: 0, name: '', category: '', payments: [] };
      Object.keys(it).forEach((k) => delete it[k]);
      Object.assign(it, normItem(keep));
      touch(it);
      closeSheet();
      commit('Spesa eliminata', snap);
    },
    'del-pay': (el) => {
      const it = findItem(el.dataset.item); if (!it) return;
      const snap = snapshot();
      it.payments = it.payments.filter((x) => x.id !== el.dataset.pay);
      touch(it);
      save(); render(); openItem(it.id);
      toast('Pagamento eliminato', snap);
    },
    undo: () => {
      const snap = toastEl._undo; if (!snap) return;
      const prev = normalize(JSON.parse(snap));
      // ciò che torna indietro deve "vincere" anche sull'altro telefono
      const t = now();
      const cur = new Map(state.items.map((i) => [i.id, JSON.stringify(i)]));
      prev.items.forEach((i) => { if (cur.get(i.id) !== JSON.stringify(i)) i.updatedAt = Math.max(t, (i.updatedAt || 0) + 1); });
      const prevIds = new Set(prev.items.map((i) => i.id));
      for (const i of state.items) if (!prevIds.has(i.id) && !i.sample) prev.items.push(normItem({ id: i.id, deleted: true, updatedAt: t }));
      if (JSON.stringify(prev.settings) !== JSON.stringify(state.settings)) prev.settings.updatedAt = t;
      if (JSON.stringify(prev.categories) !== JSON.stringify(state.categories)) prev.catU = t;
      const gcur = new Map(state.guests.map((g) => [g.id, JSON.stringify(g)]));
      prev.guests.forEach((g) => { if (gcur.get(g.id) !== JSON.stringify(g)) g.updatedAt = Math.max(t, (g.updatedAt || 0) + 1); });
      const gprevIds = new Set(prev.guests.map((g) => g.id));
      for (const g of state.guests) if (!gprevIds.has(g.id) && !g.sample) prev.guests.push(normGuest({ id: g.id, deleted: true, updatedAt: t }));
      if (JSON.stringify(prev.gcfg) !== JSON.stringify(state.gcfg)) prev.gcfg.updatedAt = t;
      state = prev;
      toastEl.hidden = true; toastEl._undo = null;
      save(); render();
      if (sheet.open && sheetRefresh) sheetRefresh();
    },
    'load-sample': () => { state.items.push(...sampleItems()); if (!liveGuests().length) state.guests.push(...sampleGuests()); state.meta.onboarded = true; commit('Esempio caricato'); },
    'clear-sample': () => { state.items = state.items.filter((i) => !i.sample); state.guests = state.guests.filter((g) => !g.sample); commit('Esempio eliminato'); },
    'new-guest': () => openGuestForm(null),
    'guest-bulk': () => openGuestBulk(),
    'open-guest': (el) => openGuest(el.dataset.id),
    'edit-guest': (el) => openGuestForm(el.dataset.id),
    'gfilter': (el) => { ui.gfilter = el.dataset.f; render(); },
    'del-guest': (el) => {
      const g = findGuest(el.dataset.id); if (!g) return;
      const snap = snapshot();
      const idx = state.guests.indexOf(g);
      state.guests[idx] = normGuest({ id: g.id, deleted: true, updatedAt: Math.max(now(), (g.updatedAt || 0) + 1) });
      closeSheet();
      commit('Nucleo eliminato', snap);
    },
    rsvp: (el) => {
      const g = findGuest(el.dataset.g); if (!g) return;
      const m = g.members.find((x) => x.id === el.dataset.m); if (!m) return;
      m.rsvp = el.dataset.v; touch(g); commit();
    },
    'rsvp-all': (el) => {
      const g = findGuest(el.dataset.g); if (!g) return;
      g.members.forEach((m) => { m.rsvp = el.dataset.v; }); touch(g); commit();
    },
    deliver: (el) => {
      const g = findGuest(el.dataset.g); if (!g) return;
      const snap = snapshot();
      g.invite = { delivered: true, date: todayISO(), how: el.dataset.how || '' }; touch(g);
      commit('Partecipazione consegnata', snap);
    },
    undeliver: (el) => {
      const g = findGuest(el.dataset.g); if (!g) return;
      g.invite = { delivered: false, date: '', how: '' }; touch(g); commit();
    },
    gfavors: (el) => {
      const g = findGuest(el.dataset.g); if (!g) return;
      g.favors = Math.max(0, Math.min(99, g.favors + Number(el.dataset.d))); touch(g); commit();
    },
    gspare: (el) => { state.gcfg.spare = Math.max(0, Math.min(999, (state.gcfg.spare || 0) + Number(el.dataset.d))); touchGcfg(); commit(); },
    'add-member-row': () => { const box = $('#m-rows'); if (!box) return; box.insertAdjacentHTML('beforeend', memberRow()); const ins = box.querySelectorAll('input[name="m_name"]'); ins[ins.length - 1].focus(); },
    'remove-member-row': (el) => { const box = $('#m-rows'); const row = el.closest('.m-row'); if (!box || !row) return; if (box.children.length > 1) row.remove(); else row.querySelector('input[name="m_name"]').value = ''; },
    'export-guests-csv': async () => { await shareOrDownload(`invitati-matrimonio-${todayISO()}.csv`, csvGuests(), 'text/csv'); },
    backup: async () => {
      const name = `spese-matrimonio-${todayISO()}.json`;
      const ok = await shareOrDownload(name, JSON.stringify(payload(), null, 1), 'application/json');
      if (ok) { state.meta.lastBackup = now(); save(); render(); toast('Backup salvato'); }
    },
    'export-csv': async () => { await shareOrDownload(`spese-matrimonio-${todayISO()}.csv`, csv(), 'text/csv'); },
    'import-file': () => { const f = $('#file-input'); f.value = ''; f.click(); },
    'sync-create': () => { if (!sync.conf.code) pairWith(newPairCode()); render(); openPairCode(); },
    'sync-join': () => openPairJoin(),
    'sync-show': () => openPairCode(),
    'sync-unpair': () => {
      if (!confirm('Scollegare questo telefono? Le spese restano qui, ma non riceverà più gli aggiornamenti dell\'altro.')) return;
      unpair(); render(); toast('Telefono scollegato');
    },
    'copy-pair': async () => {
      const code = fmtCode(sync.conf.code);
      try { await navigator.clipboard.writeText(code); toast('Codice copiato'); }
      catch (e) {
        const r = document.createRange(); const el = $('#pair-code');
        if (el) { r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
        toast('Tenete premuto sul codice per copiarlo');
      }
    },
    'share-pair': async () => {
      const link = $('#pair-link') ? $('#pair-link').value : '';
      try { await navigator.share({ text: `Codice per collegare l'app delle spese del matrimonio: ${fmtCode(sync.conf.code)}\n${link}` }); } catch (e) { /* annullato */ }
    },
    'merge-confirm': () => {
      if (!pendingIncoming) return;
      const snap = snapshot();
      const r = mergeIncoming(pendingIncoming);
      pendingIncoming = null;
      state.meta.onboarded = true;
      closeSheet();
      const parts = [];
      if (r.added) parts.push(`${r.added} ${r.added === 1 ? 'nuova' : 'nuove'}`);
      if (r.updated) parts.push(`${r.updated} ${r.updated === 1 ? 'aggiornata' : 'aggiornate'}`);
      if (r.removed) parts.push(`${r.removed} ${r.removed === 1 ? 'eliminata' : 'eliminate'}`);
      commit(parts.length ? `Dati uniti: ${parts.join(', ')}` : 'Dati già allineati, nessuna modifica', snap);
    },
    'replace-confirm': () => {
      if (!pendingIncoming) return;
      const snap = snapshot();
      replaceWith(pendingIncoming);
      pendingIncoming = null;
      closeSheet();
      commit('Dati sostituiti', snap);
    },
    reset: () => {
      const paired = !!sync.conf.code;
      if (!confirm(paired ? 'Scollegare questo telefono e cancellarne tutte le spese? Sull\'altro telefono restano.' : 'Cancellare tutte le spese e le impostazioni da questo telefono?')) return;
      if (paired) unpair();
      const snap = paired ? null : snapshot();
      state = blank(); state.meta.onboarded = true;
      ui.cat = ''; ui.filter = 'all'; ui.q = '';
      commit('Dati cancellati', snap);
    },
    'cat-up': (el) => { const i = Number(el.dataset.i); if (i > 0) { const c = state.categories; [c[i - 1], c[i]] = [c[i], c[i - 1]]; touchCategories(); commit(); } },
    'cat-rename': (el) => {
      const i = Number(el.dataset.i); const old = state.categories[i];
      const name = (prompt('Nuovo nome della categoria', old) || '').trim();
      if (!name || name === old) return;
      if (state.categories.includes(name)) { toast('Esiste già una categoria con questo nome'); return; }
      state.categories[i] = name;
      touchCategories();
      for (const it of live()) if (it.category === old) { it.category = name; touch(it); }
      commit('Categoria rinominata');
    },
    'cat-del': (el) => { const i = Number(el.dataset.i); state.categories.splice(i, 1); touchCategories(); commit('Categoria eliminata'); },
    'share-app': async () => {
      const url = `${location.origin}/scopri/`;
      const data = { title: 'Spese del matrimonio', text: "Un'app gratuita per tenere in ordine le spese del matrimonio, in due e in tempo reale.", url };
      if (navigator.share) { try { await navigator.share(data); } catch (e) { /* annullato */ } return; }
      try { await navigator.clipboard.writeText(url); toast('Link copiato'); } catch (e) { toast(url); }
    },
    'skip-onboarding': () => { state.meta.onboarded = true; save(); closeSheet(); }
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    // un pulsante dentro una riga cliccabile ha la precedenza
    const fn = actions[el.dataset.action];
    if (fn) { e.preventDefault(); fn(el, e); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"][data-action]')) {
      e.preventDefault(); actions[e.target.dataset.action]?.(e.target, e);
    }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'q') { ui.q = e.target.value; const l = $('#items-list'); if (l) l.innerHTML = itemsList(); }
    if (e.target.id === 'gq') { ui.gq = e.target.value; const l = $('#guests-list'); if (l) l.innerHTML = guestsList(); }
    if (e.target.getAttribute('aria-invalid') === 'true') {
      e.target.removeAttribute('aria-invalid');
      const er = e.target.closest('.field')?.querySelector('.err'); if (er) er.remove();
    }
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'category' && t.value === '__new') {
      const name = (prompt('Nome della nuova categoria') || '').trim();
      if (name) {
        if (!state.categories.includes(name)) { state.categories.push(name); touchCategories(); save(); }
        t.innerHTML = catOptions(name);
      } else {
        t.selectedIndex = 0;
      }
    }
    if (t.name === 'status' && t.form && t.form.dataset.form === 'pay') {
      const paid = t.value === 'paid';
      t.form.querySelector('[data-date-label]').textContent = paid ? 'Pagato il' : 'Scadenza';
      t.form.querySelector('[data-paid-only]').hidden = !paid;
      const d = t.form.elements.date;
      if (paid && !d.value) d.value = todayISO();
      const btn = t.form.querySelector('button[type="submit"]');
      if (!t.form.dataset.pay) btn.textContent = paid ? 'Registra pagamento' : 'Aggiungi scadenza';
    }
  });
  $('#file-input').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try { openIncoming(parseIncoming(await f.text()), f.name); }
    catch (err) { toast(err.message || 'File non leggibile'); }
  });

  /* ---------------- invio moduli ---------------- */
  const forms = {
    item(f) {
      const el = f.elements;
      const name = el.name.value.trim();
      if (!name) return fieldError(el.name, 'Scrivete il nome del fornitore o della voce.');
      const total = parseAmount(el.total.value);
      if (Number.isNaN(total)) return fieldError(el.total, 'Importo non valido. Esempio: 12.500 oppure 12500,50');
      let category = el.category.value;
      if (category === '__new') category = 'Altro';
      const id = f.dataset.id;
      if (id) {
        const it = findItem(id); if (!it) return;
        Object.assign(it, { name, category, total: total || 0, estimate: el.estimate.checked, contact: el.contact.value.trim(), notes: el.notes.value.trim() });
        touch(it);
        save(); render(); openItem(it.id);
        toast('Modifiche salvate');
        return;
      }
      const dep = parseAmount(el.dep.value);
      if (Number.isNaN(dep)) return fieldError(el.dep, 'Importo non valido. Esempio: 1.500');
      const it = normItem({ name, category, total: total || 0, estimate: el.estimate.checked, contact: el.contact.value.trim(), notes: el.notes.value.trim(), payments: [] });
      if (dep) it.payments.push(normPay({ amount: dep, status: 'paid', date: el.depDate.value || todayISO(), type: 'Acconto', payer: el.depPayer.value }));
      touch(it);
      state.items.push(it);
      state.meta.onboarded = true;
      save(); render(); openItem(it.id);
      toast('Spesa aggiunta');
    },
    pay(f) {
      const el = f.elements;
      const it = findItem(f.dataset.item); if (!it) return;
      const amount = parseAmount(el.amount.value);
      if (amount == null || amount === 0) return fieldError(el.amount, "Inserite l'importo.");
      if (Number.isNaN(amount)) return fieldError(el.amount, 'Importo non valido. Esempio: 1.500 oppure 1500,50');
      const status = el.status.value;
      const data = {
        amount, status, type: el.type.value, date: el.date.value || (status === 'paid' ? todayISO() : ''),
        payer: status === 'paid' ? el.payer.value : '', method: status === 'paid' ? el.method.value : '', note: el.note.value.trim()
      };
      const pid = f.dataset.pay;
      if (pid) { const p = it.payments.find((x) => x.id === pid); if (p) Object.assign(p, normPay({ ...p, ...data, id: p.id })); }
      else it.payments.push(normPay(data));
      touch(it);
      save(); render(); openItem(it.id);
      toast(pid ? 'Pagamento aggiornato' : (status === 'paid' ? 'Pagamento registrato' : 'Scadenza aggiunta'));
    },
    settings(f) {
      const el = f.elements;
      const budget = parseAmount(el.budget.value);
      if (Number.isNaN(budget)) return fieldError(el.budget, 'Importo non valido. Esempio: 35.000');
      Object.assign(state.settings, {
        name1: el.name1.value.trim(), name2: el.name2.value.trim(), date: el.date.value,
        budget: budget || 0, extraPayers: el.extraPayers.value.split(',').map((x) => x.trim()).filter(Boolean), updatedAt: now()
      });
      commit('Impostazioni salvate');
    },
    'add-cat'(f) {
      const name = f.elements.cat.value.trim();
      if (!name) return;
      if (state.categories.includes(name)) { toast('Questa categoria esiste già'); return; }
      state.categories.push(name);
      touchCategories();
      commit('Categoria aggiunta');
    },
    pair(f) {
      const inp = f.elements.code;
      const code = normCode(inp.value);
      if (!CODE_RE.test(code)) return fieldError(inp, 'Il codice ha 25 caratteri tra lettere e numeri. Controllate di averlo copiato tutto.');
      if (code === sync.conf.code) { closeSheet(); toast('Questo telefono usa già questo codice'); return; }
      pairWith(code);
      state.meta.onboarded = true;
      save();
      closeSheet();
      render();
      toast('Telefono collegato');
    },
    guest(f) {
      const el = f.elements;
      const names = [...f.querySelectorAll('input[name="m_name"]')];
      const members = names.map((inp) => {
        const row = inp.closest('.m-row');
        return normMember({ id: row.querySelector('input[name="m_id"]').value || uid(), name: inp.value, kind: row.querySelector('select[name="m_kind"]').value, rsvp: row.querySelector('input[name="m_rsvp"]').value });
      }).filter((m) => m.name);
      let name = el.name.value.trim();
      if (!members.length && name) members.push(normMember({ name, kind: 'adulto' }));
      if (!members.length) return fieldError(names[0] || el.name, 'Scrivete almeno un nome.');
      if (!name) name = members.map((m) => m.name).join(' e ');
      const favors = el.favors.value.trim() === '' ? 1 : Number(el.favors.value.replace(/\D/g, ''));
      const side = el.side.value;
      ui.gside = side;
      const id = f.dataset.id;
      let g = id ? findGuest(id) : null;
      if (g) Object.assign(g, { name, side, members, favors: Math.min(99, favors || 0), notes: el.notes.value.trim() });
      else { g = normGuest({ name, side, members, favors, notes: el.notes.value.trim() }); state.guests.push(g); }
      touch(g);
      state.meta.onboarded = true;
      save(); render(); openGuest(g.id);
      toast(id ? 'Modifiche salvate' : 'Nucleo aggiunto');
    },
    guestBulk(f) {
      const ta = f.elements.list;
      const rows = parseGuestLines(ta.value);
      if (!rows.length) return fieldError(ta, 'Scrivete almeno un nome.');
      const side = f.elements.side.value;
      ui.gside = side;
      const snap = snapshot();
      for (const r of rows) { const g = normGuest({ name: r.name, side, members: r.members, favors: 1 }); touch(g); state.guests.push(g); }
      state.meta.onboarded = true;
      closeSheet();
      if (ui.tab !== 'guests') go('guests');
      const people = rows.reduce((a, r) => a + r.members.length, 0);
      commit(`Aggiunti ${plural(rows.length, 'nucleo', 'nuclei')} (${plural(people, 'persona', 'persone')})`, snap);
    },
    gcfg(f) {
      const v = f.elements.ordered.value.replace(/\D/g, '');
      state.gcfg.ordered = Math.min(9999, Number(v || 0)); touchGcfg();
      commit('Salvato');
    },
    onboarding(f) {
      const el = f.elements;
      const budget = parseAmount(el.budget.value);
      if (Number.isNaN(budget)) return fieldError(el.budget, 'Importo non valido. Esempio: 35.000');
      Object.assign(state.settings, { name1: el.name1.value.trim(), name2: el.name2.value.trim(), date: el.date.value, budget: budget || 0, updatedAt: now() });
      state.meta.onboarded = true;
      closeSheet();
      commit();
    }
  };
  document.addEventListener('submit', (e) => {
    const f = e.target;
    const fn = forms[f.dataset.form];
    if (fn) { e.preventDefault(); fn(f); }
  });

  /* ---------------- primo avvio ---------------- */
  function onboarding() {
    openSheet(`${head('Benvenuti')}
      <p class="muted">Tre informazioni per cominciare. Potete cambiarle quando volete dalle impostazioni.</p>
      <form data-form="onboarding" novalidate autocomplete="off">
        <div class="grid2">
          <label class="field"><span>Primo nome</span><input type="text" name="name1" placeholder="Es. Giulia" autocapitalize="words"></label>
          <label class="field"><span>Secondo nome</span><input type="text" name="name2" placeholder="Es. Marco" autocapitalize="words"></label>
        </div>
        <label class="field"><span>Data del matrimonio</span><input type="date" name="date"></label>
        <label class="field"><span>Budget complessivo</span><input type="text" name="budget" inputmode="decimal" placeholder="Facoltativo, es. 35.000"></label>
        <div class="form-actions"><button class="btn primary" type="submit">Inizia</button><button class="btn" type="button" data-action="skip-onboarding">Più tardi</button></div>
        <p class="small muted" style="margin-top:1.25rem">L'altro telefono usa già l'app? <button type="button" class="link" data-action="sync-join">Inserite il codice di coppia</button> e le spese arrivano da sole.</p>
      </form>`, { focus: false });
  }

  /* ---------------- avvio ---------------- */
  render({ keepScroll: false });
  if (!state.meta.onboarded && !live().length) onboarding();

  // aggiorna i conti allo scoccare della mezzanotte o al ritorno nell'app
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') { sync.hiddenAt = Date.now(); return; }
    // un'altra scheda può aver modificato i dati
    const fresh = load();
    if (JSON.stringify(fresh) !== JSON.stringify(state)) { state = fresh; }
    if (!sheet.open) render();
    // al ritorno nell'app (soprattutto su iPhone) la connessione può essere morta: si riapre
    if (sync.conf.code) {
      if (!sync.ws || sync.ws.readyState > 1 || Date.now() - sync.hiddenAt > 15000) reconnectNow();
      else scheduleFlush();
    }
  });
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) { state = load(); if (!sheet.open) render(); }
    if (e.key === SYNC_KEY) { const c = loadSync(); if (c.code !== sync.conf.code) { sync.conf = c; sync.key = null; reconnectNow(); render(); } }
  });
  window.addEventListener('online', () => { if (sync.conf.code) reconnectNow(); });
  window.addEventListener('offline', () => { if (sync.conf.code) setSyncStatus('offline'); });

  // link di abbinamento: .../#coppia=CODICE
  function checkPairLink() {
    const m = location.hash.match(/coppia=([0-9A-Za-z-]+)/);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    if (normCode(m[1]) !== sync.conf.code) openPairJoin(m[1]);
  }
  checkPairLink();
  window.addEventListener('hashchange', checkPairLink);
  connect();

  // Safari su iPhone ignora user-scalable=no: si bloccano i suoi gesti di zoom
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
  // e il pizzico a due dita, dove il browser lo consente
  document.addEventListener('touchmove', (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }

  // per i test
  window.__speseNozze = { parseAmount, itemStats, totals: () => { const t = totals(); return { ...t, byCat: Object.fromEntries(t.byCat), byPayer: Object.fromEntries(t.byPayer) }; }, mergeIncoming, guestStats, parseGuestLines, getState: () => state, sync: () => ({ status: sync.status, conf: sync.conf, pending: pending().length }) };
})();
