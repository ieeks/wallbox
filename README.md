# Wallbox – E-Auto Lade-Dashboard

**Persönliches E-Auto Lade-Dashboard für Wien.**

Berechnet die echten Kosten jeder Ladung inkl. aller Wiener Netzentgelte, Abgaben und Steuern – verifiziert gegen eine echte Wien Energie Jahresabrechnung 2026.

**→ [Live App](https://ieeks.github.io/wallbox)**

---

## Features

- **Exakte Kostenberechnung** – Netznutzung, Netzverlust, Förderbeitrag, Elektrizitätsabgabe, Gebrauchsabgabe (7%), USt (20%)
- **Sommer-Nieder-Arbeitspreis (SNAP)** – automatische Erkennung: Apr–Sep, 10–16 Uhr → –20% auf Netznutzungsentgelt
- **Ersparnis-Vergleich** – Dashboard zeigt Ersparnis vs. Tesla Supercharger, Tanke Wien (kWh/Zeit) und Benziner (Tiguan)
- **Benzinpreis live** – E-Control API liefert aktuellen Median-Benzinpreis Wien beim App-Start
- **Ersparnis-Chip** – jede Ladung in der History zeigt die Ersparnis gegenüber der günstigsten Alternative
- **Detailseite** – Klick auf einen Verlaufseintrag öffnet vollständige Kostenaufschlüsselung + Ersparnis-Vergleich für diese einzelne Ladung
- **Amortisation** – Gesamt-Ansicht zeigt Fortschrittsbalken und Break-even-Datum für die Wallbox-Investition (vs. Tesla / Tanke Wien / Benzin)
- **go-e Auto-Import** – GitHub Action pollt alle 15 min die go-e Cloud API und speichert abgeschlossene Ladungen automatisch in Firestore; aktive Ladezeit aus `cdi.value`
- **CSV Import** – manueller Bulk-Import aus go-e Wallbox Export (inkl. Ladezeit für Zeittarif-Vergleich)
- **Dashboard** – Monats-/Jahres-/Gesamtübersicht, Verlaufs-Chart, letzte Ladung
- **Cloud Sync** via Firebase Firestore – automatische Sicherung, geräteübergreifend
- **Offline-fähig** – funktioniert auch ohne Internet über localStorage
- **Mobile-first** – Dark Mode, Swipe-to-Delete

## Wiener Tarife 2026

| Position | Cent/kWh |
|---|---|
| Netznutzungsentgelt (NE7) | 6,98 |
| Netzverlustentgelt | 0,70 |
| Erneuerbaren-Förderbeitrag | 0,62 |
| Elektrizitätsabgabe (Haushalt) | 0,10 |
| Gebrauchsabgabe Wien | 7% auf Energie+Netz |
| USt | 20% |

Quelle: [Wiener Netze Preisblätter](https://www.wienernetze.at/stromnetzbedingungen), gültig ab 1.1.2026.

### ☀️ Sommer-Nieder-Arbeitspreis (SNAP)

| | |
|---|---|
| Zeitraum | 1. April – 30. September |
| Uhrzeit | 10:00 – 16:00 |
| Rabatt | –20% auf Netznutzungsentgelt (6,98 → 5,58 ct/kWh) |

Quelle: [E-Control](https://www.e-control.at/sommer-nieder-arbeitspreis). Wird automatisch angewendet – kein Opt-in nötig.

## Detailseite

Klick auf einen Eintrag in „Alle Einträge" öffnet die Detailseite mit:

- **Übersicht** – Datum/Uhrzeit, kWh, aktive Ladezeit (z. B. `6h 39min`), Max. Leistung, SNAP-Badge
- **Kostenaufschlüsselung** – identischer Breakdown wie auf der Eingabeseite (Energie, Netz, GAB, USt, Brutto)
- **Ersparnis vs. Alternativen** – 4 Karten (Tesla, Tanke Wien kWh, Tanke Wien Zeit, Benzin) für diese einzelne Ladung

## Amortisation

Im Gesamt-Zeitraum erscheint die Sektion **🏠 Amortisation Wallbox** mit je einer Karte pro Vergleichsalternative:

- Fortschrittsbalken zeigt wie viel % der Investitionskosten bereits „zurückverdient" sind
- Break-even-Datum basiert auf dem bisherigen monatlichen Ersparnisdurchschnitt
- Installationskosten konfigurierbar in den Einstellungen (Standard: 2.685,40 €)

## go-e Auto-Import

Die GitHub Action `.github/workflows/goe-import.yml` läuft alle 15 Minuten und importiert abgeschlossene Ladungen automatisch.

**Benötigte GitHub Secrets:**

| Secret | Beschreibung |
|---|---|
| `GOE_SERIAL` | 6-stellige go-e Seriennummer |
| `GOE_TOKEN` | Bearer Token aus go-e Cloud |
| `FIREBASE_SERVICE_ACCOUNT` | Service Account JSON (Firebase Console → Projekteinstellungen → Dienstkonten) |

**Funktionsweise:**
- `car === 1` (idle) + `wh > 10` + neuer `lch`-Wert → abgeschlossene Ladung erkannt
- Exakter Session-Zeitpunkt via `rbt` + `lccfc` (ms seit Boot) → SNAP-Erkennung zuverlässig
- Aktive Ladezeit aus `cdi.value` (ms) → `dauer`-Feld im Format `H:MM:SS`
- Duplikat-Schutz: `lch` wird im Charge-Eintrag gespeichert; gelöschte Einträge können neu importiert werden
- Kosten aus Firestore-Settings (`defaultEnergy`, `gebrauchsabgabe`, `ust`) – übernimmt App-Einstellungen automatisch
- `source: 'go-e-auto'` zur Unterscheidung von manuellen Einträgen

## Setup

Keine Build-Schritte, kein Framework – reines HTML/CSS/JS.

**Ohne Cloud:** `index.html` direkt öffnen. Daten in localStorage.

**Mit Cloud:** Firebase-Projekt anlegen, Config in `script.js` eintragen, Firestore-Regeln setzen.

## Tech Stack

- Vanilla HTML/CSS/JS
- Firebase Firestore (Cloud Sync)
- GitHub Actions (go-e Auto-Import)
- E-Control API (Live-Benzinpreise Wien)
- Fonts: Manrope + Inter

## Lizenz

Private Nutzung.
