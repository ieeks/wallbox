# 🦊 Ladefuchs – Firebase Setup Anleitung

## Was du brauchst
- Ein Google-Konto (hast du schon)
- 10 Minuten Zeit

## Schritt 1: Firebase Projekt erstellen

1. Gehe zu **https://console.firebase.google.com**
2. Klicke **„Projekt erstellen"**
3. Projektname: `ladefuchs` (oder wie du willst)
4. Google Analytics: **kannst du abschalten** (brauchst du nicht)
5. Klicke **„Projekt erstellen"** → warte kurz → **„Weiter"**

## Schritt 2: Web-App registrieren

1. Auf der Projekt-Übersicht klicke das **Web-Icon** `</>` 
2. App-Name: `Ladefuchs Web`
3. **Firebase Hosting**: Häkchen setzen ✅
4. Klicke **„App registrieren"**
5. Du siehst jetzt einen Code-Block mit `firebaseConfig` → **DIESE WERTE BRAUCHST DU:**

```javascript
const firebaseConfig = {
  apiKey: "AIzaSy...",           // ← kopieren
  authDomain: "ladefuchs-xxx.firebaseapp.com",
  projectId: "ladefuchs-xxx",
  storageBucket: "ladefuchs-xxx.appspot.com",
  messagingSenderId: "123...",
  appId: "1:123...:web:abc..."
};
```

6. Klicke **„Weiter"** bis zum Ende

## Schritt 3: Google Login aktivieren

1. Im linken Menü: **Build → Authentication**
2. Klicke **„Los geht's"**
3. Tab **„Anmeldungsmethode"** → Klicke auf **Google**
4. **Aktivieren** (Schalter auf Ein)
5. Wähle deine E-Mail als Support-E-Mail
6. **Speichern**

## Schritt 4: Firestore Datenbank erstellen

1. Im linken Menü: **Build → Firestore Database**
2. Klicke **„Datenbank erstellen"**
3. Standort: **europe-west3 (Frankfurt)** ← am nächsten zu Wien
4. Sicherheitsregeln: **„Im Produktionsmodus starten"**
5. Klicke **„Erstellen"**

### Sicherheitsregeln setzen

1. Im Firestore-Bereich klicke auf **„Regeln"** (Tab oben)
2. Ersetze den Inhalt mit:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

3. Klicke **„Veröffentlichen"**

> Diese Regel stellt sicher, dass jeder nur seine eigenen Daten lesen/schreiben kann.

## Schritt 5: Config in die App einsetzen

1. Öffne `ladefuchs.html` in einem Texteditor
2. Suche nach `DEIN_API_KEY` (ganz oben im Script-Bereich)
3. Ersetze die Platzhalter mit deinen echten Werten:

```javascript
const FIREBASE_CONFIG = {
  apiKey: "AIzaSy...",                    // ← dein Key
  authDomain: "ladefuchs-xxx.firebaseapp.com",
  projectId: "ladefuchs-xxx",
  storageBucket: "ladefuchs-xxx.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef"
};
```

4. Speichern. Fertig!

## Schritt 6: Hosting (optional)

### Option A: Firebase Hosting (empfohlen)

```bash
# Einmalig: Firebase CLI installieren
npm install -g firebase-tools

# Login
firebase login

# Im Ordner mit deiner ladefuchs.html:
firebase init hosting
# → Projekt auswählen
# → Public directory: . (Punkt)
# → Single-page app: No
# → Overwrite index.html: No

# Deployen
firebase deploy --only hosting
```

Deine App ist dann unter `https://ladefuchs-xxx.web.app` erreichbar.

### Option B: Netlify (noch einfacher)

1. Gehe zu **https://app.netlify.com**
2. Ziehe den Ordner mit `ladefuchs.html` per Drag & Drop rein
3. Fertig – du bekommst eine URL wie `https://xyz.netlify.app`

### Option C: GitHub Pages (kostenlos)

1. Erstelle ein GitHub Repository
2. Lade `ladefuchs.html` als `index.html` hoch
3. Settings → Pages → Source: main branch
4. Fertig unter `https://deinname.github.io/ladefuchs/`

## Kosten

**Alles kostenlos.** Der Firebase Free Tier (Spark Plan) beinhaltet:
- 1 GB Firestore Speicher
- 50.000 Reads / Tag
- 20.000 Writes / Tag
- 10 GB Hosting Traffic / Monat
- Unlimited Authentication

Für ein privates Dashboard reicht das ewig.

## Funktionsweise

- **Login:** Google-Anmeldung mit einem Klick
- **Sync:** Jeder neue Eintrag wird automatisch in Firestore gespeichert
- **Offline:** localStorage bleibt als Fallback – die App funktioniert auch ohne Internet
- **Merge:** Beim Login werden lokale und Cloud-Daten zusammengeführt
- **Sync-Status:** Der Badge im Header zeigt „Cloud" (grün), „Sync..." (gelb), oder „Lokal" (grau)

## Troubleshooting

**Login funktioniert nicht?**
→ Prüfe ob Google als Anmeldungsmethode in Firebase Authentication aktiviert ist

**Daten werden nicht gespeichert?**
→ Prüfe die Firestore Sicherheitsregeln (Schritt 4)

**App zeigt "Firebase nicht konfiguriert"?**
→ Die Config-Werte in der HTML-Datei sind noch Platzhalter. Ersetze sie mit deinen echten Werten.
