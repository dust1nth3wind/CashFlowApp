# Kontura

Kontura ist eine lokale macOS-App für die persönliche Finanzübersicht. Sie führt Exporte von PayPal, Trade Republic und Bankkonten zusammen, erkennt Doppelungen und interne Transfers und ordnet Ausgaben nachvollziehbaren Kategorien zu. Alle Finanzdaten bleiben auf dem eigenen Mac; die App benötigt weder Benutzerkonto noch Cloud-Dienst.

> **Status:** Frühe Version 1. Importformate unterscheiden sich je nach Anbieter und Exportzeitpunkt. Vor der Verwendung mit echten Daten empfiehlt sich deshalb immer ein Import über die Vorschau.

> **Testhinweis:** Die eingecheckten Regressionsexporte sind vollständig fiktiv. Da keine anonymisierten Originalexporte bereitgestellt wurden, muss die formatspezifische Abnahme mit echten PayPal-, Trade-Republic- und Bankdateien vor einem produktiven Einsatz noch ergänzt werden.

## Funktionsumfang

- Übersicht über Einnahmen, Ausgaben, Investitionen und Netto-Cashflow
- Monatsverlauf, Ausgaben nach Kategorie und aktuelle Buchungen
- Importvorschau für CSV, XLSX/XLSM und textbasierte PDF-Auszüge
- vorbereitete Erkennung für PayPal- und Trade-Republic-Exporte
- frei zuordenbare Spalten für andere Banktabellen
- Deduplizierung über externe IDs und stabile Buchungs-Fingerprints
- Erkennung von PayPal-Gegenbuchungen sowie Bank↔Trade-Republic-Transfers
- automatische Kategorien mit manuell korrigierbaren Händler- und Schlüsselwortregeln
- lokale, versionierte JSON-Speicherung mit atomarem Schreiben und Rückfallsicherung

Kontura wertet Geldbewegungen aus. Depotpositionen, Kurse, Renditeberechnung, Kontologins, OCR und eine Synchronisierung zwischen Geräten gehören nicht zu Version 1.

## Technischer Aufbau

| Bereich | Technik |
| --- | --- |
| Desktop | Tauri 2 für das native macOS-Fenster und minimale Systemrechte |
| Oberfläche | React 19, TypeScript, Vite und eigenes CSS |
| Backend | Rust; Validierung, Import, Abgleich und lokale Speicherung |
| Tabellen | Calamine für XLSX/XLSM; `read-excel-file` nur als Browser-Fallback |
| Tests | Vitest, TypeScript, ESLint, Rust-Tests und Playwright |

Die ausgelieferte App verarbeitet Dateien über Rust. Für Browserentwicklung und UI-Tests stellt das Frontend eine lokale Bridge bereit, die keine Serververbindung aufbaut. Geldbeträge werden intern als ganzzahlige Cent-Beträge gespeichert, nicht als Fließkommazahlen.

## Voraussetzungen

Für die Frontendentwicklung werden benötigt:

- Node.js 22.13–22.x oder Node.js 24 und neuer sowie npm
- ein Chromium-Browser für die Playwright-Prüfungen

Für die native macOS-App zusätzlich:

