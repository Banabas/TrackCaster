// TrackCaster — Track-Overlay für OBS, gespeist aus dem Traktor-Broadcast
// Traktor broadcastet an diesen Server (gibt sich als Icecast aus), wir lesen
// Interpret/Titel aus den Ogg-Vorbis-Kommentaren, suchen den Track in der
// Traktor-Collection und liefern ein OBS-Overlay inkl. Cover aus.

'use strict';
const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---------------------------------------------------------------- Konfiguration
const CONFIG_FILE = path.join(__dirname, 'config.json');
const config = Object.assign({
  ingestPort: 8000,          // muss zum Port in Traktor > Broadcasting passen
  webPort: 8080,             // hier läuft das Overlay für OBS
  collectionPath: 'auto',    // Pfad zur collection.nml oder "auto"
  onlineCoverFallback: true, // Cover online suchen, wenn die Datei keins hat
  // Bei Compilations (Various Artists) das Cover der Original-Single/EP online suchen
  // statt des Sammel-Covers: "online" oder "file"
  compilationCovers: 'online',
  writeTextFile: true,       // current-track.txt für eine OBS-Textquelle schreiben
}, readJson(CONFIG_FILE) || {});

const OVERRIDE_DIR = path.join(__dirname, 'covers');      // eigene Cover: "Interpret - Titel.jpg"
const CACHE_DIR = path.join(__dirname, 'cover-cache');    // online gefundene Cover
for (const d of [OVERRIDE_DIR, CACHE_DIR]) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function log(...a) {
  const t = new Date().toLocaleTimeString('de-DE');
  console.log(`[${t}]`, ...a);
}

// ---------------------------------------------------------------- Zustand
let state = { artist: '', title: '', album: '', cover: null, id: 0, at: 0, source: null };
let traktorConnected = false;
const covers = new Map();      // id -> { mime, data }
const sseClients = new Set();

function publish() {
  const payload = JSON.stringify(publicState());
  for (const res of sseClients) res.write(`data: ${payload}\n\n`);
  if (config.writeTextFile) {
    const line = state.title ? (state.artist ? `${state.artist} - ${state.title}` : state.title) : '';
    fs.writeFile(path.join(__dirname, 'current-track.txt'), line, () => {});
  }
}

function publicState() {
  return {
    artist: state.artist, title: state.title, album: state.album,
    cover: state.cover ? `/cover/${state.cover}` : null,
    id: state.id, at: state.at, connected: traktorConnected,
  };
}

async function setTrack({ artist = '', title = '' }, source = 'traktor') {
  artist = clean(artist); title = clean(title);
  // Manche Setups liefern nur "Interpret - Titel" im TITLE-Feld
  if (!artist && title.includes(' - ')) {
    const i = title.indexOf(' - ');
    artist = title.slice(0, i).trim(); title = title.slice(i + 3).trim();
  }
  if (artist === state.artist && title === state.title) return;

  const id = state.id + 1;
  state = { artist, title, album: '', cover: null, id, at: Date.now(), source };
  log(`♪ ${artist || '?'} — ${title || '?'}`);
  publish(); // Text sofort zeigen, Cover kommt hinterher

  try {
    const info = await findCover(artist, title);
    if (state.id !== id) return; // inzwischen neuer Track
    if (info.album) state.album = info.album;
    if (info.cover) {
      const key = crypto.createHash('md5').update(info.cover.data).digest('hex').slice(0, 12);
      covers.set(key, info.cover);
      if (covers.size > 50) covers.delete(covers.keys().next().value);
      state.cover = key;
      log(`  Cover: ${info.coverSource}`);
    } else {
      log('  Kein Cover gefunden');
    }
    if (info.album || info.cover) publish();
  } catch (e) {
    log('  Cover-Fehler:', e.message);
  }
}

// IPv4-Adressen im lokalen Netz (ohne Loopback und ohne 169.254.x.x)
function lanHostname() {
  const h = os.hostname();
  return process.platform === 'darwin' && !h.includes('.') ? h + '.local' : h;
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  return [...new Set(out)];
}

function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

