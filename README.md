# Wächter für abiace.de

Prüft alle 15 Minuten, ob die Wartelisten-Seite abiace.de richtig läuft:

- Startseite erreichbar (Status 200), richtige Seite, Brevo-Formular vorhanden
- Brevo-Formular antwortet
- `bestaetigt.html`, `datenschutz.html`, `impressum.html` erreichbar
- `www.abiace.de` und `http://` leiten auf `https://abiace.de/` weiter
- Zertifikat noch mindestens 14 Tage gültig
- DNS: `abiace.de` zeigt auf Netlify (75.2.60.5), Mail-Einträge (MX, SPF, DMARC) sind da
- Supabase (Konto und Sync der App): Anmeldedienst und Datenbank antworten. Adresse und öffentlicher
  Schlüssel stehen in den Repo-Secrets `SUPABASE_URL` und `SUPABASE_KEY`, nicht im Code. Die regelmäßige
  Abfrage soll auch verhindern, dass das Gratis-Projekt nach 7 Tagen ohne Nutzung pausiert.

Schlägt eine Prüfung fehl, wird nach einer Minute noch einmal geprüft. Bleibt der Fehler,
legt der Wächter eine Meldung (Issue) mit dem Label `störung` an, und GitHub schickt eine E-Mail.
Solange die Meldung offen ist, kommt keine weitere Mail. Läuft alles wieder, wird sie geschlossen.

**Probealarm:** Reiter "Actions", "Wächter abiace.de", "Run workflow", Haken bei "Probealarm" setzen.

**Lokal prüfen:** `node waechter.mjs`

Hier stehen nur öffentliche Adressen. Keine Schlüssel oder Passwörter eintragen.
