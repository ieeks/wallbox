# Firebase: tatsächliche App-Pfade und Umstellung

## Stand und Grenze dieser Dokumentation

Die App verwendet `index.html` und die Firebase-Konfiguration in `script.js`.
Sie arbeitet vor Paket 2 ohne Google-Login mit einem gemeinsamen Haushalt.
Die zuvor hier dokumentierte Anleitung für `ladefuchs.html` und `/users/{userId}`
war veraltet und passt nicht zu dieser App.

**Die aktuell produktiv veröffentlichten Firestore-Regeln sind im Repository
nicht hinterlegt und wurden für PR #27 nicht unabhängig geprüft.** Die folgende
Tabelle beschreibt den Zugriff, den der Code benötigt, nicht einen behaupteten
oder empfohlenen öffentlich freigegebenen Regelstand.

| Pfad | Zugriff aus dem Browser | Auto-Import |
|---|---|---|
| `haushalte/haushalt` | Lesen und Schreiben: Ladungen, Einstellungen | Lesen und Schreiben |
| `haushalte/charge-deletions` | Lesen und Schreiben: Löschmarker, neu mit PR #27 | Lesen und Schreiben |
| `haushalte/haushalt/trips/{tripId}` | Lesen, Anlegen, Ändern, Löschen | Kein Zugriff nötig |
| `haushalte/goe-peak-tracker` | Kein Zugriff nötig | Lesen, Schreiben, Löschen |

Der Auto-Import verwendet das Admin-SDK mit dem GitHub-Secret
`FIREBASE_SERVICE_ACCOUNT`. Ein grüner Workflow beweist daher **nicht**, dass
der Browser auf `charge-deletions` zugreifen darf. Admin-SDK-Zugriffe werden
über IAM und nicht über die Firestore-Regeln des Browser-Clients berechtigt.

## Vor dem Merge von PR #27

- [ ] Aktuellen Datenbestand sichern: Haushalt inklusive Einstellungen,
      Trips-Untercollection und, sofern vorhanden, Löschmarker. Der bisherige
      JSON-Export der App enthält nur Ladungen und ist kein vollständiges Backup.
- [ ] In Firebase Console → Firestore Database → Regeln die tatsächlich
      veröffentlichten Regeln prüfen und den Stand sichern.
- [ ] Prüfen, dass der **aktuelle Browser-Anmeldezustand** Lesen und Schreiben
      auf Haushalt UND `haushalte/charge-deletions` erlaubt. Beispielsweise
      konkrete Pfade in der Rules Playground testen; keine zusätzlichen Daten
      öffentlich freigeben, nur damit ein Test grün wird.
- [ ] Falls dafür eine Regeländerung nötig ist: mit der Umstellung abstimmen,
      nicht blind ein öffentliches `allow read, write: if true` ergänzen.
      Der vollständige Zugriffsschutz ist separat in Issue #28 vorgesehen.
- [ ] Nach dem Einspielen alle Geräte/Tabs neu laden. Im Browser muss der Sync
      erfolgreich sein; bei fehlenden Rechten erscheint jetzt ein dauerhafter
      Fehlerhinweis statt lediglich „Lokal“.
- [ ] Einmal real prüfen: zwei Geräte, eine neue Ladung, Löschung auf Gerät A,
      Sync auf Gerät B und ein Auto-Import dazwischen. Die Ladung darf nicht
      zurückkommen; andere neue Einträge müssen erhalten bleiben.
- [ ] Im Import-Protokoll das tatsächliche `eto`-Format prüfen. Der Code akzeptiert
      eine positive sichere Ganzzahl sowie einen ganzzahligen Dezimalstring.
      Fehlt der Wert, wird der eingeschränkte Legacy-Abgleich deutlich protokolliert.

**Kein Fallback ohne Löschschutz:** Haushalt und Löschmarker werden absichtlich
in derselben Transaktion gelesen/geschrieben. Bei fehlenden Rechten findet kein
Teil-Schreiben statt; ausstehende Änderungen bleiben lokal erhalten, soweit der
Browser lokalen Speicher zulässt. Andernfalls zeigt die App ausdrücklich an,
dass Änderungen nicht sicher gespeichert sind. Beschädigte Outbox-Daten werden
nicht still gelöscht; erst sichern und den Fehler prüfen.

## Rücksetzen und Rollback

„Ladungen & Einstellungen zurücksetzen“ lässt Trips ausdrücklich bestehen.
Löschmarker und noch ausstehende Operationen bleiben ebenfalls erhalten.
Das Settings-Map-Feld wird explizit mit `mergeFields: ['settings']` ersetzt.
Eine leere Map würde auch bei `merge: true` das alte Map-Feld überschreiben;
sie ist in Firestore kein No-op:
[Firebase-Dokumentation zu Map-Feldern](https://firebase.google.com/docs/firestore/manage-data/add-data).

Ein Rollback auf v1.16.1 löscht das separate Löschdokument nicht. Alte Browser und
der alte Importer ignorieren dessen Inhalt jedoch und können gelöschte Sessions
mit neuen IDs wieder anlegen. Ein späteres Update repariert solche Fälle nicht
pauschal. Deshalb Backup sichern und alte Clients nach der Umstellung schließen;
ein Rollback ist kein folgenloser Weg zurück.

## Später: Google-Login und Haushaltsfreigabe

Issue #28 dokumentiert Paket 2: Google-Anmeldung, feste Freigabe der Haushalts-UIDs,
passende Regeln für obige Pfade, Verhalten beim Abmelden und iPhone/Safari-Prüfung.
App und Regeln zusammen umstellen. Dieses Setup-Dokument aktiviert keine
Authentifizierung und verändert keine produktiven Regeln.