// ---------------------------------------------------------------- Traktor-Collection
let nml = { file: null, mtime: 0, byKey: new Map(), byTitle: new Map(), albumArtists: new Map() };

function findCollectionFile() {
  if (config.collectionPath && config.collectionPath !== 'auto') return config.collectionPath;
  const docs = [
    path.join(os.homedir(), 'Documents', 'Native Instruments'),
    path.join(os.homedir(), 'OneDrive', 'Documents', 'Native Instruments'),
    path.join(os.homedir(), 'OneDrive', 'Dokumente', 'Native Instruments'),
    path.join(os.homedir(), 'Dokumente', 'Native Instruments'),
  ];
  let best = null;
  for (const base of docs) {
    let dirs = [];
    try { dirs = fs.readdirSync(base); } catch { continue; }
    for (const d of dirs) {
      if (!/^Traktor/i.test(d)) continue;
      const f = path.join(base, d, 'collection.nml');
      try {
        const st = fs.statSync(f);
        if (!best || st.mtimeMs > best.mtime) best = { file: f, mtime: st.mtimeMs };
      } catch {}
    }
  }
  return best && best.file;
}

function decodeXml(s) {
  return s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (map[e.toLowerCase()]) return map[e.toLowerCase()];
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

function attrs(tag) {
  const out = {};
  const re = /([A-Z_]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(tag))) out[m[1]] = decodeXml(m[2]);
  return out;
}

function norm(s) {
  return String(s || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// Traktor speichert Pfade als VOLUME="C:" DIR="/:Users/:Sven/:Music/:" FILE="x.mp3"
function nmlPath(loc) {
  const parts = (loc.DIR || '').split('/:').filter(Boolean);
  if (process.platform === 'win32') {
    return path.win32.join((loc.VOLUME || 'C:') + '\\', ...parts, loc.FILE || '');
  }
  const p = path.posix.join('/', ...parts, loc.FILE || '');
  if (fs.existsSync(p)) return p;
  return path.posix.join('/Volumes', loc.VOLUME || '', ...parts, loc.FILE || '');
}

function loadCollection() {
  const file = findCollectionFile();
  if (!file) return false;
  let st;
  try { st = fs.statSync(file); } catch { return false; }
  if (nml.file === file && nml.mtime === st.mtimeMs) return true;

  const xml = fs.readFileSync(file, 'utf8');
  const byKey = new Map(), byTitle = new Map(), albumArtists = new Map();
  const entryRe = /<ENTRY\b([^>]*)>([\s\S]*?)<\/ENTRY>/g;
  let m, count = 0;
  while ((m = entryRe.exec(xml))) {
    const e = attrs(m[1]);
    const locTag = /<LOCATION\b([^>]*)\/?>/.exec(m[2]);
    if (!locTag) continue;
    const albumTag = /<ALBUM\b([^>]*)\/?>/.exec(m[2]);
    const rec = {
      file: nmlPath(attrs(locTag[1])),
      album: albumTag ? (attrs(albumTag[1]).TITLE || '') : '',
    };
    const t = norm(e.TITLE), a = norm(e.ARTIST);
    if (!t) continue;
    byKey.set(`${a}|${t}`, rec);
    if (!byTitle.has(t)) byTitle.set(t, rec);
    // Album-Schlüssel = Ordner + Albumtitel; viele verschiedene Interpreten → Compilation
    if (rec.album) {
      const k = `${path.dirname(rec.file)}|${norm(rec.album)}`;
      rec.albumKey = k;
      if (!albumArtists.has(k)) albumArtists.set(k, new Set());
      albumArtists.get(k).add(a);
    }
    count++;
  }
  nml = { file, mtime: st.mtimeMs, byKey, byTitle, albumArtists };
  log(`Collection geladen: ${count} Tracks aus ${file}`);
  return true;
}

// ---------------------------------------------------------------- Cover-Suche
let mm = null;
async function musicMetadata() {
  if (!mm) mm = await import('music-metadata');
  return mm;
}

const IMG_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const IMG_NAMES = ['cover', 'folder', 'front', 'albumart', 'album'];
const VARIOUS_RE = /^(various( artists)?|va|v\.?\s?a\.?|diverse( interpreten)?|verschiedene( interpreten| künstler)?|sampler|compilation)$/i;

function imageFile(file, source) {
  const mime = IMG_EXT[path.extname(file).toLowerCase()];
  return mime ? { cover: { mime, data: fs.readFileSync(file) }, source } : null;
}

// 1) Eigene Cover im Ordner "covers": Dateiname "Interpret - Titel.jpg" (oder nur "Titel.jpg")
function overrideCover(artist, title) {
  let files = [];
  try { files = fs.readdirSync(OVERRIDE_DIR); } catch { return null; }
  const want = [norm(`${artist} ${title}`), norm(title)];
  for (const w of want) {
    for (const f of files) {
      const ext = path.extname(f);
      if (!IMG_EXT[ext.toLowerCase()]) continue;
      if (norm(path.basename(f, ext)) === w) return imageFile(path.join(OVERRIDE_DIR, f), `eigenes Cover covers/${f}`);
    }
  }
  return null;
}

// --- Titel-/Interpreten-Abgleich für die Online-Suche
function splitTitle(t) {
  const version = (String(t).match(/[\(\[]([^\)\]]*)[\)\]]/g) || []).map(norm).join(' ');
  const core = norm(String(t).replace(/[\(\[][^\)\]]*[\)\]]/g, ' ').replace(/\s-\s.*$/, ''));
  return { core, version };
}
function artistsFromRaw(a) {
  return String(a).split(/,|&|\/|\+|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bvs\.?\b|\bx\b|\bund\b|\band\b/i)
    .map(norm).filter(Boolean);
}
function artistMatches(local, remote) {
  const r = norm(remote);
  return artistsFromRaw(local).some(p => r.includes(p) || p.includes(r));
}
function titleScore(localTitle, remoteTitle, remoteVersion = '') {
  const l = splitTitle(localTitle), r = splitTitle(`${remoteTitle} ${remoteVersion}`);
  if (!l.core || l.core !== r.core) return -1;
  const lv = l.version.replace(/original mix/, '').trim();
  const rv = r.version.replace(/original mix/, '').trim();
  return lv === rv ? 3 : (lv && rv && (lv.includes(rv) || rv.includes(lv))) ? 2 : 1;
}

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'TrackCaster/1.0 (+https://github.com/Banabas/TrackCaster)' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function getImage(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return { mime: r.headers.get('content-type') || 'image/jpeg', data: Buffer.from(await r.arrayBuffer()) };
}

