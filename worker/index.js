/**
 * Server di sincronizzazione per "Spese del matrimonio".
 *
 * - Serve i file dell'app (cartella public/) e l'API sotto /api/.
 * - Ogni coppia ha una "stanza" (Durable Object) identificata da un hash
 *   del codice di coppia. Il server non conosce il codice e riceve solo
 *   dati cifrati: vede id, data di modifica e un blob illeggibile.
 * - Regola di unione: per ogni record vince la modifica più recente (u).
 * - WebSocket con Hibernation API: a riposo non consuma tempo di calcolo.
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

  since(seq) {
    return this.sql.exec('SELECT id, u, d, c, seq FROM records WHERE seq > ? ORDER BY seq LIMIT 5000', seq).toArray();
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
        this.sql.exec(
          `INSERT INTO records (id, u, seq, d, c) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET u = excluded.u, seq = excluded.seq, d = excluded.d, c = excluded.c`,
          r.id, r.u, seq, d, r.c
        );
        accepted.push({ id: r.id, u: r.u, d, c: r.c, seq });
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
      const since = Number.isSafeInteger(m.since) && m.since >= 0 ? m.since : 0;
      // se il client è "avanti" (stanza ricreata), riparte da zero
      const seq = this.currentSeq();
      const from = since > seq ? 0 : since;
      this.send(ws, { t: 'sync', records: this.since(from), seq, reset: from !== since });
      return;
    }

    if (m.t === 'put' && Array.isArray(m.records)) {
      const { accepted, ack, seq } = this.apply(m.records);
      this.send(ws, { t: 'ack', ack, seq });
      if (accepted.length) {
        const out = JSON.stringify({ t: 'changes', records: accepted, seq });
        for (const other of this.ctx.getWebSockets()) {
          if (other !== ws) { try { other.send(out); } catch (e) { /* ignora */ } }
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
