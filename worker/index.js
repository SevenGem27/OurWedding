/**
 * Server di sincronizzazione per "Spese del matrimonio".
 *
 * - Serve i file dell'app (cartella public/) e l'API sotto /api/.
 * - Ogni coppia ha una "stanza" (Durable Object) identificata da un hash
 *   del codice di coppia. Il server non conosce il codice e riceve solo
 *   dati cifrati: vede id, data di modifica e un blob illeggibile.
 * - Regola di unione: per ogni record vince la modifica più recente (u).
 * - WebSocket con Hibernation API: a riposo non consuma tempo di calcolo.
 * - Ogni record ha un tipo k: 'i' (spese e impostazioni) o 'g' (invitati).
 *   I client della versione 1 non conoscono gli invitati: ricevono solo i record 'i'.
 */
import { DurableObject } from 'cloudflare:workers';

const MAX_RECORDS_PER_MSG = 200;
const MAX_CIPHERTEXT = 64 * 1024;
const MAX_RECORDS_PER_ROOM = 20000;
const ROOM_RE = /^\/api\/rooms\/([a-f0-9]{64})\/ws$/;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') return json({ ok: true });
    const m = url.pathname.match(ROOM_RE);
    if (m) {
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'websocket richiesto' }, 426);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
      return stub.fetch(request);
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'non trovato' }, 404);
    return env.ASSETS.fetch(request);
  }
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS records (
      id  TEXT PRIMARY KEY,
      u   INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      d   INTEGER NOT NULL DEFAULT 0,
      c   TEXT NOT NULL
    )`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS records_seq ON records(seq)');
    // migrazione: tipo del record (stanze create prima degli invitati)
    try { this.sql.exec("ALTER TABLE records ADD COLUMN k TEXT NOT NULL DEFAULT 'i'"); } catch (e) { /* colonna già presente */ }
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)');
    // il "ping" del client riceve "pong" senza svegliare l'oggetto
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  currentSeq() {
    const row = this.sql.exec("SELECT v FROM meta WHERE k = 'seq'").toArray()[0];
    return row ? row.v : 0;
  }

  async fetch() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  since(seq, v) {
    return v >= 2
      ? this.sql.exec('SELECT id, u, d, c, seq, k FROM records WHERE seq > ? ORDER BY seq LIMIT 5000', seq).toArray()
      : this.sql.exec("SELECT id, u, d, c, seq FROM records WHERE seq > ? AND k = 'i' ORDER BY seq LIMIT 5000", seq).toArray();
  }

  clientVersion(ws) {
    try { const a = ws.deserializeAttachment(); return a && a.v ? a.v : 1; } catch (e) { return 1; }
  }

  apply(records) {
    const accepted = [];
    const ack = [];
    let seq = this.currentSeq();
    let count = null;
    for (const r of records.slice(0, MAX_RECORDS_PER_MSG)) {
      if (!r || typeof r.id !== 'string' || r.id.length < 1 || r.id.length > 80) continue;
      if (!Number.isSafeInteger(r.u) || r.u < 0) continue;
      if (typeof r.c !== 'string' || r.c.length > MAX_CIPHERTEXT) continue;
      const cur = this.sql.exec('SELECT u FROM records WHERE id = ?', r.id).toArray()[0];
      if (!cur) {
        if (count === null) count = this.sql.exec('SELECT COUNT(*) AS n FROM records').toArray()[0].n;
        if (count >= MAX_RECORDS_PER_ROOM) continue;
        count++;
      }
      if (!cur || r.u > cur.u) {
        seq++;
        const d = r.d ? 1 : 0;
        const k = r.k === 'g' ? 'g' : 'i';
        this.sql.exec(
          `INSERT INTO records (id, u, seq, d, c, k) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET u = excluded.u, seq = excluded.seq, d = excluded.d, c = excluded.c, k = excluded.k`,
          r.id, r.u, seq, d, r.c, k
        );
        accepted.push({ id: r.id, u: r.u, d, c: r.c, seq, k });
      }
      // il server ha questa versione o una più recente: il client può considerarla inviata
      ack.push({ id: r.id, u: r.u });
    }
    if (accepted.length) {
      this.sql.exec("INSERT INTO meta (k, v) VALUES ('seq', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", seq);
    }
    return { accepted, ack, seq };
  }

  send(ws, data) {
    try { ws.send(JSON.stringify(data)); } catch (e) { /* connessione chiusa */ }
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string') return;
    let m;
    try { m = JSON.parse(message); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'hello') {
      const v = Number.isSafeInteger(m.v) && m.v > 0 ? m.v : 1;
      try { ws.serializeAttachment({ v }); } catch (e) { /* niente */ }
      const since = Number.isSafeInteger(m.since) && m.since >= 0 ? m.since : 0;
      // se il client è "avanti" (stanza ricreata), riparte da zero
      const seq = this.currentSeq();
      const from = since > seq ? 0 : since;
      this.send(ws, { t: 'sync', records: this.since(from, v), seq, reset: from !== since });
      return;
    }

    if (m.t === 'put' && Array.isArray(m.records)) {
      const { accepted, ack, seq } = this.apply(m.records);
      this.send(ws, { t: 'ack', ack, seq });
      if (accepted.length) {
        const all = JSON.stringify({ t: 'changes', records: accepted, seq });
        const onlyI = accepted.filter((r) => r.k === 'i');
        const old = onlyI.length ? JSON.stringify({ t: 'changes', records: onlyI, seq }) : null;
        for (const other of this.ctx.getWebSockets()) {
          if (other === ws) continue;
          const out = this.clientVersion(other) >= 2 ? all : old;
          if (out) { try { other.send(out); } catch (e) { /* ignora */ } }
        }
      }
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'chiuso'); } catch (e) { /* già chiuso */ }
  }

  async webSocketError(ws) {
    try { ws.close(1011, 'errore'); } catch (e) { /* già chiuso */ }
  }
}