// Deezer: Original-Release (Single/EP/Album des Künstlers), Compilations werden übersprungen
async function deezerCover(artist, title, skipAlbum) {
  const core = splitTitle(title).core;
  const queries = [
    `artist:"${artist}" track:"${String(title).replace(/[\(\[][^\)\]]*[\)\]]/g, '').trim()}"`,
    `${artist} ${core}`,
  ];
  for (const q of queries) {
    const j = await getJson(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=25`);
    const hits = (j.data || [])
      .map(t => ({ t, score: titleScore(title, t.title, t.title_version) }))
      .filter(h => h.score >= 0 && artistMatches(artist, h.t.artist && h.t.artist.name))
      .filter(h => !skipAlbum || norm(h.t.album && h.t.album.title) !== norm(skipAlbum))
      .sort((a, b) => b.score - a.score || (b.t.rank || 0) - (a.t.rank || 0));
    const seen = new Set();
    const albums = [];
    for (const h of hits) {
      if (seen.has(h.t.album.id)) continue;
      seen.add(h.t.album.id);
      albums.push(h);
      if (albums.length >= 6) break;
    }
    const details = await Promise.all(albums.map(h =>
      getJson(`https://api.deezer.com/album/${h.t.album.id}`).then(d => ({ ...h, d })).catch(() => null)));
    const rank = { single: 0, ep: 1, album: 2 };
    const best = details.filter(Boolean)
      .filter(x => x.d.record_type !== 'compile' && !VARIOUS_RE.test((x.d.artist && x.d.artist.name) || ''))
      .sort((a, b) => b.score - a.score || (rank[a.d.record_type] ?? 3) - (rank[b.d.record_type] ?? 3))[0];
    if (best) {
      const url = best.d.cover_xl || best.t.album.cover_xl || best.t.album.cover_big;
      if (url) return { cover: await getImage(url), source: `Deezer (${best.d.record_type || 'release'} „${best.d.title}")`, album: best.d.title };
    }
  }
  return null;
}

// iTunes: gleiches Prinzip, Compilations (collectionArtistName = Various Artists) überspringen
async function itunesCover(artist, title, skipAlbum, allowCompilation) {
  const term = encodeURIComponent(`${artist} ${splitTitle(title).core}`.trim());
  const j = await getJson(`https://itunes.apple.com/search?term=${term}&entity=song&limit=25&country=DE`);
  const best = (j.results || [])
    .map(r => ({ r, score: titleScore(title, r.trackName) }))
    .filter(h => h.score >= 0 && artistMatches(artist, h.r.artistName))
    .filter(h => allowCompilation || !VARIOUS_RE.test(h.r.collectionArtistName || ''))
    .filter(h => !skipAlbum || norm(h.r.collectionName) !== norm(skipAlbum))
    .sort((a, b) => b.score - a.score || (a.r.trackCount || 99) - (b.r.trackCount || 99))[0];
  if (!best || !best.r.artworkUrl100) return null;
  return {
    cover: await getImage(best.r.artworkUrl100.replace('100x100', '1000x1000')),
    source: `iTunes („${best.r.collectionName}")`, album: best.r.collectionName,
  };
}

const onlineMisses = new Map(); // Schlüssel -> Zeitpunkt, damit wir nicht dauernd neu suchen

async function onlineCover(artist, title, skipAlbum) {
  if (!title) return null;
  const key = crypto.createHash('md5').update(`${norm(artist)}|${norm(title)}`).digest('hex');
  // Platten-Cache
  for (const ext of Object.keys(IMG_EXT)) {
    const f = path.join(CACHE_DIR, key + ext);
    if (fs.existsSync(f)) {
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, key + '.json'), 'utf8')); } catch {}
      return { ...imageFile(f, `${meta.source || 'online'} (Cache)`), album: meta.album || '' };
    }
  }
  if (Date.now() - (onlineMisses.get(key) || 0) < 10 * 60 * 1000) return null;

  let found = null;
  for (const fn of [
    () => deezerCover(artist, title, skipAlbum),
    () => itunesCover(artist, title, skipAlbum, false),
  ]) {
    try { found = await fn(); } catch (e) { log('  Online-Suche:', e.message); }
    if (found) break;
  }
  if (!found) { onlineMisses.set(key, Date.now()); return null; }

  const ext = found.cover.mime.includes('png') ? '.png' : found.cover.mime.includes('webp') ? '.webp' : '.jpg';
  try {
    fs.writeFileSync(path.join(CACHE_DIR, key + ext), found.cover.data);
    fs.writeFileSync(path.join(CACHE_DIR, key + '.json'),
      JSON.stringify({ artist, title, source: found.source, album: found.album }, null, 2));
  } catch {}
  return found;
}

