// Wächter für abiace.de: prüft Seite, Weiterleitungen, Zertifikat und DNS.
// Läuft auf GitHub alle 15 Minuten (siehe .github/workflows/waechter.yml),
// lokal mit: node waechter.mjs
// Schreibt das Ergebnis nach bericht.md und endet mit Code 1, wenn etwas nicht stimmt.
// Hier stehen nur öffentliche Adressen, NIE Schlüssel oder Passwörter eintragen.

import { writeFileSync } from 'node:fs';
import { Resolver } from 'node:dns/promises';
import tls from 'node:tls';

const DOMAIN = 'abiace.de';
const NETLIFY_IP = '75.2.60.5';
const ZERT_MIN_TAGE = 14;
const WARTEN_VOR_WIEDERHOLUNG_MS = 60_000;

// Jede Prüfung gibt bei Erfolg einen kurzen Text zurück und wirft bei einem Fehler.
// Adresse des Brevo-Formulars, gefunden auf der Startseite
let formularUrl;

const pruefungen = [
  ['Startseite erreichbar, Formular da', async () => {
    const res = await holen(`https://${DOMAIN}/`);
    if (res.status !== 200) throw new Error(`Status ${res.status} statt 200 (Netlify-Pause oder Ausfall?)`);
    const html = await res.text();
    if (!html.includes('AbiAce')) throw new Error('Seite enthält "AbiAce" nicht, falsche Seite ausgeliefert?');
    const formular = html.match(/action="(https:\/\/[^"]*sibforms\.com\/serve\/[^"]*)"/);
    if (!formular) throw new Error('Brevo-Formular fehlt auf der Seite');
    formularUrl = formular[1];
    return 'Status 200, Titel und Brevo-Formular gefunden';
  }],
  ['Brevo-Formular antwortet', async () => {
    if (!formularUrl) throw new Error('keine Formular-Adresse (Startseite fehlgeschlagen)');
    const res = await holen(formularUrl);
    if (res.status >= 400) throw new Error(`Brevo antwortet mit Status ${res.status}`);
    return `Status ${res.status}`;
  }],
  ...['bestaetigt.html', 'datenschutz.html', 'impressum.html'].map((seite) => [`Seite ${seite}`, async () => {
    const res = await holen(`https://${DOMAIN}/${seite}`);
    if (res.status !== 200) throw new Error(`Status ${res.status} statt 200`);
    return 'Status 200';
  }]),
  ['www leitet auf abiace.de', async () => weiterleitung(`https://www.${DOMAIN}/`, `https://${DOMAIN}/`)],
  ['http leitet auf https', async () => weiterleitung(`http://${DOMAIN}/`, `https://${DOMAIN}/`)],
  ['Zertifikat gültig', async () => {
    const bis = await zertifikatBis(DOMAIN);
    const tage = Math.floor((bis - Date.now()) / 86_400_000);
    if (tage < ZERT_MIN_TAGE) throw new Error(`läuft in ${tage} Tagen ab (${bis.toISOString().slice(0, 10)})`);
    return `noch ${tage} Tage gültig`;
  }],
  ['DNS: abiace.de zeigt auf Netlify', async () => {
    for (const [name, r] of resolver()) {
      const ips = await r.resolve4(DOMAIN);
      if (!ips.includes(NETLIFY_IP)) throw new Error(`${name} liefert ${ips.join(', ')} statt ${NETLIFY_IP}`);
    }
    return NETLIFY_IP;
  }],
  ['DNS: Mail-Einträge (MX, SPF, DMARC)', async () => {
    const [, r] = resolver()[0];
    const mx = await r.resolveMx(DOMAIN);
    if (!mx.some((m) => m.exchange.endsWith('rzone.de'))) throw new Error(`MX zeigt nicht mehr auf Strato: ${mx.map((m) => m.exchange).join(', ')}`);
    const txt = (await r.resolveTxt(DOMAIN)).map((t) => t.join(''));
    if (!txt.some((t) => t.startsWith('v=spf1'))) throw new Error('SPF-Eintrag fehlt');
    const dmarc = (await r.resolveTxt(`_dmarc.${DOMAIN}`)).map((t) => t.join(''));
    if (!dmarc.some((t) => t.startsWith('v=DMARC1'))) throw new Error('DMARC-Eintrag fehlt');
    return `MX ${mx.map((m) => m.exchange).join(', ')}, SPF und DMARC da`;
  }],
];

