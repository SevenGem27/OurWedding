# Spese del matrimonio

App installabile sul telefono (PWA) per tenere sotto controllo le spese del matrimonio:
acconti già versati, importi ancora da pagare per ogni tipo di spesa, scadenze, totale speso
e totale da spendere. Funziona anche senza connessione.

**Apri l'app:** https://sevengem27.github.io/OurWedding/

## Installarla sul telefono

**iPhone (Safari):** aprite l'indirizzo, toccate *Condividi* e poi *Aggiungi alla schermata Home*.

**Android (Chrome):** aprite l'indirizzo, menu ⋮ e poi *Installa app* (o *Aggiungi a schermata Home*).

Importante su iPhone: l'app installata e la scheda di Safari hanno **memorie separate**.
Inserite i dati sempre dall'icona sulla schermata Home.

## Come si usa

- **Aggiungi spesa**: fornitore, tipo di spesa, importo concordato e, se c'è, l'acconto già versato.
- Dentro ogni spesa: **Registra pagamento** per quello che avete già pagato,
  **Aggiungi scadenza** per rate e saldi futuri. *Segna pagato* sposta una scadenza tra i pagamenti fatti.
- Se l'importo non è definitivo, spuntate *È un preventivo*: il riepilogo vi dice quanta parte del totale è ancora stimata.
- **Riepilogo**: costo totale, già pagato, da pagare, margine sul budget, prossime scadenze,
  totali per tipo di spesa e chi ha pagato cosa.
- **Scadenze**: rate scadute, prossimi 30 giorni, più avanti, importi senza data e storico pagamenti.

## Tenere allineati i due telefoni

I dati restano sul telefono di chi li inserisce: nessun server, nessun account.
Il repository contiene solo il codice dell'app, mai le vostre spese.

1. Su un telefono: *Impostazioni*, poi **Invia i miei dati** e copiate il codice (o *Condividi* su WhatsApp).
2. Sull'altro: *Impostazioni*, poi **Incolla dati ricevuti**, poi **Unisci ai miei dati**.
3. Ripetete al contrario se anche l'altro ha fatto modifiche.

L'unione avviene spesa per spesa: per ciascuna vince la versione modificata più di recente.
Le spese eliminate vengono eliminate anche sull'altro telefono.

## Backup

*Impostazioni*, poi **Salva backup**: un file `.json` da tenere su iCloud, Google Drive o in una mail.
Con **Importa da file** lo ripristinate. **Esporta CSV** crea un foglio apribile con Excel o Numbers.

## Aggiornare l'app

Se modificate i file, cambiate `VERSION` in `sw.js` e fate push su `main`:
GitHub Pages ripubblica in un paio di minuti e i telefoni scaricano la nuova versione
alla successiva apertura (a volte serve chiudere e riaprire l'app due volte). I dati non vengono toccati.

## File

- `index.html`, `styles.css`, `app.js`: l'app
- `manifest.webmanifest`, `sw.js`: installazione e funzionamento offline
- `icons/`, `fonts/`: icone e caratteri (Bodoni Moda e Hanken Grotesk, licenza SIL Open Font License, vedi `fonts/`)