function isCompilation(rec, meta) {
  const c = meta && meta.common;
  if (c && c.compilation) return true;
  if (c && c.albumartist && VARIOUS_RE.test(c.albumartist.trim())) return true;
  if (rec && rec.albumKey) {
    const artists = nml.albumArtists.get(rec.albumKey);
    if (artists && artists.size >= 3) return true;
  }
  return false;
}

async function findCover(artist, title) {
  const result = { cover: null, album: '', coverSource: '' };
  const take = (r) => { if (r && r.cover) { result.cover = r.cover; result.coverSource = r.source; if (r.album) result.album = r.album; } };

  // 1) Eigenes Cover hat immer Vorrang
  take(overrideCover(artist, title));
  if (result.cover) return result;

  // 2) Track in der Collection → Datei lesen
  try { loadCollection(); } catch (e) { log('Collection-Fehler:', e.message); }
  const rec = nml.byKey.get(`${norm(artist)}|${norm(title)}`) || nml.byTitle.get(norm(title));
  let fileCover = null, meta = null;
  if (rec) {
    result.album = rec.album;
    if (fs.existsSync(rec.file)) {
      try {
        const { parseFile } = await musicMetadata();
        meta = await parseFile(rec.file, { duration: false, skipPostHeaders: true });
        const pic = meta.common.picture && meta.common.picture[0];
        if (pic && pic.data && pic.data.length) {
          fileCover = { cover: { mime: pic.format || 'image/jpeg', data: Buffer.from(pic.data) },
            source: `eingebettet in ${path.basename(rec.file)}` };
        }
        if (!result.album && meta.common.album) result.album = meta.common.album;
      } catch (e) { log('  Datei nicht lesbar:', e.message); }

      if (!fileCover) {
        const dir = path.dirname(rec.file);
        try {
          for (const f of fs.readdirSync(dir)) {
            const ext = path.extname(f).toLowerCase();
            if (IMG_EXT[ext] && IMG_NAMES.includes(path.basename(f, ext).toLowerCase())) {
              fileCover = imageFile(path.join(dir, f), `${f} im Track-Ordner`);
              break;
            }
          }
        } catch {}
      }
    }
  }

  // 3) Compilation → Original-Cover online suchen, sonst Datei-Cover
  if (rec && config.compilationCovers === 'online' && isCompilation(rec, meta)) {
    log(`  Compilation erkannt („${result.album}") → suche Original-Cover`);
    const online = await onlineCover(artist, title, result.album);
    if (online) { take(online); return result; }
    log('  Kein Original-Cover gefunden, nehme das Compilation-Cover');
  }
  if (fileCover) { take({ ...fileCover, album: '' }); return result; }

  // 4) Nichts in der Datei → online
  if (config.onlineCoverFallback) take(await onlineCover(artist, title, null));
  return result;
}