- ein Apple-Silicon-Mac
- macOS 13 oder neuer
- aktuelle Apple Command Line Tools (`xcode-select --install`)
- Rust 1.88 oder neuer über [rustup](https://rustup.rs/) mit dem Ziel `aarch64-apple-darwin`

Einmalige Einrichtung:

```bash
npm ci
rustup toolchain install 1.97.1 --profile minimal --component clippy,rustfmt --target aarch64-apple-darwin
npx playwright install chromium
```

Die empfohlenen Versionen sind über `.nvmrc` und `rust-toolchain.toml` festgeschrieben. Mit `nvm` genügt vor `npm ci` ein `nvm install`. Rustup wählt die Projekt-Toolchain beim Aufruf von Cargo automatisch aus. Auf einem Intel-Mac kann die Oberfläche entwickelt und getestet werden; das vorgesehene Distributionsartefakt zielt jedoch auf Apple Silicon.

## Entwicklung

Browseroberfläche starten:

```bash
npm run dev
```

Native Tauri-App im Entwicklungsmodus starten:

```bash
npm run tauri dev
```

Vite zeigt die lokale Adresse im Terminal an. Es werden keine Finanzdaten an einen Entwicklungsserver oder einen Drittanbieter übertragen.

Der Browsermodus startet standardmäßig mit vollständig fiktiven Demodaten und speichert ausschließlich im Browser-`localStorage` unter `cashflow-demo-state-v1`. `/?demo=1` setzt den Demostand zurück, `/?fresh=1` öffnet einen leeren Erststart. Dieser Fallback verwendet weder das Rust-Backend noch die native JSON-Datei im App-Datenordner.

## Unterstützte Importe

| Quelle | Geeignete Dateien | Hinweise |
| --- | --- | --- |
| PayPal | CSV, XLSX/XLSM, digitale PDF | Aktivitätsberichte mit Datum, Betrag, Währung, Beschreibung und möglichst Transaktions-ID liefern die besten Ergebnisse. |
| Trade Republic | digitale PDF, CSV/XLSX soweit exportiert | Cash-Kontoauszüge werden als Geldbewegungen verarbeitet; Depotbestände und Wertentwicklung werden nicht importiert. |
| Bankkonto | CSV, XLSX/XLSM | Datum, Betrag oder Soll/Haben, Währung, Empfänger, Verwendungszweck und optionale ID können in der Vorschau zugeordnet werden. |
| Bankkonto | digitale PDF | Nur PDFs mit eingebettetem, extrahierbarem Text. Scans benötigen OCR und werden verständlich abgelehnt. |

Der Import arbeitet immer zweistufig: Zuerst werden erkannte Zeilen, Warnungen und mögliche Doppelungen angezeigt. Erst nach Bestätigung gelangen die ausgewählten Buchungen in die lokale Datendatei. Fremdwährungsbuchungen ohne belastbaren EUR-Wert bleiben sichtbar, werden aber nicht in EUR-Summen eingerechnet.

Eine bewusst fiktive Testdatei liegt unter [`e2e/fixtures/bank-demo.csv`](e2e/fixtures/bank-demo.csv). Echte Exporte oder unveränderte persönliche Beispieldateien dürfen nicht in das Repository eingecheckt werden.

## Datenschutz und lokale Speicherung

Kontura hat keine Kontologins, Telemetrie oder Cloud-Synchronisierung. Ausgewählte Importdateien werden gelesen, aber nicht in den App-Datenordner kopiert. Gespeichert werden normalisierte Buchungen, persönliche Regeln, Importprofile und Spaltenzuordnungen, Importläufe, Verknüpfungen und offene Treffer, Einstellungen sowie Dateiname und Hash der Importdateien. Absolute Importpfade und Originaldateien werden nicht gespeichert.

Unter macOS verwaltet Tauri die Daten im anwendungsbezogenen Ordner:

```text
~/Library/Application Support/de.cashflowapp.desktop/
```

Dort liegen:

- `finance-data.json` – aktuelle, versionierte App-Daten
- `finance-data.backup.json` – letzte valide Rückfallsicherung

Beim Speichern schreibt das Backend zunächst eine temporäre Datei, synchronisiert sie auf den Datenträger und ersetzt danach die Hauptdatei atomar. Ist die Hauptdatei beim nächsten Start beschädigt, lädt Kontura die Sicherung und weist in der Oberfläche darauf hin. Die Dateien verwenden lokale Benutzerrechte, sind aber **nicht verschlüsselt**. FileVault wird für Macs mit sensiblen Finanzdaten empfohlen.

## Qualitätssicherung

Die vollständige Übergabeprüfung ausführen:

```bash
npm run check:all
```

Der Befehl umfasst TypeScript, ESLint, Vitest, den Vite-Produktionsbuild, Rust-Formatierung, Clippy ohne Warnungen, Rust-Tests und alle Playwright-Szenarien. Einzelne Teilprüfungen lassen sich bei Bedarf separat starten:

```bash
npm run check
npm run build
npm run check:rust
npm run e2e
```

Die Playwright-Szenarien prüfen Erststart und Übersicht, Navigation, Transaktionsfilter, Kategoriekorrektur einschließlich Transfers, offene Zuordnungen, EUR-Umrechnungen, Spaltenzuordnung, Importvorschau, Wiederholungsimport, Backup-Hinweis sowie grundlegende Tastatur- und Responsive-Eigenschaften. Das kompakte 700-Pixel-Testfenster prüft die Browseroberfläche unterhalb der nativen Mindestbreite; die macOS-App selbst ist auf mindestens 900 Pixel begrenzt. Für eine interaktive Fehlersuche kann Playwright mit sichtbarem Browser gestartet werden:

```bash
npx playwright test --headed
```

Vor einer Veröffentlichung sollte die vollständige Prüfkette ohne Warnungen laufen. Persönliche Regressionsexporte müssen vorher vollständig anonymisiert werden; Namen, IBANs, Kontonummern, Händler-Referenzen und stabile Transaktions-IDs zählen dabei ebenfalls als personenbezogene Daten.

## Apple-Silicon-App und DMG

Das native Release für Apple Silicon wird mit dem Rust-Ziel `aarch64-apple-darwin` gebaut:

```bash
npm run build:mac
```

Tauri legt die `.app`- und `.dmg`-Artefakte anschließend im Release-Bundle-Verzeichnis unter `src-tauri/target/aarch64-apple-darwin/release/bundle/` ab. Dieser `target`-Ordner wird nicht versioniert; ein fertiges DMG muss separat weitergegeben oder auf dem Ziel-Mac neu gebaut werden. Architektur prüfen:

```bash
file src-tauri/target/aarch64-apple-darwin/release/bundle/macos/*.app/Contents/MacOS/*
```

Der lokale Build ist für eine **Ad-hoc-Signatur** vorgesehen. Diese bestätigt die Integrität auf dem eigenen Mac, ersetzt aber weder eine Apple-Developer-ID-Signatur noch die Apple-Notarisierung. Ein weitergegebenes DMG kann deshalb von Gatekeeper blockiert oder mit einer Warnung geöffnet werden. Für eine öffentliche Verteilung sind Developer-ID-Zertifikat, gehärtete Runtime, Notarisierung und Stapling als eigener Release-Schritt erforderlich. Die App ist nicht für den Mac App Store vorbereitet.

Nach dem Build sollten mindestens diese Punkte manuell geprüft werden:

1. DMG einbinden und die App in `Programme` kopieren.
2. App auf einem Apple-Silicon-Mac starten und Dateiauswahl öffnen.
3. Testimport bestätigen, App neu starten und Persistenz prüfen.
4. Hauptdatei nur mit einer separaten Testinstallation beschädigen und die Backup-Wiederherstellung prüfen.

## Projektgrenzen und Sicherheit

- Importdaten gelten grundsätzlich als nicht vertrauenswürdig; Rust validiert alle Änderungen erneut.
- PDFs ohne sichere Tabellen- oder Zeilenerkennung werden nicht geraten.
- Interne Transfers bleiben nachvollziehbar, zählen aber nicht als Einkommen oder Konsumausgabe.
- PayPal-Bankabbuchungen werden mit dem detaillierten PayPal-Kauf verknüpft, damit Ausgaben nicht doppelt erscheinen.
- Manuelle Kategorien haben Vorrang vor persönlichen Regeln; persönliche Regeln haben Vorrang vor den eingebauten Regeln.

Fehlerberichte sollten nur anonymisierte Ausschnitte und keine echte Finanzdatei enthalten.

## Weitergabe und Lizenz

Das Repository enthält derzeit keine Open-Source-Lizenz und ist damit für die interne Zusammenarbeit vorgesehen. Vor einer öffentlichen Veröffentlichung oder Weitergabe außerhalb des vereinbarten Teams muss eine Lizenz- und Rechtefreigabe festgelegt werden.
