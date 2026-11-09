/* Spese del matrimonio — PWA
   Tutti i dati restano sul dispositivo (localStorage).
   La sincronizzazione tra i due telefoni avviene con un codice o un file
   che si unisce voce per voce: vince la modifica più recente. */
'use strict';

(() => {
  const KEY = 'spese-nozze:v1';
  const APP_ID = 'spese-nozze';
  const VERSION = '1.0.0';
  const CODE_PREFIX = 'NOZZE1';

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
      items: [],
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
      items: Array.isArray(s.items) ? s.items.map(normItem) : [],
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
  }

  let state = load();
  const ui = { tab: 'home', filter: 'all', q: '', cat: '' };
  try { const t = sessionStorage.getItem('spese-nozze:tab'); if (t) ui.tab = t; } catch (e) { /* niente */ }
  { const t = new URLSearchParams(location.search).get('tab'); if (['home', 'items', 'due', 'settings'].includes(t)) ui.tab = t; }

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
  function bar({ paid, toPay, free = 0, budgetMark = null, thin = false, label = '' }) {
    const whole = paid + toPay + free;
    if (whole <= 0) return `<div class="bar${thin ? ' thin' : ''}" role="img" aria-label="Nessun importo"><span class="seg free" style="flex:1"></span></div>`;
    const seg = (cls, v, inner = '') => (v > 0 ? `<span class="seg ${cls}" style="flex:${v} 1 0">${inner}</span>` : '');
    const showPct = !thin && paid / whole > 0.14;
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
  function viewHome() {
    const s = state.settings;
    const names = [s.name1, s.name2].map((x) => x.trim()).filter(Boolean);
    const t = totals();
    const cd = countdown();
    let h = `<header><h1 class="couple">${names.length ? esc(names.join(' e ')) : 'Il nostro matrimonio'}</h1>${cd ? `<p class="countdown">${esc(cd)}</p>` : ''}</header>`;

    if (live().some((i) => i.sample)) {
      h += `<div class="sample-banner"><span>Stai guardando dati di esempio.</span><button type="button" class="link" data-action="clear-sample">Elimina l'esempio</button></div>`;
    }

    if (!t.count) {
      h += `<section class="empty">
        <h2>Iniziate dalla prima spesa</h2>
        <p>Inserite un fornitore con l'importo concordato e l'acconto già versato. L'app calcola quanto avete pagato, quanto resta e quando scade ogni rata.</p>
        <div class="btns"><button type="button" class="btn primary" data-action="new-item">Aggiungi spesa</button><button type="button" class="btn" data-action="load-sample">Vedi un esempio</button></div>
      </section>`;
      return h;
    }

    const budget = s.budget || 0;
    const free = budget > t.total ? budget - t.total : 0;
    const mark = budget > 0 && budget < t.total ? budget / t.total : null;
    h += `<section class="hero" aria-labelledby="h-total">
      <h2 class="hero-label" id="h-total">Costo totale</h2>
      <p class="big">${moneyBig(t.total)}</p>
      ${t.estimate ? `<p class="hero-note">Include ${money(t.estimate)} di preventivi non ancora confermati</p>` : ''}
      ${bar({ paid: t.paid, toPay: t.toPay, free, budgetMark: mark, label: `Pagato ${money(t.paid)} su ${money(t.total)}, da pagare ${money(t.toPay)}${budget ? `, budget ${money(budget)}` : ''}` })}
      <dl class="legend">
        <div><dt><i class="sw paid"></i>Già pagato</dt><dd>${money(t.paid)}</dd></div>
        <div><dt><i class="sw topay"></i>Da pagare</dt><dd>${money(t.toPay)}</dd></div>
        ${free ? `<div><dt><i class="sw free"></i>Budget libero</dt><dd>${money(free)}</dd></div>` : ''}
      </dl>
      ${budget ? (t.total > budget
        ? `<p class="budget-line over">Budget ${money(budget)}: <strong>siete sopra di ${money(t.total - budget)}</strong></p>`
        : `<p class="budget-line">Budget ${money(budget)}: restano <strong>${money(budget - t.total)}</strong> non ancora impegnati</p>`)
        : `<p class="budget-line"><button type="button" class="link" data-action="tab" data-tab="settings">Imposta un budget</button> per vedere quanto margine vi resta.</p>`}
    </section>`;

    // prossime scadenze
    const due = allPayments('due').sort((a, b) => (a.p.date || '9999').localeCompare(b.p.date || '9999'));
    const lateN = due.filter((x) => x.p.date && x.p.date < todayISO()).length;
    h += `<section class="section" aria-labelledby="h-due"><div class="section-head"><h2 id="h-due">Prossime scadenze</h2>${due.length > 4 ? '<button type="button" class="link" data-action="tab" data-tab="due">Tutte</button>' : ''}</div>`;
    if (lateN) h += `<div class="callout warn"><p><strong>${lateN === 1 ? 'Un pagamento è scaduto' : `${lateN} pagamenti sono scaduti`}.</strong> Segnateli come pagati o spostate la data.</p></div>`;
    h += due.length
      ? `<ul class="list">${due.slice(0, 4).map((x) => payRow(x)).join('')}</ul>`
      : '<p class="muted">Nessuna scadenza in programma.</p>';
    if (t.unscheduled > 0) {
      const n = live().filter((i) => itemStats(i).unscheduled > 0).length;
      h += `<div class="callout"><p><strong>${money(t.unscheduled)}</strong> da pagare non ${t.unscheduled === t.toPay && n === 1 ? 'ha' : 'hanno'} ancora una data (${n} ${n === 1 ? 'spesa' : 'spese'}).</p><button type="button" class="link" data-action="tab" data-tab="due">Programma i saldi</button></div>`;
    }
    h += '</section>';

    // per categoria
    const cats = [...t.byCat.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    h += `<section class="section" aria-labelledby="h-cat"><div class="section-head"><h2 id="h-cat">Per tipo di spesa</h2></div><ul class="list">${cats.map((c) => `
      <li><button type="button" class="row" data-action="open-cat" data-cat="${esc(c.name)}">
        <span class="row-top"><span class="row-name">${esc(c.name)}${c.n > 1 ? ` <span class="muted small">(${c.n})</span>` : ''}</span><span class="row-amt">${c.total ? money(c.total) : '–'}</span></span>
        ${c.total ? bar({ paid: c.paid, toPay: c.toPay, thin: true }) : ''}
        <span class="row-meta"><span>${money(c.paid)} pagati</span><span class="${c.toPay ? 'topay-txt' : ''}">${c.toPay ? money(c.toPay) + ' da pagare' : (c.total ? 'Saldato' : 'Importo da definire')}</span></span>
      </button></li>`).join('')}</ul></section>`;

    // chi ha pagato
    if (t.paid > 0) {
      const ps = [...t.byPayer.entries()].sort((a, b) => b[1] - a[1]);
      h += `<section class="section" aria-labelledby="h-who"><div class="section-head"><h2 id="h-who">Chi ha pagato</h2></div><ul class="list">${ps.map(([k, v]) => `<li class="payer"><span>${esc(k)}</span><span>${money(v)}<small>${pct(v, t.paid)}%</small></span></li>`).join('')}</ul></section>`;
    }

    // promemoria backup
    const lb = state.meta.lastBackup || 0;
    if (t.count >= 3 && now() - lb > 14 * 86400000) {
      h += `<p class="foot">${lb ? `Ultimo backup ${new Date(lb).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' })}.` : 'Non avete ancora salvato un backup.'} <button type="button" class="link" data-action="backup">Salva backup ora</button></p>`;
    }
    return h;
  }

  function viewItems() {
    const t = totals();
    let h = `<header><h1 class="page-title">Spese</h1><p class="page-sub">${t.count} ${t.count === 1 ? 'voce' : 'voci'}, ${money(t.toPay)} ancora da pagare</p></header>`;
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
    const t = { count: live().length };
    let h = '';
    if (ui.cat) h += `<p class="small" style="margin-top:.75rem">Categoria: <strong>${esc(ui.cat)}</strong> <button type="button" class="link" data-action="clear-cat">Mostra tutte</button></p>`;

    if (!items.length) {
      h += t.count
        ? '<p class="muted" style="margin-top:2rem">Nessuna spesa corrisponde a questi filtri.</p>'
        : '<section class="empty"><h2>Ancora nessuna spesa</h2><p>Aggiungete il primo fornitore: bastano nome, categoria e importo concordato.</p><div class="btns"><button type="button" class="btn primary" data-action="new-item">Aggiungi spesa</button></div></section>';
      return h;
    }
    const order = [...state.categories];
    for (const it of items) if (!order.includes(it.category)) order.push(it.category);
    for (const cat of order) {
      const group = items.filter((i) => i.category === cat).sort((a, b) => itemStats(b).total - itemStats(a).total);
      if (!group.length) continue;
      const sum = group.reduce((a, i) => a + itemStats(i).total, 0);
      h += `<div class="group-head"><h2>${esc(cat)}</h2><span>${money(sum)}</span></div><ul class="list">${group.map(itemRow).join('')}</ul>`;
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

    let h = `<header><h1 class="page-title">Scadenze</h1><p class="page-sub">${money(t.sched)} programmati, ${money(t.unscheduled)} ancora senza data</p></header>`;
    const block = (title, arr, extra = '') => arr.length
      ? `<section class="section"><div class="section-head"><h2>${title}</h2><span class="muted small">${money(sum(arr))}</span></div>${extra}<ul class="list">${arr.map((x) => payRow(x)).join('')}</ul></section>`
      : '';
    if (!due.length && !unsched.length && !paid.length) {
      return h + '<section class="empty"><h2>Niente in calendario</h2><p>Quando aggiungete una rata o un saldo con una data, compare qui in ordine di scadenza.</p></section>';
    }
    h += block('Scadute', late);
    h += block('Nei prossimi 30 giorni', soon);
    h += block('Più avanti', later);
    if (!due.length) h += '<p class="muted" style="margin-top:2rem">Nessuna rata in programma.</p>';
    if (unsched.length) {
      h += `<section class="section"><div class="section-head"><h2>Da programmare</h2><span class="muted small">${money(t.unscheduled)}</span></div>
        <p class="muted small" style="margin-bottom:.5rem">Importi ancora da pagare per cui non avete fissato una data.</p>
        <ul class="list">${unsched.map(({ it, s }) => `<li><div class="pay" style="grid-template-columns:1fr auto">
          <div class="what"><strong>${esc(it.name)}</strong><span>${esc(it.category)}</span></div>
          <span class="amt">${money(s.unscheduled)}</span>
          <div class="actions" style="grid-column:1/-1"><button type="button" class="btn small" data-action="schedule" data-item="${it.id}">Fissa una scadenza</button><button type="button" class="btn small primary" data-action="pay-rest" data-item="${it.id}">Registra pagamento</button></div>
        </div></li>`).join('')}</ul></section>`;
    }
    if (paid.length) {
      h += `<section class="section"><div class="section-head"><h2>Pagamenti fatti</h2><span class="muted small">${money(sum(paid))}</span></div><ul class="list">${paid.map((x) => payRow(x, { actions: false })).join('')}</ul></section>`;
    }
    return h;
  }

  function viewSettings() {
    const s = state.settings;
    const counts = new Map();
    for (const it of live()) counts.set(it.category, (counts.get(it.category) || 0) + 1);
    const lastSync = state.meta.lastSync ? new Date(state.meta.lastSync).toLocaleString('it-IT', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '';
    return `<header><h1 class="page-title">Impostazioni</h1></header>
    <form data-form="settings" class="set-section" autocomplete="off" novalidate>
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

    <section class="set-section" aria-labelledby="h-sync">
      <h2 id="h-sync">Sincronizza con il partner</h2>
      <p>I dati stanno su questo telefono. Per allinearli con l'altro, uno dei due invia un codice e l'altro lo incolla: le spese vengono unite e per ciascuna vince la modifica più recente. Poi fate lo stesso al contrario.</p>
      ${lastSync ? `<p class="small muted" style="margin-top:.5rem">Ultima unione di dati: ${esc(lastSync)}</p>` : ''}
      <div class="btns"><button type="button" class="btn primary" data-action="sync-send">Invia i miei dati</button><button type="button" class="btn" data-action="sync-receive">Incolla dati ricevuti</button></div>
    </section>

    <section class="set-section" aria-labelledby="h-bk">
      <h2 id="h-bk">Backup ed esportazione</h2>
      <p>Il backup è un file con tutte le spese: tenetelo nel cloud o mandatelo via mail. Il CSV si apre con Excel o Numbers.</p>
      <div class="btns"><button type="button" class="btn" data-action="backup">Salva backup</button><button type="button" class="btn" data-action="import-file">Importa da file</button><button type="button" class="btn" data-action="export-csv">Esporta CSV</button></div>
    </section>

    <section class="set-section" aria-labelledby="h-cats">
      <h2 id="h-cats">Categorie</h2>
      <ul class="list" style="margin-top:.75rem">${state.categories.map((c, i) => `<li class="cat-item"><span>${esc(c)}${counts.get(c) ? `<small>${counts.get(c)}</small>` : ''}</span><span class="btns">
        <button type="button" class="icon-btn" data-action="cat-up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Sposta su ${esc(c)}">Su</button>
        <button type="button" class="icon-btn" data-action="cat-rename" data-i="${i}" aria-label="Rinomina ${esc(c)}">Rinomina</button>
        <button type="button" class="icon-btn" data-action="cat-del" data-i="${i}" ${counts.get(c) ? 'disabled title="Contiene delle spese"' : ''} aria-label="Elimina ${esc(c)}">Elimina</button>
      </span></li>`).join('')}</ul>
      <form class="add-cat" data-form="add-cat"><label class="vh" for="newcat">Nuova categoria</label><input id="newcat" name="cat" type="text" placeholder="Nuova categoria" autocomplete="off"><button class="btn small" type="submit">Aggiungi</button></form>
    </section>

    <section class="set-section" aria-labelledby="h-reset">
      <h2 id="h-reset">Cancella tutto</h2>
      <p>Elimina tutte le spese e le impostazioni da questo telefono. Salvate prima un backup.</p>
      <div class="btns"><button type="button" class="btn danger" data-action="reset">Cancella tutti i dati</button></div>
    </section>
    <p class="foot">Spese del matrimonio, versione ${VERSION}. Funziona anche offline.</p>`;
  }

  /* ---------------- rendering ---------------- */
  const view = $('#view');
  function render({ keepScroll = true } = {}) {
    const y = window.scrollY;
    const html = ui.tab === 'items' ? viewItems() : ui.tab === 'due' ? viewDue() : ui.tab === 'settings' ? viewSettings() : viewHome();
    view.innerHTML = html;
    document.querySelectorAll('.tabs button').forEach((b) => {
      if (b.dataset.tab === ui.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    $('#fab').hidden = ui.tab === 'settings' || (ui.tab === 'home' && !live().length);
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

  /* ---------------- sincronizzazione ---------------- */
  function payload() {
    return { app: APP_ID, v: 1, exportedAt: now(), settings: state.settings, categories: state.categories, items: state.items.filter((i) => !i.sample) };
  }
  const b64u = {
    enc(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
    dec(str) { const s = str.replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(s + '==='.slice((s.length + 3) % 4)); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  };
  async function streamBytes(bytes, transform) {
    const stream = new Blob([bytes]).stream().pipeThrough(transform);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function encodeCode() {
    const json = new TextEncoder().encode(JSON.stringify(payload()));
    if ('CompressionStream' in window) {
      try { return `${CODE_PREFIX}.z.${b64u.enc(await streamBytes(json, new CompressionStream('gzip')))}`; } catch (e) { /* ripiego */ }
    }
    return `${CODE_PREFIX}.j.${b64u.enc(json)}`;
  }
  async function decodeCode(raw) {
    const str = String(raw || '').replace(/\s+/g, '');
    const m = str.match(new RegExp(`${CODE_PREFIX}\\.([zj])\\.([A-Za-z0-9_-]+)`));
    if (!m) throw new Error('Il testo incollato non sembra un codice di questa app.');
    let bytes = b64u.dec(m[2]);
    if (m[1] === 'z') {
      if (!('DecompressionStream' in window)) throw new Error('Questo browser non sa leggere il codice compresso. Aggiornate il sistema o usate il file di backup.');
      bytes = await streamBytes(bytes, new DecompressionStream('gzip'));
    }
    return parseIncoming(new TextDecoder().decode(bytes));
  }
  function parseIncoming(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('Il contenuto non è leggibile.'); }
    if (!data || data.app !== APP_ID || !Array.isArray(data.items)) throw new Error('Questi dati non provengono da questa app.');
    return normalize(data);
  }
  function describeIncoming(inc) {
    const n = inc.items.filter((i) => !i.deleted).length;
    const names = [inc.settings.name1, inc.settings.name2].filter(Boolean).join(' e ');
    return `${n} ${n === 1 ? 'spesa' : 'spese'}${names ? ` di ${names}` : ''}`;
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
    for (const c of inc.categories) if (!state.categories.includes(c)) state.categories.push(c);
    state.meta.lastSync = now();
    return { added, updated, removed };
  }
  function replaceWith(inc) {
    const meta = state.meta;
    state = { ...inc, meta: { ...meta, onboarded: true, lastSync: now() } };
  }
  function openIncoming(inc, source) {
    const html = `${head('Dati ricevuti', source)}
      <p>Contiene ${esc(describeIncoming(inc))}.</p>
      <p class="muted" style="margin-top:.6rem">Unendo, ogni spesa prende la versione modificata più di recente tra le due. Sostituendo, i dati di questo telefono vengono rimpiazzati.</p>
      <div class="form-actions"><button type="button" class="btn primary" data-action="merge-confirm">Unisci ai miei dati</button><button type="button" class="btn danger" data-action="replace-confirm">Sostituisci tutto</button></div>`;
    pendingIncoming = inc;
    openSheet(html);
  }
  let pendingIncoming = null;

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
      state = normalize(JSON.parse(snap));
      // le voci ripristinate devono vincere alla prossima sincronizzazione
      state.items.forEach((i) => { i.updatedAt = Math.max(i.updatedAt || 0, now()); });
      toastEl.hidden = true; toastEl._undo = null;
      save(); render();
      if (sheet.open && sheetRefresh) sheetRefresh();
    },
    'load-sample': () => { state.items.push(...sampleItems()); state.meta.onboarded = true; commit('Esempio caricato'); },
    'clear-sample': () => { state.items = state.items.filter((i) => !i.sample); commit('Esempio eliminato'); },
    backup: async () => {
      const name = `spese-matrimonio-${todayISO()}.json`;
      const ok = await shareOrDownload(name, JSON.stringify(payload(), null, 1), 'application/json');
      if (ok) { state.meta.lastBackup = now(); save(); render(); toast('Backup salvato'); }
    },
    'export-csv': async () => { await shareOrDownload(`spese-matrimonio-${todayISO()}.csv`, csv(), 'text/csv'); },
    'import-file': () => { const f = $('#file-input'); f.value = ''; f.click(); },
    'sync-send': async () => {
      const code = await encodeCode();
      const canShare = !!navigator.share;
      openSheet(`${head('Invia i miei dati')}
        <p>Copiate il codice e mandatelo all'altro telefono, per esempio su WhatsApp. Lì, da Impostazioni, scegliete <strong>Incolla dati ricevuti</strong>.</p>
        <label class="field"><span>Codice (${Math.ceil(code.length / 1024)} kB)</span><textarea class="code-box" readonly rows="5" id="code-out">${esc(code)}</textarea></label>
        <div class="form-actions"><button type="button" class="btn primary" data-action="copy-code">Copia codice</button>${canShare ? '<button type="button" class="btn" data-action="share-code">Condividi</button>' : ''}</div>`);
    },
    'copy-code': async () => {
      const ta = $('#code-out'); if (!ta) return;
      try { await navigator.clipboard.writeText(ta.value); toast('Codice copiato'); }
      catch (e) { ta.focus(); ta.select(); try { document.execCommand('copy'); toast('Codice copiato'); } catch (e2) { toast('Selezionate il testo e copiatelo a mano'); } }
    },
    'share-code': async () => { const ta = $('#code-out'); if (!ta) return; try { await navigator.share({ text: ta.value }); } catch (e) { /* annullato */ } },
    'sync-receive': () => {
      openSheet(`${head('Incolla dati ricevuti')}
        <form data-form="paste" novalidate>
          <label class="field"><span>Codice ricevuto</span><textarea class="code-box" name="code" rows="6" placeholder="Inizia con ${CODE_PREFIX}." autofocus></textarea></label>
          <div class="form-actions"><button class="btn primary" type="submit">Continua</button>${navigator.clipboard && navigator.clipboard.readText ? '<button class="btn" type="button" data-action="paste-clip">Incolla dagli appunti</button>' : ''}</div>
        </form>`);
    },
    'paste-clip': async () => {
      try { const t = await navigator.clipboard.readText(); const ta = sheetBody.querySelector('textarea[name="code"]'); if (ta) ta.value = t; }
      catch (e) { toast('Tenete premuto nel riquadro e scegliete Incolla'); }
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
      if (!confirm('Cancellare tutte le spese e le impostazioni da questo telefono?')) return;
      const snap = snapshot();
      state = blank(); state.meta.onboarded = true;
      ui.cat = ''; ui.filter = 'all'; ui.q = '';
      commit('Dati cancellati', snap);
    },
    'cat-up': (el) => { const i = Number(el.dataset.i); if (i > 0) { const c = state.categories; [c[i - 1], c[i]] = [c[i], c[i - 1]]; commit(); } },
    'cat-rename': (el) => {
      const i = Number(el.dataset.i); const old = state.categories[i];
      const name = (prompt('Nuovo nome della categoria', old) || '').trim();
      if (!name || name === old) return;
      if (state.categories.includes(name)) { toast('Esiste già una categoria con questo nome'); return; }
      state.categories[i] = name;
      for (const it of live()) if (it.category === old) { it.category = name; touch(it); }
      commit('Categoria rinominata');
    },
    'cat-del': (el) => { const i = Number(el.dataset.i); state.categories.splice(i, 1); commit('Categoria eliminata'); },
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
        if (!state.categories.includes(name)) { state.categories.push(name); save(); }
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
      commit('Categoria aggiunta');
    },
    async paste(f) {
      const ta = f.elements.code;
      try { openIncoming(await decodeCode(ta.value), 'dal codice incollato'); }
      catch (err) { fieldError(ta, err.message || 'Codice non valido.'); }
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
        <p class="small muted" style="margin-top:1.25rem">Avete già i dati sull'altro telefono? Chiudete e andate in Impostazioni, poi Incolla dati ricevuti.</p>
      </form>`, { focus: false });
  }

  /* ---------------- avvio ---------------- */
  render({ keepScroll: false });
  if (!state.meta.onboarded && !live().length) onboarding();

  // aggiorna i conti allo scoccare della mezzanotte o al ritorno nell'app
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // un'altra scheda può aver modificato i dati
    const fresh = load();
    if (JSON.stringify(fresh) !== JSON.stringify(state)) { state = fresh; }
    if (!sheet.open) render();
  });
  window.addEventListener('storage', (e) => { if (e.key === KEY) { state = load(); if (!sheet.open) render(); } });

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }

  // per i test
  window.__speseNozze = { parseAmount, itemStats, totals: () => { const t = totals(); return { ...t, byCat: Object.fromEntries(t.byCat), byPayer: Object.fromEntries(t.byPayer) }; }, mergeIncoming, encodeCode, decodeCode, getState: () => state };
})();