// ---------------------------------------------------------------- Ogg/Vorbis-Parser
// Traktor sendet bei jedem Trackwechsel einen neuen verketteten Ogg-Stream;
// dessen zweites Paket ist der Vorbis-Kommentar mit ARTIST= und TITLE=.
class OggMetaParser {
  constructor(onComments) {
    this.buf = Buffer.alloc(0);
    this.streams = new Map(); // serial -> { packets, partial }
    this.onComments = onComments;
  }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const start = this.buf.indexOf('OggS');
      if (start < 0) { this.buf = this.buf.subarray(Math.max(0, this.buf.length - 3)); return; }
      if (start > 0) this.buf = this.buf.subarray(start);
      if (this.buf.length < 27) return;
      const nseg = this.buf[26];
      if (this.buf.length < 27 + nseg) return;
      const lacing = this.buf.subarray(27, 27 + nseg);
      const bodyLen = lacing.reduce((a, b) => a + b, 0);
      const total = 27 + nseg + bodyLen;
      if (this.buf.length < total) return;
      this.page(this.buf[5], this.buf.readUInt32LE(14), lacing, this.buf.subarray(27 + nseg, total));
      this.buf = this.buf.subarray(total);
    }
  }
  page(flags, serial, lacing, body) {
    if (flags & 0x02 || !this.streams.has(serial)) {
      this.streams.set(serial, { packets: 0, partial: [] });
      if (this.streams.size > 8) this.streams.delete(this.streams.keys().next().value);
    }
    const s = this.streams.get(serial);
    if (s.packets >= 2) return; // Audiodaten interessieren uns nicht
    let off = 0;
    for (const len of lacing) {
      s.partial.push(body.subarray(off, off + len));
      off += len;
      if (len < 255) {
        const pkt = Buffer.concat(s.partial);
        s.partial = [];
        s.packets++;
        if (pkt[0] === 3 && pkt.subarray(1, 7).toString() === 'vorbis') this.comments(pkt);
        if (s.packets >= 2) return;
      }
    }
  }
  comments(pkt) {
    try {
      let o = 7;
      const vlen = pkt.readUInt32LE(o); o += 4 + vlen;
      const n = pkt.readUInt32LE(o); o += 4;
      const tags = {};
      for (let i = 0; i < n && o < pkt.length; i++) {
        const len = pkt.readUInt32LE(o); o += 4;
        const str = pkt.subarray(o, o + len).toString('utf8'); o += len;
        const eq = str.indexOf('=');
        if (eq > 0) tags[str.slice(0, eq).toUpperCase()] = str.slice(eq + 1);
      }
      this.onComments(tags);
    } catch (e) { log('Kommentar nicht lesbar:', e.message); }
  }
}