// Supabase (Konto und Sync der App). Adresse und öffentlicher Schlüssel kommen aus den
// Repo-Secrets SUPABASE_URL und SUPABASE_KEY, damit die Projekt-Adresse nicht im öffentlichen Code steht.
// Gratis-Projekte pausieren nach 7 Tagen ohne Nutzung; die Datenbank-Abfrage hier soll das möglichst verhindern.
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (SUPABASE_URL && SUPABASE_KEY) {
  pruefungen.push(
    ['Supabase: Anmeldedienst', async () => {
      const res = await supabase('/auth/v1/health');
      if (res.status !== 200) throw new Error(`Status ${res.status} statt 200 (Projekt pausiert?)`);
      return 'Status 200';
    }],
    ['Supabase: Datenbank antwortet', async () => {
      // Ohne Anmeldung darf man nichts lesen. Antwortet die Datenbank mit "keine Berechtigung" (42501),
      // läuft sie. Bei einem pausierten Projekt kommt eine andere Antwort.
      const res = await supabase('/rest/v1/progress?select=user_id&limit=1');
      const body = await res.json().catch(() => ({}));
      if (res.status === 200 || body.code === '42501') return 'Datenbank erreichbar';
      throw new Error(`Status ${res.status}${body.code ? `, Code ${body.code}` : ''} (Projekt pausiert?)`);
    }],
  );
} else {
  console.log('Supabase übersprungen (SUPABASE_URL und SUPABASE_KEY nicht gesetzt)');
}

function supabase(pfad) {
  return fetch(SUPABASE_URL + pfad, { headers: { apikey: SUPABASE_KEY }, signal: AbortSignal.timeout(20_000) });
}

// Probealarm (Knopf "Run workflow" mit Haken): prüft, ob die Benachrichtigung ankommt.
if (process.env.PROBEALARM === 'true') {
  pruefungen.push(['Probealarm', async () => { throw new Error('absichtlich ausgelöst, um die E-Mail zu testen'); }]);
}

async function holen(url) {
  return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'abiace-waechter' } });
}

async function weiterleitung(von, nach) {
  const res = await holen(von);
  const ziel = res.headers.get('location');
  if (![301, 302, 307, 308].includes(res.status) || ziel !== nach) {
    throw new Error(`Status ${res.status}, Ziel ${ziel ?? 'keins'} statt ${nach}`);
  }
  return `${res.status} nach ${ziel}`;
}

function zertifikatBis(host) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: 443, servername: host, timeout: 20_000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!socket.authorized) return reject(new Error(`Zertifikat ungültig: ${socket.authorizationError}`));
      resolve(new Date(cert.valid_to));
    });
    socket.on('timeout', () => { socket.destroy(); reject(new Error('Zeitüberschreitung')); });
    socket.on('error', reject);
  });
}

// Zwei öffentliche DNS-Dienste, damit ein Fehler bei einem allein keinen Alarm auslöst.
function resolver() {
  return [['Cloudflare', ['1.1.1.1']], ['Google', ['8.8.8.8']]].map(([name, server]) => {
    const r = new Resolver({ timeout: 10_000 });
    r.setServers(server);
    return [name, r];
  });
}

async function allePruefen() {
  const ergebnisse = [];
  for (const [name, fn] of pruefungen) {
    try {
      ergebnisse.push({ name, ok: true, text: await fn() });
    } catch (e) {
      ergebnisse.push({ name, ok: false, text: e.cause ? `${e.message} (${e.cause.code ?? e.cause.message})` : e.message });
    }
  }
  return ergebnisse;
}

// Der Bericht landet in öffentlichen Meldungen: die Supabase-Adresse darin unkenntlich machen.
function verbergen(text) {
  return text.replace(/[a-z0-9]+\.supabase\.(co|in)/gi, '(Supabase-Projekt)');
}

let ergebnisse = await allePruefen();
// Kurze Aussetzer nicht melden: bei einem Fehler nach einer Minute noch einmal prüfen.
if (ergebnisse.some((e) => !e.ok)) {
  console.log('Fehler gefunden, prüfe in 60 Sekunden noch einmal ...');
  await new Promise((r) => setTimeout(r, WARTEN_VOR_WIEDERHOLUNG_MS));
  ergebnisse = await allePruefen();
}

const fehler = ergebnisse.filter((e) => !e.ok);
const zeit = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
const bericht = [
  fehler.length ? `**${fehler.length} Prüfung(en) fehlgeschlagen** (${zeit})` : `Alles in Ordnung (${zeit})`,
  '',
  '| Prüfung | Ergebnis |',
  '|---|---|',
  ...ergebnisse.map((e) => `| ${e.ok ? '✅' : '❌'} ${e.name} | ${verbergen(e.text).replaceAll('|', '/')} |`),
  '',
].join('\n');

writeFileSync('bericht.md', bericht);
console.log(bericht);
process.exit(fehler.length ? 1 : 0);
