# Riochi — APK Android + EXE Windows

Le même dossier `www/` (ton appli : `index.html`, `css/`, `js/`) est empaqueté de deux façons :

| Cible | Outil | Résultat |
|---|---|---|
| Android | Capacitor 8 | `Riochi-<version>-debug.apk` (ou `Riochi-<version>.apk` signé) |
| Windows | Electron + electron-builder | `Riochi-<version>-Setup.exe` (installateur) et `Riochi-<version>-Portable.exe` |

Tout est construit par GitHub Actions (`.github/workflows/build.yml`), sans rien installer sur ton PC.

## Obtenir l'APK et l'EXE

1. Crée un dépôt GitHub (privé ou public) et envoie-y tout le contenu de ce dossier :
   ```bash
   git init && git add . && git commit -m "Riochi"
   git branch -M main
   git remote add origin https://github.com/<toi>/riochi.git
   git push -u origin main
   ```
2. Onglet **Actions** → le workflow « Build Riochi (APK + EXE) » démarre tout seul (≈ 5 à 10 min la première fois).
3. Quand il est vert, ouvre l'exécution et télécharge les **Artifacts** : `riochi-apk` et `riochi-windows`.

Pour relancer à la main : Actions → *Build Riochi* → **Run workflow**.

### Publier une release (liens de téléchargement permanents)

Change `"version"` dans `package.json`, puis :

```bash
git tag v1.0.0 && git push origin v1.0.0
```

Le workflow construit tout et joint l'APK et les EXE à une release GitHub.

## Signer l'APK (recommandé)

Sans clé, le workflow produit un APK **debug**, signé avec une clé jetable qui change à chaque exécution : Android refuse alors de l'installer *par-dessus* la version précédente (il faut désinstaller d'abord). Avec ta propre clé, les mises à jour s'installent normalement.

1. Crée la clé une seule fois (garde le fichier et les mots de passe précieusement) :
   ```bash
   keytool -genkeypair -v -keystore riochi.jks -alias riochi -keyalg RSA -keysize 2048 -validity 10000
   base64 -w0 riochi.jks        # macOS : base64 -i riochi.jks
   ```
2. Dépôt GitHub → Settings → Secrets and variables → Actions → ajoute :
   `ANDROID_KEYSTORE_BASE64` (la sortie de base64), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`riochi`) et, si différent du précédent, `ANDROID_KEY_PASSWORD`.

Dès que `ANDROID_KEYSTORE_BASE64` existe, le workflow construit l'APK release et le signe (zipalign + apksigner). Ne mets jamais le `.jks` dans le dépôt (il est dans `.gitignore`).

## Installer

- **Android** : copie l'APK sur le téléphone et ouvre-le (autoriser « sources inconnues » pour l'application qui l'ouvre).
- **Windows** : `Setup.exe` installe l'appli ; `Portable.exe` se lance sans installation. Les EXE ne sont pas signés (pas de certificat) : SmartScreen affiche « Windows a protégé votre ordinateur » → *Informations complémentaires* → *Exécuter quand même*.

## Modifier l'appli

Édite uniquement `www/`. Le workflow recopie `www/` dans le projet Android (`cap sync`) et dans l'EXE à chaque exécution.

## Tester en local (facultatif)

Node 22 ou plus.

```bash
npm install
npm run electron           # ouvre la version Windows/bureau
npm run android:debug      # APK debug (JDK 21 + SDK Android requis) → android/app/build/outputs/apk/debug/
npm run assets             # régénère les icônes (resources/) pour Android
```

## Comment ça marche (et ce qui a été ajouté)

Les plugins de sources appellent des sites d'anime sans CORS et avec des en-têtes (`Referer`, `Origin`) qu'un navigateur interdit. Il faut donc un réseau « natif » :

- **Android** : `capacitor.config.json` active `CapacitorHttp` (fetch/XHR passent par le réseau natif) ; `AndroidManifest.xml` autorise le trafic `http://` ; `allowMixedContent` laisse lire des flux `http://`.
- **Windows** : `electron/` fournit le même service. `main.js` sert `www/` sous `app://riochi` et injecte `native-http.js`, qui remplace `fetch` et `XMLHttpRequest` pour les adresses externes ; les requêtes partent du processus principal (`http-bridge.js`). L'appli n'a aucun accès au système en dehors de ces requêtes HTTP(S).

Une seule modification a été faite dans ton code, `www/js/app.js` (lecteur HLS) : hls.js appelle `xhrSetup` *avant* `xhr.open()`, donc `setRequestHeader` échouait en silence et les en-têtes du plugin n'étaient jamais envoyés aux flux `.m3u8`. Le correctif ouvre la requête avant d'ajouter les en-têtes (3 lignes, commentées dans le fichier).
