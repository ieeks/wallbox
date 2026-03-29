# 🦊 Ladefuchs

**Persönliches E-Auto Lade-Dashboard für Wien.**

Berechnet die echten Kosten jeder Ladung inkl. aller Wiener Netzentgelte, Abgaben und Steuern – verifiziert gegen eine echte Wien Energie Jahresabrechnung 2026.

**→ [Live App](https://ieeks.github.io/wallbox)**

---

## Features

- **Exakte Kostenberechnung** – Netznutzung, Netzverlust, Förderbeitrag, Elektrizitätsabgabe, Gebrauchsabgabe (7%), USt (20%)
- **Sommer-Nieder-Arbeitspreis (SNAP)** – automatische Erkennung: Apr–Sep, 10–16 Uhr → –20% auf Netznutzungsentgelt; Ersparnis wird live angezeigt
- **Dashboard** mit Monats-/Jahres-/Gesamtübersicht, Verlaufs-Chart und letzter Ladung
- **CSV/JSON Import** für Bulk-Einträge (z.B. go-e Wallbox Export) – Startzeit wird automatisch für SNAP-Berechnung verwendet
- **Cloud Sync** via Firebase – Google Login, automatische Sicherung
- **Offline-fähig** – funktioniert auch ohne Internet über localStorage
- **Mobile-first** – Dark Mode, Swipe-to-Delete, PWA-ready

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

## Setup

Die App ist eine einzelne HTML-Datei – kein Build-Prozess, kein Framework.

**Ohne Cloud:** Einfach `index.html` öffnen. Daten werden in localStorage gespeichert.

**Mit Cloud:** Firebase-Projekt anlegen und Config einsetzen → siehe [FIREBASE-SETUP.md](FIREBASE-SETUP.md).

## Tech Stack

- Vanilla HTML/CSS/JS
- Tailwind-inspiriertes Custom CSS
- Firebase Auth + Firestore (optional)
- Fonts: Manrope + Inter

## Lizenz

Private Nutzung.
