# Spese del matrimonio

App installabile sul telefono (PWA) per tenere sotto controllo le spese del matrimonio:
acconti già versati, importi ancora da pagare per ogni tipo di spesa, scadenze, totale speso
e totale da spendere. I due telefoni si aggiornano **in tempo reale** e l'app funziona anche
senza connessione: le modifiche fatte offline partono appena torna la rete.

Tutto gira su Cloudflare, piano gratuito: un solo Worker serve l'app e la sincronizzazione.

## Messa online (una volta sola, circa 5 minuti)

Ogni push su `main` pubblica l'app su Cloudflare tramite GitHub Actions. Servono due chiavi.

**1. Token API di Cloudflare**
1. Aprite <https://dash.cloudflare.com/profile/api-tokens> e scegliete **Create Token**.
2. Usate il modello **Edit Cloudflare Workers**.
3. In *Account Resources* scegliete il vostro account; in *Zone Resources* lasciate *All zones*.
4. **Continue to summary**, poi **Create Token**, e copiate il token (si vede una volta sola).

**2. Account ID**
Su <https://dash.cloudflare.com> aprite *Workers & Pages*: l'Account ID è nella colonna a destra
(oppure è il codice esadecimale nell'indirizzo della pagina).

**3. Segreti su GitHub**
In questo repository: *Settings*, poi *Secrets and variables*, poi *Actions*, poi **New repository secret**. Create:
- `CLOUDFLARE_API_TOKEN` con il token
- `CLOUDFLARE_ACCOUNT_ID` con l'Account ID

**4. Pubblicazione**
Scheda *Actions*, workflow **Pubblica su Cloudflare**, **Run workflow**.
Alla fine il riepilogo mostra l'indirizzo dell'app, del tipo `https://ourwedding.<vostro-nome>.workers.dev`.

Se è la prima volta che usate i Workers, Cloudflare può chiedervi di scegliere il sottodominio
`workers.dev`: lo trovate in *Workers & Pages*, poi rilanciate il workflow.

GitHub Pages non serve: se l'avevate attivato potete disattivarlo
(*Settings*, poi *Pages*, poi *Source: None*).

## Installarla sui telefoni

**iPhone (Safari):** aprite l'indirizzo, toccate *Condividi* e poi *Aggiungi alla schermata Home*.

**Android (Chrome):** aprite l'indirizzo, menu ⋮ e poi *Installa app*.

Su iPhone l'app installata e Safari hanno memorie separate: usate sempre l'icona sulla schermata Home.

## Collegare i due telefoni

1. Sul primo telefono: *Impostazioni*, poi **Crea un codice di coppia**, poi **Copia codice** o **Condividi**.
2. Sul secondo: *Impostazioni*, poi **Ho già un codice**, incollate il codice e toccate **Collega**.

Da quel momento ogni spesa, pagamento o modifica compare sull'altro telefono in meno di un secondo.
L'indicatore sotto i vostri nomi dice se siete sincronizzati o se ci sono modifiche in attesa di rete.
Se lo stesso elemento viene modificato su entrambi i telefoni, vince la modifica più recente.

**Privacy:** i dati sono cifrati sul telefono (AES-GCM) con una chiave ricavata dal codice di coppia.
Il server, e quindi Cloudflare, conserva e inoltra solo contenuti illeggibili; il codice non lascia mai i telefoni.
Chi ha il codice può leggere e modificare le spese: tenetelo tra voi due.

## Piano gratuito di Cloudflare

L'app usa un Worker e un Durable Object con archivio SQLite, entrambi inclusi nel piano gratuito
(100.000 richieste al giorno). Due persone che inseriscono spese ne usano una piccola frazione.
Sul piano gratuito non ci sono addebiti: se un limite venisse superato, la sincronizzazione si
fermerebbe fino alla mezzanotte UTC e l'app continuerebbe a funzionare in locale.

## Backup

*Impostazioni*, poi **Salva backup**: un file `.json` da tenere su iCloud, Google Drive o in una mail.
**Importa da file** lo ripristina (unendo o sostituendo). **Esporta CSV** crea un foglio per Excel o Numbers.

## Struttura

- `public/`: l'app (HTML, CSS, JavaScript, service worker, icone, caratteri)
- `worker/index.js`: server di sincronizzazione (Worker + Durable Object con WebSocket)
- `wrangler.jsonc`: configurazione Cloudflare
- `.github/workflows/deploy.yml`: pubblicazione automatica

Per provarla sul computer: `npm install` e poi `npm run dev`, che apre l'app su <http://localhost:8787>.

Dopo una modifica ai file in `public/`, aumentate `VERSION` in `public/sw.js`: così i telefoni
scaricano la nuova versione alla successiva apertura.

Caratteri: Bodoni Moda e Hanken Grotesk, licenza SIL Open Font License (vedi `public/fonts/`).
