#!/bin/bash
# TrackCaster – Start unter macOS (Doppelklick im Finder)
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js wurde nicht gefunden. Bitte von https://nodejs.org (LTS) installieren und erneut starten."
  read -r -p "Enter zum Schließen …"
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Installiere Abhängigkeiten …"
  npm install --omit=dev || { read -r -p "Fehler bei npm install. Enter zum Schließen …"; exit 1; }
fi
node server.js
read -r -p "Beendet. Enter zum Schließen …"