// ---------------------------------------------------------------- Fake-Icecast für Traktor
const ingest = net.createServer((sock) => {
  let head = Buffer.alloc(0);
  let parser = null;
  sock.on('data', (chunk) => {
    if (parser) return parser.push(chunk);
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf('\r\n\r\n');
    if (end < 0) { if (head.length > 16384) sock.destroy(); return; }
    const reqLine = head.subarray(0, head.indexOf('\r\n')).toString();
    const rest = head.subarray(end + 4);
    if (!/^(SOURCE|PUT) /i.test(reqLine)) {
      sock.end('HTTP/1.0 400 Bad Request\r\n\r\n');
      return;
    }
    sock.write('HTTP/1.0 200 OK\r\nServer: Icecast 2.4.4\r\nConnection: close\r\n\r\n');
    traktorConnected = true;
    log('Traktor verbunden —', reqLine.split(' ').slice(0, 2).join(' '));
    publish();
    parser = new OggMetaParser((tags) => {
      setTrack({ artist: tags.ARTIST, title: tags.TITLE }).catch(() => {});
    });
    if (rest.length) parser.push(rest);
  });
  const bye = () => {
    if (!parser) return;
    parser = null;
    traktorConnected = false;
    log('Traktor-Broadcast beendet');
    publish();
  };
  sock.on('close', bye);
  sock.on('error', bye);
});
ingest.on('error', (e) => {
  log(`Port ${config.ingestPort} nicht verfügbar (${e.code}). Läuft noch ein anderes Programm, das Traktors Broadcast empfängt?`);
  process.exit(1);
});

// ---------------------------------------------------------------- Webserver für OBS
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

const web = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`retry: 2000\ndata: ${JSON.stringify(publicState())}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }
  if (p === '/api/info') { // für die Einstellungsseite: unter welchen Adressen ist dieser PC erreichbar
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ hostname: lanHostname(), addresses: lanAddresses(), webPort: config.webPort }));
  }
  if (p === '/api/now') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(publicState()));
  }
  if (p === '/api/test') { // Testtrack setzen, ohne Traktor
    setTrack({ artist: url.searchParams.get('artist') || '', title: url.searchParams.get('title') || '' }, 'test');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true}');
  }
  if (p.startsWith('/cover/')) {
    const c = covers.get(p.slice(7));
    if (!c) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': c.mime, 'Cache-Control': 'max-age=86400' });
    return res.end(c.data);
  }

  const file = p === '/' ? 'index.html' : p === '/overlay' ? 'overlay.html' : p.slice(1);
  const full = path.join(PUBLIC, path.normalize(file));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Nicht gefunden'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});
web.on('error', (e) => {
  log(`Port ${config.webPort} nicht verfügbar (${e.code}). Ändere "webPort" in config.json.`);
  process.exit(1);
});

ingest.listen(config.ingestPort, () => {
  web.listen(config.webPort, () => {
    console.log('');
    console.log('  TrackCaster läuft');
    console.log(`  Traktor Broadcasting → localhost : ${config.ingestPort}`);
    console.log(`  Einrichtung & Vorschau → http://localhost:${config.webPort}/`);
    console.log(`  OBS-Browserquelle     → http://localhost:${config.webPort}/overlay`);
    const lan = lanAddresses();
    if (lan.length) {
      console.log('');
      console.log('  OBS auf einem anderen PC (Stream-PC):');
      for (const ip of lan) console.log(`    http://${ip}:${config.webPort}/overlay`);
      console.log(`    http://${lanHostname()}:${config.webPort}/overlay`);
    }
    console.log('');
    try { if (!loadCollection()) log('Keine collection.nml gefunden – Cover nur aus dem Online-Fallback.'); }
    catch (e) { log('Collection-Fehler:', e.message); }
  });
});
