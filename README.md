# TrackCaster

Zeigt im Stream, welcher Track in Traktor läuft – mit Cover. Läuft lokal (Windows und macOS),
ohne Konto, ohne Cloud, ohne Abo.

Traktor broadcastet an dieses Programm (es gibt sich als Icecast-Server aus). Interpret und
Titel kommen aus dem Broadcast-Stream. Das Cover wird in dieser Reihenfolge gesucht:

1. **Eigenes Cover** im Ordner `covers`, Dateiname `Interpret - Titel.jpg` – hat immer Vorrang
2. **Compilation erkannt** (Albuminterpret „Various Artists", Compilation-Flag oder 3+ verschiedene
   Interpreten im selben Album): Cover der **Original-Single/EP** aus Deezer, sonst iTunes.
   Sammel-Releases werden dabei übersprungen. Findet sich nichts, bleibt das Compilation-Cover.
3. eingebettetes Cover in der Audiodatei (MP3, FLAC, M4A/AAC, AIFF, WAV …)
4. `cover.jpg` / `folder.jpg` im Ordner des Tracks
5. online (Deezer/iTunes), wenn die Datei gar kein Cover hat

Online gefundene Cover landen in `cover-cache` und werden danach ohne Internet genutzt.
Ist ein falsches Cover im Cache, die passende Datei dort löschen (in der `.json` daneben steht,
zu welchem Track sie gehört) oder ein eigenes Cover in `covers` legen.

## Installation

1. [Node.js](https://nodejs.org) (LTS) installieren.
2. ZIP entpacken und starten:
   - **Windows:** `start.bat` doppelklicken.
   - **macOS:** `start.command` doppelklicken. Beim ersten Mal blockiert macOS das Skript, weil es aus dem
     Internet kommt: Rechtsklick → **Öffnen** → **Öffnen** bestätigen (danach geht Doppelklick).
     Klappt das nicht: Terminal öffnen, `cd ` eintippen, den Ordner ins Fenster ziehen, Enter, dann `npm install` und `node server.js`.

   Beim ersten Start werden die Abhängigkeiten installiert.
3. Im Browser **http://localhost:8080/** öffnen: Vorschau, Skin-Auswahl, URL zum Kopieren, Testknopf.

Wichtig: Andere Programme, die Traktors Broadcast auf Port 8000 empfangen, vorher beenden.

## Traktor

Preferences → Broadcasting:

| Feld | Wert |
|---|---|
| Address | `localhost` |
| Port | `8000` |
| Mount path | `/` |
| Password | leer (egal) |
| Format | Ogg Vorbis, 11025 Hz, 32 kBit/s |

Dann im Traktor-Header das Broadcast-Symbol aktivieren. Leuchtet es dauerhaft, steht die Verbindung.
Traktor schickt die Trackinfo, sobald ein Track als „gespielt" gilt (Deck läuft und ist im Mix hörbar).

## Zwei PCs (DJ-PC + Stream-PC)

Das Programm läuft auf dem **DJ-PC**, denn nur dort liegen Musikdateien und Collection (für die Cover).
Traktor bleibt auf `localhost`. Auf dem Stream-PC muss nichts installiert werden.

1. Programm auf dem DJ-PC starten. Die Konsole zeigt die Netzwerk-URLs, z. B. `http://192.168.178.20:8080/overlay`.
2. Beim ersten Start fragt das System nach eingehenden Verbindungen:
   - **Windows:** „Private Netzwerke" erlauben. Kam keine Abfrage oder wurde sie abgelehnt,
     **firewall-freigeben.bat** ausführen (fragt nach Adminrechten).
   - **macOS:** „Eingehende Verbindungen für node erlauben?" mit **Erlauben** bestätigen. Falls versehentlich
     abgelehnt: Systemeinstellungen → Netzwerk → Firewall → Optionen → `node` auf „Eingehende Verbindungen erlauben".
3. In OBS auf dem Stream-PC die Browserquelle mit dieser URL anlegen. Auf der Einstellungsseite
   (`http://localhost:8080/` am DJ-PC) gibt es dafür die Auswahl „OBS läuft auf … anderem PC".

Tipps: Die IP kann sich ändern, wenn der Router sie neu vergibt – dann entweder die Variante mit dem
Rechnernamen nehmen (beim Mac z. B. `Svens-MacBook.local`) oder im Router für den DJ-PC eine feste IP einstellen. Steht das Netzwerk in Windows auf
„Öffentlich", greift die Firewall-Freigabe nicht; dann in den Windows-Einstellungen auf „Privat" umstellen.

## OBS

Browserquelle mit `http://localhost:8080/overlay` anlegen, z. B. 800 × 300 (Big Cover: 400 × 600).

URL-Parameter (die Einstellungsseite baut die URL für dich):

| Parameter | Werte | Standard |
|---|---|---|
| `skin` | `classic`, `card`, `vinyl`, `bar`, `big`, `minimal` | `classic` |
| `align` | `right` | links |
| `valign` | `bottom` | oben |
| `scale` | z. B. `1.5` | `1` |
| `hide` | Sekunden, nach denen das Overlay ausblendet (`0` = nie) | `0` |
| `accent` | Hex-Farbe ohne `#`, z. B. `ff3366` | `22d3ee` |
| `line` | Linienfarbe beim Classic-Skin | `ffffff` |
| `label` | Optionale Überschrift über dem Track | keine |
| `album` | `1` zeigt das Album | aus (außer Big) |
| `nocover` | `1` blendet das Cover aus | |

Zusätzlich wird `current-track.txt` (`Interpret - Titel`) im Programmordner geschrieben – nutzbar als OBS-Textquelle.

## config.json

```json
{
  "ingestPort": 8000,
  "webPort": 8080,
  "collectionPath": "auto",
  "onlineCoverFallback": true,
  "compilationCovers": "online",
  "writeTextFile": true
}
```

`collectionPath: "auto"` sucht die neueste `collection.nml` unter `Dokumente\Native Instruments\Traktor …`
(auch im OneDrive-Dokumente-Ordner). Liegt sie woanders, hier den vollen Pfad eintragen
(Windows mit doppelten Backslashes: `"D:\\Traktor\\collection.nml"`, macOS z. B.
`"/Users/sven/Documents/Native Instruments/Traktor 3.11.1/collection.nml"`). Änderungen an der Collection werden automatisch neu eingelesen.

`compilationCovers`: `"online"` sucht bei Compilations das Original-Cover, `"file"` nimmt immer das Cover aus der Datei.

## Wenn etwas nicht klappt

- **Broadcast-Symbol blinkt nur:** Programm läuft nicht oder Port 8000 ist belegt (Konsolenfenster prüfen).
- **Titel kommt, Cover nicht:** Track hat kein eingebettetes Cover und liegt nicht in der Collection mit genau
  diesem Interpret/Titel. Die Konsole zeigt, woher ein Cover kam oder dass keins gefunden wurde.
- **Overlay leer:** In OBS die Browserquelle aktualisieren („Cache der aktuellen Seite aktualisieren").
