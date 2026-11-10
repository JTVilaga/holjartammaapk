// A VERZIO sort a JT AppKreator szúrta be; az app-update.bat ezt emeli.
const VERZIO = '1.14';

// Hol jártam ma – útnapló és km-óra ellenőrzés GPS alapján (Android-app, a JT AppKreatorral készül).
// - hely: az APK-ban a Háttérben követés bővítmény (@capacitor-community/background-geolocation): zárt képernyőnél
//   és másik appnál is ad helyet, közben „követés fut” értesítés látszik. Ha nincs bővítmény (pl. böngészőben):
//   navigator.geolocation.watchPosition, és a képernyő ébren tartása (Screen Wake Lock).
// - térkép: Leaflet (lib/leaflet) és az OpenStreetMap térképe (ehhez internet kell). Alapból „zárt”: az ujj a lapot
//   görgeti; koppintásra mozgatható.
// - tárolás: IndexedDB „holjartam” – pontok (nap és szakasz szerint), szünetek (az app a háttérben volt),
//   utak (szakaszonként: név, km-óra állás, összesített km, idő, mozgásidő, legnagyobb sebesség).
// - km-óra összevetés: egy szakasznál a km-óra induló és érkező állása, és az eltérés a GPS-hez képest.
// - vízszintes kijelző: ha a telefont oldalra fordítod (pl. autós tartóban), fekete háttéren nagy betűkkel
//   a pontos idő és a sebesség. Az elforgatást a képernyő tájolásából (ha be van kapcsolva az automatikus
//   elforgatás), különben a gyorsulásmérőből (devicemotion: a gravitáció iránya) ismeri fel.
// - kimentés: GPX (térképes appokhoz), megosztás, és biztonsági mentés JSON-fájlba (visszatölthető).
//   Az APK-ban a Fájlmentés és a Megosztás bővítménnyel (Dokumentumok/HolJartam mappa).

const MIN_TAV = 10;          // méter: ennél kisebb elmozdulásnál nem jegyez új pontot
// (Ha a jel pontatlansága ennél nagyobb, az elmozdulásnak a pontatlanságot is el kell érnie, felső korlát 25 m.)
const MAX_PONTATLANSAG = 30; // méter: ennél pontatlanabb GPS-mérést eldob (pl. épületben)
const ALLO_SEB = 0.5;        // m/s: ha a GPS szerint ennél lassabb (áll), csak nagyobb elmozdulást fogad el
const MOZGO_SEB = 0.8;       // m/s (~3 km/h): két pont között ennél gyorsabban haladva az idő „mozgásidő”

const $ = id => document.getElementById(id);
const apkban = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const bovitmeny = nev => (apkban && window.Capacitor.Plugins && window.Capacitor.Plugins[nev]) || null;
const Filesystem = bovitmeny('Filesystem');
const Share = bovitmeny('Share');
const Hatter = bovitmeny('BackgroundGeolocation');
// A Capacitor saját (beépített) bővítménye: a rendszersávok (felső állapotsor, alsó navigációs sáv) elrejtése.
// (A sávok színezését álló helyzetben a JT AppKreator Teljes kijelző bővítménye végzi: jtak-teljes.js.)
const Rendszersav = bovitmeny('SystemBars');
const MAPPA = 'HolJartam';
const allapot = (szoveg, osztaly) => { $('allapot').textContent = szoveg; $('allapot').className = 'allapot' + (osztaly ? ' ' + osztaly : ''); };

// Előugró üzenet pár másodpercre (pl. a mentés eredménye).
let uzenetIdo = null;
function uzenet(szoveg, hiba) {
  const u = $('uzenet');
  u.textContent = szoveg;
  u.className = 'uzenet' + (hiba ? ' hiba' : '');
  u.hidden = false;
  clearTimeout(uzenetIdo);
  uzenetIdo = setTimeout(() => { u.hidden = true; }, hiba ? 6000 : 4000);
}

// ---- Segédek ----
const k2 = n => String(n).padStart(2, '0');
const napKulcs = t => { const d = new Date(t); return d.getFullYear() + '-' + k2(d.getMonth() + 1) + '-' + k2(d.getDate()); };
const ma = () => napKulcs(Date.now());
const tizedes = (x, n) => x.toFixed(n).replace('.', ',');
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Két pont távolsága méterben (haversine).
function tav(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dSz = (b.sz - a.sz) * r, dH = (b.h - a.h) * r;
  const x = Math.sin(dSz / 2) ** 2 + Math.cos(a.sz * r) * Math.cos(b.sz * r) * Math.sin(dH / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const idoSzoveg = ms => { const p = Math.round(ms / 60000); return p >= 60 ? Math.floor(p / 60) + ' ó ' + k2(p % 60) + ' p' : p + ' p'; };
const napNev = n => n === ma() ? 'Ma (' + n + ')' : n;
const oraPerc = t => new Date(t).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' });
const szamOlvas = v => { const x = parseFloat(String(v).replace(',', '.')); return isNaN(x) ? null : x; };
const sebKell = () => { try { return localStorage.getItem('holjartam-seb') === '1'; } catch (e) { return false; } };

// ---- Mértékegység: kilométer vagy mérföld (a Beállításokban; a tárolt adat mindig méter és m/s) ----
const MERFOLD = 1.609344;   // km
const merfold = () => { try { return localStorage.getItem('holjartam-egyseg') === 'mi'; } catch (e) { return false; } };
const tavJel = () => merfold() ? 'mi' : 'km';
const sebJel = () => merfold() ? 'mph' : 'km/h';
// Távolság (méterből) a választott egységben, n tizedessel, egység nélkül.
const tavSzam = (m, n) => tizedes(m / 1000 / (merfold() ? MERFOLD : 1), n);
const tavSzoveg = (m, n) => tavSzam(m, n) + ' ' + tavJel();
// Sebesség (km/h-ból) a választott egységben, kerekítve.
const sebSzam = kmh => Math.round(merfold() ? kmh / MERFOLD : kmh);
function egysegJelek() {
  $('eloKmJel').textContent = tavJel();
  document.querySelectorAll('.sebjel').forEach(e => { e.textContent = sebJel(); });
}

// ---- Tárolás (IndexedDB) ----
let dbIgeret = null;
function db() {
  return dbIgeret || (dbIgeret = new Promise((ok, hiba) => {
    const r = indexedDB.open('holjartam', 3);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const t of ['pontok', 'szunetek']) {
        if (!d.objectStoreNames.contains(t)) d.createObjectStore(t, { keyPath: 'id', autoIncrement: true }).createIndex('nap', 'nap');
      }
      const pt = r.transaction.objectStore('pontok');
      if (!pt.indexNames.contains('szakasz')) pt.createIndex('szakasz', 'szakasz');
      if (!d.objectStoreNames.contains('utak')) d.createObjectStore('utak', { keyPath: 'szakasz' }).createIndex('nap', 'nap');
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => hiba(r.error);
  }));
}
async function tar(mod, fv, tabla = 'pontok') {
  const d = await db();
  return new Promise((ok, hiba) => {
    const t = d.transaction(tabla, mod);
    const k = fv(t.objectStore(tabla));
    t.oncomplete = () => ok(k && k.result);
    t.onerror = () => hiba(t.error);
  });
}
const pontMent = p => tar('readwrite', s => s.add(p));
const napPontjai = n => tar('readonly', s => s.index('nap').getAll(n));
const szakaszPontjai = id => tar('readonly', s => s.index('szakasz').getAll(id));
const szunetMent = sz => tar('readwrite', s => s.add(sz), 'szunetek');
const napSzunetei = n => tar('readonly', s => s.index('nap').getAll(n), 'szunetek');
const utOlvas = id => tar('readonly', s => s.get(id), 'utak');
const utIr = u => tar('readwrite', s => s.put(u), 'utak');
const osszesUt = () => tar('readonly', s => s.getAll(), 'utak');
const mindet = tabla => tar('readonly', s => s.getAll(), tabla);
async function napok() {
  const d = await db();
  return new Promise((ok, hiba) => {
    const l = [];
    const r = d.transaction('pontok').objectStore('pontok').index('nap').openKeyCursor(null, 'prevunique');
    r.onsuccess = () => { const c = r.result; if (c) { l.push(c.key); c.continue(); } else ok(l); };
    r.onerror = () => hiba(r.error);
  });
}
// Törlés egy index értéke szerint (pl. egy nap vagy egy szakasz minden pontja).
const indexTorol = (tabla, index, ertek) => tar('readwrite', s => {
  const r = s.index(index).openKeyCursor(IDBKeyRange.only(ertek));
  r.onsuccess = () => { const c = r.result; if (c) { s.delete(c.primaryKey); c.continue(); } };
}, tabla);
async function napTorol(n) {
  await indexTorol('pontok', 'nap', n);
  await indexTorol('szunetek', 'nap', n);
  await indexTorol('utak', 'nap', n);
}
async function szakaszTorol(id) {
  await indexTorol('pontok', 'szakasz', id);
  await tar('readwrite', s => {
    const r = s.openCursor();
    r.onsuccess = () => { const c = r.result; if (c) { if (c.value.szakasz === id) c.delete(); c.continue(); } };
  }, 'szunetek');
  await tar('readwrite', s => s.delete(id), 'utak');
}
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persisted().then(van => van || navigator.storage.persist()).catch(() => {});
}

// ---- Számítások ----
// Szakaszokra bontás: egy indítás–leállítás egy szakasz (a vonal nem köti össze a kettőt).
function szakaszok(pontok) {
  const m = new Map();
  pontok.sort((a, b) => a.ido - b.ido).forEach(p => { if (!m.has(p.szakasz)) m.set(p.szakasz, []); m.get(p.szakasz).push(p); });
  return [...m.values()];
}
// Egy szünet alatt jött pontok száma (ha 0: a telefon a háttérben nem adott helyet).
// (A visszatéréskor azonnal érkező jelet – az utolsó 3 másodperc – nem számolja a szünetbe.)
const szunetPontjai = (sz, pontok) => pontok.filter(p => p.ido >= sz.tol && p.ido < sz.ig - 3000).length;
// Két egymás utáni pont között volt-e helyadat nélküli szünet.
const urese = (a, b, uresek) => uresek.some(sz => a.ido < sz.ig && b.ido > sz.tol);
// Egy szakasz darabjai: folytonos (mért) és szaggatott (szünet, a két végpont egyenes vonallal összekötve).
function darabok(sz, uresek) {
  const l = [];
  for (let i = 1; i < sz.length; i++) {
    const szagg = urese(sz[i - 1], sz[i], uresek);
    const u = l[l.length - 1];
    if (u && u.szagg === szagg) u.pontok.push(sz[i]);
    else l.push({ szagg, pontok: [sz[i - 1], sz[i]] });
  }
  if (!l.length && sz.length) l.push({ szagg: false, pontok: [sz[0]] });
  return l;
}
// Összesítés: méter, idő (első–utolsó pont), mozgásidő, legnagyobb sebesség (km/h; a GPS által mért sebességből).
function osszesit(pontok) {
  let m = 0, ido = 0, mozgo = 0, maxSeb = 0;
  for (const sz of szakaszok(pontok)) {
    for (let i = 1; i < sz.length; i++) {
      const d = tav(sz[i - 1], sz[i]), dt = (sz[i].ido - sz[i - 1].ido) / 1000;
      m += d;
      if (dt > 0 && d / dt >= MOZGO_SEB) mozgo += dt * 1000;
    }
    if (sz.length > 1) ido += sz[sz.length - 1].ido - sz[0].ido;
    for (const p of sz) if (p.seb != null && p.seb * 3.6 > maxSeb) maxSeb = p.seb * 3.6;
  }
  return { m, ido, mozgo, maxSeb, db: pontok.length };
}
// Az óra-összevetés szövege egy úthoz (ha van óraállás). Az autó órájának egységében (u.oraEgyseg: km vagy mi;
// régebbi adatnál km), a GPS-távolságot is abba átszámolva.
function osszevetes(u, gpsKm) {
  if (u.kmVege == null || !(gpsKm > 0)) return '';
  const ora = u.kmVege - (u.kmEleje || 0);
  if (!(ora > 0)) return '';
  const mi = u.oraEgyseg === 'mi', jel = mi ? 'mi' : 'km';
  const gps = mi ? gpsKm / MERFOLD : gpsKm;
  const elt = (ora / gps - 1) * 100;
  return 'óra: ' + tizedes(ora, 1) + ' ' + jel + ' · GPS: ' + tizedes(gps, 2) + ' ' + jel + ' · az óra '
    + (Math.abs(elt) < 0.05 ? 'pontosan annyit mér' : (elt > 0 ? '+' : '') + tizedes(elt, 1) + '%-kal ' + (elt > 0 ? 'többet' : 'kevesebbet') + ' mér');
}

// ---- Utak (szakaszonkénti összesítő) ----
// Egy szakasz összesítőjének frissítése a pontjaiból (a név és a km-óra adat megmarad).
async function utFrissit(id) {
  const pontok = await szakaszPontjai(id);
  const regi = (await utOlvas(id)) || { szakasz: id };
  if (!pontok.length) { if (regi.nap) await utIr(regi); return regi; }
  pontok.sort((a, b) => a.ido - b.ido);
  const o = osszesit(pontok.slice());
  const u = Object.assign(regi, { nap: pontok[0].nap, tol: pontok[0].ido, ig: pontok[pontok.length - 1].ido, m: o.m, ido: o.ido, mozgo: o.mozgo, maxSeb: o.maxSeb });
  await utIr(u);
  return u;
}
// Induláskor: azoknak a szakaszoknak, amiknek még nincs összesítője (régebbi adatok), elkészíti.
async function utakPotol() {
  const d = await db();
  const kulcsok = await new Promise((ok, hiba) => {
    const l = [];
    const r = d.transaction('pontok').objectStore('pontok').index('szakasz').openKeyCursor(null, 'nextunique');
    r.onsuccess = () => { const c = r.result; if (c) { l.push(c.key); c.continue(); } else ok(l); };
    r.onerror = () => hiba(r.error);
  });
  const van = new Set((await osszesUt()).filter(u => u.m != null).map(u => u.szakasz));
  for (const k of kulcsok) if (!van.has(k) && !(kovetes && k === szakaszId)) await utFrissit(k);
}

// ---- Térkép ----
const terkep = L.map('terkep').setView([47.16, 19.5], 7);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(terkep);
const utRetek = L.layerGroup().addTo(terkep);
// A térkép alapból „zárt”: az ujj a lapot görgeti. Koppintásra mozgatható; a Kész gomb vagy fél perc tétlenség újra zárja.
const TERKEP_KEZELOK = ['dragging', 'touchZoom', 'doubleClickZoom', 'scrollWheelZoom', 'boxZoom', 'keyboard'];
let terkepIdo = null;
function terkepZar(zarva) {
  TERKEP_KEZELOK.forEach(k => terkep[k] && (zarva ? terkep[k].disable() : terkep[k].enable()));
  $('terkepZar').hidden = !zarva;
  $('terkepKesz').hidden = zarva;
  clearTimeout(terkepIdo);
  if (!zarva) terkepIdo = setTimeout(() => terkepZar(true), 30000);
}
$('terkepZar').addEventListener('click', e => {
  terkepZar(false);
  // A zárt térképre koppintás is megmutatja a hely címét (billentyűs „kattintásnál” nincs érintési pont).
  if (e.clientX || e.clientY) cimKeres(terkep.mouseEventToLatLng(e));
});
$('terkepKesz').addEventListener('click', () => terkepZar(true));
// Mozgatás közben a fél perc újraindul (csak a felhasználó érintése számít, a program általi mozgatás nem).
['pointerdown', 'wheel'].forEach(e => $('terkep').addEventListener(e, () => { if ($('terkepZar').hidden) terkepZar(false); }, { passive: true }));
terkepZar(true);
let itt = null;          // a mostani hely jele
let elozoVonal = null;   // a futó szakasz vonala (élő rajzoláshoz)

// ---- Cím a térképre koppintva (fordított címkeresés: OpenStreetMap Nominatim, internet kell) ----
// A koppintott pontnál felugró buborék: utca, házszám, település, megye, ország – amilyen pontosan ismert.
// Ha a látott útvonal 150 m-en belül van, azt is kiírja, mikor jártál ott.
// A Nominatim legfeljebb 1 kérést enged másodpercenként: a kéréseket ennek megfelelően ritkítjuk, és a
// már lekérdezett pontokat megjegyezzük (a memóriában, az app bezárásáig).
const CIM_CIM = 'https://nominatim.openstreetmap.org/reverse';
const cimTar = new Map();          // kerekített koordináta → cím (HTML)
let cimBuborek = null;             // a térképen nyitott buborék
let cimKeres_utolso = 0;           // az előző kérés ideje (ms)
let cimKeres_szam = 0;             // a legutóbbi koppintás sorszáma (a régebbi válasz ne írja felül az újat)
let cimKattIdo = null;             // dupla koppintás (nagyítás) kiszűrése

// A címadatokból olvasható, magyar sorrendű szöveg (HTML).
function cimSzoveg(adat) {
  const a = adat.address || {};
  const telep = a.city || a.town || a.village || a.municipality || a.hamlet || '';
  const resz = [a.city_district, a.suburb, a.quarter, a.neighbourhood].find(x => x && x !== telep) || '';
  const utca = a.road || a.pedestrian || a.footway || a.cycleway || a.path || a.track || '';
  const sorok = [];
  if (adat.name && adat.name !== utca) sorok.push('<b>' + esc(adat.name) + '</b>');
  if (utca) sorok.push((sorok.length ? '' : '<b>') + esc(utca + (a.house_number ? ' ' + a.house_number + '.' : '')) + (sorok.length ? '' : '</b>'));
  const varos = [a.postcode, telep].filter(Boolean).join(' ') + (resz ? ', ' + resz : '');
  if (varos.trim()) sorok.push((sorok.length ? '' : '<b>') + esc(varos) + (sorok.length ? '' : '</b>'));
  const tag = [a.county, a.state, a.country].filter(Boolean).filter((x, i, l) => l.indexOf(x) === i).join(', ');
  if (tag) sorok.push('<span class="cim-kicsi">' + esc(tag) + '</span>');
  if (!sorok.length && adat.display_name) sorok.push(esc(adat.display_name));
  return sorok.join('<br>');
}

// A látott útvonal legközelebbi pontja a koppintáshoz: mikor jártál ott (ha 150 m-en belül van).
function cimItJartal(ll) {
  let legjobb = null, legkisebb = Infinity;
  const hol = { sz: ll.lat, h: ll.lng };
  for (const p of napiPontok) {
    const d = tav(hol, p);
    if (d < legkisebb) { legkisebb = d; legjobb = p; }
  }
  if (!legjobb || legkisebb > 150) return '';
  return '<div class="cim-ido">🕒 Itt jártál: <b>' + oraPerc(legjobb.ido) + '</b> (kb. ' + Math.round(legkisebb) + ' m-re a vonaltól)</div>';
}

// A buborék kiírása a koppintott pontnál.
function cimBuborekKiir(ll, belso) {
  const html = '<div class="cim-buborek">' + belso + cimItJartal(ll)
    + '<div class="cim-kicsi">' + tizedes(ll.lat, 5) + '; ' + tizedes(ll.lng, 5) + '</div></div>';
  if (!cimBuborek) cimBuborek = L.popup({ maxWidth: 260, autoPanPadding: [20, 20] });
  cimBuborek.setLatLng(ll).setContent(html);
  if (!terkep.hasLayer(cimBuborek)) cimBuborek.openOn(terkep);
}

// Címkeresés egy pontra.
async function cimKeres(ll) {
  const sorszam = ++cimKeres_szam;
  const kulcs = ll.lat.toFixed(5) + ',' + ll.lng.toFixed(5);
  if (cimTar.has(kulcs)) { cimBuborekKiir(ll, cimTar.get(kulcs)); return; }
  if (!navigator.onLine) { cimBuborekKiir(ll, '<i>A cím kereséséhez internet kell.</i>'); return; }
  cimBuborekKiir(ll, '<i>Cím keresése…</i>');
  // Legalább 1,1 másodperc a két kérés között (a Nominatim szabálya).
  const varni = cimKeres_utolso + 1100 - Date.now();
  if (varni > 0) await new Promise(k => setTimeout(k, varni));
  if (sorszam !== cimKeres_szam) return;          // közben újabb koppintás jött: az számít
  cimKeres_utolso = Date.now();
  const cim = CIM_CIM + '?format=jsonv2&addressdetails=1&zoom=18&accept-language=hu'
    + '&lat=' + ll.lat.toFixed(6) + '&lon=' + ll.lng.toFixed(6);
  let belso;
  try {
    const valasz = await fetch(cim, { headers: { 'Accept': 'application/json' } });
    if (!valasz.ok) throw new Error('HTTP ' + valasz.status);
    const adat = await valasz.json();
    if (adat.error) belso = '<i>Itt nem található cím (pl. vízen vagy lakatlan helyen).</i>';
    else {
      belso = cimSzoveg(adat) || '<i>Ehhez a ponthoz nincs részletes cím.</i>';
      cimTar.set(kulcs, belso);
    }
  } catch (e) {
    belso = '<i>A címet most nem sikerült lekérni (' + esc(e.message || 'hálózati hiba') + '). Van internet?</i>';
  }
  if (sorszam === cimKeres_szam && cimBuborek && terkep.hasLayer(cimBuborek)) cimBuborekKiir(ll, belso);
}

// Koppintás a (mozgatható) térképre: kicsit várunk, hogy a dupla koppintás (nagyítás) ne keressen címet.
terkep.on('click', e => {
  clearTimeout(cimKattIdo);
  cimKattIdo = setTimeout(() => cimKeres(e.latlng), 300);
});
terkep.on('dblclick', () => clearTimeout(cimKattIdo));

// ---- A látott nap / szakasz ----
let latottNap = ma();
let latottSzakasz = null;    // null: a nap összes szakasza; különben egy szakasz azonosítója (az indítás ideje)
let napiPontok = [];         // a látott pontok (a nap, vagy a kiválasztott szakasz)
let napiSzunetek = [];
let napiUtak = new Map();    // a nap útjai (név, km-óra) szakasz szerint

// A szünetek egy görgethető dobozban (sok is lehet belőlük).
function szunetKiir() {
  const d = $('szunetek');
  d.hidden = !napiSzunetek.length;
  d.innerHTML = '<div class="fej">⏸ Háttérben – zárt képernyő vagy másik app (' + napiSzunetek.length + ')</div>'
    + napiSzunetek.slice().sort((a, b) => a.tol - b.tol).map(sz => {
      const n = szunetPontjai(sz, napiPontok);
      return '<div><b>' + oraPerc(sz.tol) + '–' + oraPerc(sz.ig) + '</b> – ' + (n ? n + ' pont jött közben' : 'nem jött helyadat') + '</div>';
    }).join('');
}
function osszesitoKiir(o) {
  szunetKiir();
  if (!o.db) { utPanelKiir(0); $('osszesito').textContent = latottSzakasz !== null ? 'Ebben a szakaszban még nincs pont.' : 'Ezen a napon még nincs pont.'; return; }
  const km = o.m / 1000;
  const egy = merfold() ? MERFOLD : 1;
  let t = tavSzoveg(o.m, 2) + ' · ' + idoSzoveg(o.ido);
  if (sebKell()) {
    t += ' · mozgásban ' + idoSzoveg(o.mozgo);
    if (o.mozgo > 60000) t += ' · mozgási átlag ' + tizedes(km / egy / (o.mozgo / 3600000), 1) + ' ' + sebJel();
    if (o.maxSeb > 0) t += ' · max. ' + sebSzam(o.maxSeb) + ' ' + sebJel();
  } else if (o.ido > 60000) t += ' · átlag ' + tizedes(km / egy / (o.ido / 3600000), 1) + ' ' + sebJel();
  $('osszesito').textContent = t + ' · ' + o.db + ' pont';
  utPanelKiir(km);
}
// A Szakasz választó: „Mind”, és minden indítás–leállítás az idejével, nevével és a hosszával.
function szakaszListaz(minden) {
  const l = szakaszok(minden);
  const kovetett = kovetes && latottSzakasz === szakaszId;
  if (latottSzakasz !== null && !kovetett && !l.some(sz => sz[0].szakasz === latottSzakasz)) latottSzakasz = null;
  let opciok = l.map(sz => {
    const o = osszesit(sz.slice()), u = napiUtak.get(sz[0].szakasz);
    return '<option value="' + sz[0].szakasz + '"' + (sz[0].szakasz === latottSzakasz ? ' selected' : '') + '>'
      + oraPerc(sz[0].ido) + '–' + oraPerc(sz[sz.length - 1].ido) + (u && u.nev ? ' · ' + esc(u.nev) : '') + ' · ' + tavSzoveg(o.m, 2) + '</option>';
  });
  if (kovetett && !l.some(sz => sz[0].szakasz === szakaszId)) opciok.push('<option value="' + szakaszId + '" selected>' + oraPerc(szakaszId) + '– (most) · 0,00 ' + tavJel() + '</option>');
  $('szakaszValaszto').innerHTML = '<option value="">Mind (' + l.length + ')</option>' + opciok.join('');
}
async function napRajzol(illeszt) {
  const minden = await napPontjai(latottNap);
  napiUtak = new Map((await tar('readonly', s => s.index('nap').getAll(latottNap), 'utak')).map(u => [u.szakasz, u]));
  szakaszListaz(minden);
  napiPontok = latottSzakasz === null ? minden : minden.filter(p => p.szakasz === latottSzakasz);
  napiSzunetek = (await napSzunetei(latottNap)).filter(sz => latottSzakasz === null || sz.szakasz === latottSzakasz);
  const uresek = napiSzunetek.filter(sz => !szunetPontjai(sz, napiPontok));
  utRetek.clearLayers();
  elozoVonal = null;
  const latszik = [];
  for (const sz of szakaszok(napiPontok)) {
    const ll = sz.map(p => [p.sz, p.h]);
    latszik.push(...ll);
    let v = null;
    for (const d of darabok(sz, uresek)) {
      v = L.polyline(d.pontok.map(p => [p.sz, p.h]), d.szagg
        ? { color: '#7a8796', weight: 4, opacity: .9, dashArray: '8 8' }
        : { color: '#1f6f43', weight: 5, opacity: .85 }).addTo(utRetek);
      if (d.szagg) v.bindTooltip('Szünet: ' + oraPerc(d.pontok[0].ido) + '–' + oraPerc(d.pontok[d.pontok.length - 1].ido) + ', nem jött helyadat');
      else v.szakaszVege = true;
    }
    if (v && !v.szakaszVege) v = null;    // szaggatott a vége: a következő pont újrarajzol
    L.circleMarker(ll[0], { radius: 6, color: '#fff', weight: 2, fillColor: '#2e7d32', fillOpacity: 1 }).bindTooltip('Indulás ' + new Date(sz[0].ido).toLocaleTimeString('hu-HU')).addTo(utRetek);
    if (ll.length > 1) L.circleMarker(ll[ll.length - 1], { radius: 6, color: '#fff', weight: 2, fillColor: '#c62828', fillOpacity: 1 }).bindTooltip('Vége ' + new Date(sz[sz.length - 1].ido).toLocaleTimeString('hu-HU')).addTo(utRetek);
    if (kovetes && sz[0].szakasz === szakaszId) elozoVonal = v;
  }
  if (illeszt && latszik.length) terkep.fitBounds(latszik, { padding: [30, 30], maxZoom: 17 });
  $('torles').textContent = latottSzakasz !== null ? 'Szakasz törlése' : 'Nap törlése';
  osszesitoKiir(osszesit(napiPontok));
}
async function napListaz() {
  const l = await napok();
  if (!l.includes(ma())) l.unshift(ma());
  if (!l.includes(latottNap)) l.push(latottNap);
  l.sort().reverse();
  $('napValaszto').innerHTML = l.map(n => '<option value="' + n + '"' + (n === latottNap ? ' selected' : '') + '>' + napNev(n) + '</option>').join('');
}
$('napValaszto').addEventListener('change', () => { latottNap = $('napValaszto').value; latottSzakasz = null; napRajzol(true); });
$('szakaszValaszto').addEventListener('change', () => {
  latottSzakasz = $('szakaszValaszto').value ? Number($('szakaszValaszto').value) : null;
  napRajzol(true);
});
// Egy nap és szakasz megmutatása (pl. az utak listájából).
async function mutat(nap, szakasz) {
  latottNap = nap;
  latottSzakasz = szakasz;
  await napListaz();
  await napRajzol(true);
  $('terkep').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---- Szakasz adatai: név, km-óra összevetés ----
let panelSzakasz = null;
function utPanelKiir(gpsKm) {
  const p = $('utPanel');
  p.hidden = latottSzakasz === null;
  if (p.hidden) { panelSzakasz = null; return; }
  const u = napiUtak.get(latottSzakasz) || {};
  if (panelSzakasz !== latottSzakasz) {        // csak szakaszváltáskor töltjük ki (gépelés közben ne írja felül)
    panelSzakasz = latottSzakasz;
    $('utNev').value = u.nev || '';
    $('utKmEleje').value = u.kmEleje != null ? u.kmEleje : '';
    $('utKmVege').value = u.kmVege != null ? u.kmVege : '';
    $('utOraEgyseg').value = u.oraEgyseg || (merfold() ? 'mi' : 'km');
  }
  $('utOsszevetes').textContent = osszevetes(u, gpsKm);
}
$('utMentes').addEventListener('click', async () => {
  if (latottSzakasz === null) return;
  const id = latottSzakasz;
  const u = (await utOlvas(id)) || { szakasz: id, nap: latottNap };
  u.nev = $('utNev').value.trim();
  u.kmEleje = szamOlvas($('utKmEleje').value);
  u.kmVege = szamOlvas($('utKmVege').value);
  u.oraEgyseg = $('utOraEgyseg').value;
  if (u.kmEleje != null && u.kmVege != null && u.kmVege < u.kmEleje) { uzenet('Az érkezéskori km-óra állás kisebb, mint az induláskori.', true); return; }
  await utIr(u);
  napiUtak.set(id, u);
  const km = osszesit(napiPontok.slice()).m / 1000;
  utPanelKiir(km);
  szakaszListaz(await napPontjai(latottNap));
  uzenet('✓ Szakasz adatai elmentve' + (osszevetes(u, km) ? ': ' + osszevetes(u, km) : '.'));
  if ($('utLista').open) utListaKiir();
});

// ---- Utak listája (havonta) ----
const HONAPOK = ['január', 'február', 'március', 'április', 'május', 'június', 'július', 'augusztus', 'szeptember', 'október', 'november', 'december'];
async function utListaKiir() {
  const utak = (await osszesUt()).filter(u => u.m != null && u.nap).sort((a, b) => b.szakasz - a.szakasz);
  if (!utak.length) { $('utListaTartalom').innerHTML = '<p class="kicsi">Még nincs rögzített út.</p>'; return; }
  const honapok = new Map();
  utak.forEach(u => { const k = u.nap.slice(0, 7); if (!honapok.has(k)) honapok.set(k, []); honapok.get(k).push(u); });
  let h = '';
  for (const [k, l] of honapok) {
    const ossz = l.reduce((s, u) => s + u.m, 0) / 1000;
    h += '<h3>' + k.slice(0, 4) + '. ' + HONAPOK[Number(k.slice(5, 7)) - 1] + ' – ' + tavSzoveg(ossz * 1000, 1) + ' <span class="kicsi">(' + l.length + ' út)</span></h3>';
    h += l.map(u => {
      const o = osszevetes(u, u.m / 1000);
      return '<button type="button" class="ut-sor" data-nap="' + u.nap + '" data-szakasz="' + u.szakasz + '">'
        + '<span>' + u.nap.slice(5).replace('-', '.') + '. ' + oraPerc(u.tol) + '–' + oraPerc(u.ig) + (u.nev ? ' · <b>' + esc(u.nev) + '</b>' : '') + '</span>'
        + '<span class="ut-km">' + tavSzoveg(u.m, 2) + '</span>'
        + (o ? '<span class="ut-ora">' + esc(o) + '</span>' : '') + '</button>';
    }).join('');
  }
  $('utListaTartalom').innerHTML = h;
}
$('utLista').addEventListener('toggle', () => { if ($('utLista').open) utListaKiir(); });
$('utListaTartalom').addEventListener('click', e => {
  const b = e.target.closest('.ut-sor');
  if (b) mutat(b.dataset.nap, Number(b.dataset.szakasz));
});

// ---- Képernyő ébren tartása (Screen Wake Lock; csak ha nincs Háttérben követés) ----
let ebrenZar = null;
async function ebrenTart() {
  if (Hatter || !('wakeLock' in navigator)) { ebrenKiir(); return; }
  try {
    ebrenZar = await navigator.wakeLock.request('screen');
    ebrenZar.addEventListener('release', () => { ebrenZar = null; ebrenKiir(); });
  } catch (e) { ebrenZar = null; }
  ebrenKiir();
}
function ebrenKiir() {
  if (!kovetes) { $('ebren').textContent = ''; return; }
  $('ebren').textContent = Hatter
    ? '📍 Háttérben követés: a képernyő lezárható, másik appra is válthatsz. Az értesítési panelen látszik, hogy fut.'
    : ebrenZar
    ? '🔆 A képernyő ébren marad, amíg a követés fut.'
    : '⚠️ A képernyő ébren tartása itt nem megy: a kijelző időkorlátja (Beállítások → Kijelző) legyen hosszú, vagy érintsd meg időnként a képernyőt.';
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && kovetes && !ebrenZar) ebrenTart();
});

// ---- Szünetek: az app a háttérben (zárt képernyő, másik app) ----
let rejtveTol = null;
document.addEventListener('visibilitychange', () => {
  if (!kovetes) { rejtveTol = null; return; }
  if (document.visibilityState === 'hidden') { rejtveTol = Date.now(); return; }
  if (rejtveTol === null) return;
  const sz = { tol: rejtveTol, ig: Date.now(), szakasz: szakaszId };
  rejtveTol = null;
  if (sz.ig - sz.tol < 5000) return;     // egy pillanatnyi váltás nem számít
  sz.nap = napKulcs(sz.tol);
  kovetoIgeret = kovetoIgeret.then(async () => {
    await szunetMent(sz);
    const n = szunetPontjai(sz, await napPontjai(sz.nap));
    if (sz.nap === latottNap) await napRajzol(false);
    elozoVonal = null;                    // a következő pont újrarajzol (a szünet szaggatott része miatt)
    allapot('⏸ ' + oraPerc(sz.tol) + '–' + oraPerc(sz.ig) + ' között az app a háttérben volt. '
      + (n ? 'Közben ' + n + ' pont jött: a követés a háttérben is ment.' : 'Közben nem jött helyadat; a térképen ez a rész szaggatott.'), 'fut');
  }).catch(e => allapot('A szünet mentése nem sikerült: ' + e.message, 'hiba'));
});

// ---- Élő kijelző ----
let eloM = 0, eloMax = 0;
function eloKiir(sebMs) {
  $('elo').hidden = !kovetes;
  $('eloKm').textContent = tavSzam(eloM, 2);
  $('eloSebDoboz').hidden = !sebKell();
  if (sebMs != null && sebMs >= 0) {
    const kmh = sebMs * 3.6;
    $('eloSeb').textContent = sebSzam(kmh);
    if (kmh > eloMax) eloMax = kmh;
  }
  $('eloMax').textContent = eloMax ? sebSzam(eloMax) : '–';
}

// ---- Követés ----
let kovetes = null;      // a watchPosition azonosítója, vagy 'hatter'
let szakaszId = 0;
let utolso = null;       // az utolsó elmentett pont (a távolság-szűréshez)
let kovetoIgeret = Promise.resolve();

function helyJott(p) {
  const pont = { sz: p.coords.latitude, h: p.coords.longitude, pont: p.coords.accuracy, mag: p.coords.altitude,
    seb: p.coords.speed != null && !isNaN(p.coords.speed) ? p.coords.speed : null, ido: p.timestamp || Date.now() };
  $('gps').textContent = 'GPS: ±' + Math.round(pont.pont) + ' m · ' + new Date(pont.ido).toLocaleTimeString('hu-HU');
  if ($('allapot').classList.contains('hiba')) allapot('Követés fut – a jel újra megvan.', 'fut');
  if (!itt) itt = L.circleMarker([pont.sz, pont.h], { radius: 8, color: '#fff', weight: 3, fillColor: '#1565c0', fillOpacity: 1 }).addTo(terkep);
  else itt.setLatLng([pont.sz, pont.h]);
  if (pont.pont > MAX_PONTATLANSAG) { allapot('Követés fut – gyenge GPS-jel (±' + Math.round(pont.pont) + ' m), várok a pontosabbra…', 'fut'); return; }
  eloKiir(pont.seb);
  if (pont.seb != null) { vzSeb = pont.seb; vzSebIdo = Date.now(); }
  if (utolso) {
    const d = tav(utolso, pont);
    if (d < Math.max(MIN_TAV, Math.min(pont.pont, 25))) return;
    // Álló helyzetben (a GPS szerint) a jel ugrálása ne adjon „fantom” métereket.
    if (pont.seb != null && pont.seb < ALLO_SEB && d < Math.max(2 * MIN_TAV, 2 * pont.pont)) return;
    eloM += d;
  }
  const elso = !utolso;
  utolso = pont;
  pont.nap = napKulcs(pont.ido);
  pont.szakasz = szakaszId;
  eloKiir(null);
  // Sorban mentjük, hogy a gyors egymásutáni jelek ne előzzék meg egymást.
  kovetoIgeret = kovetoIgeret.then(async () => {
    await pontMent(pont);
    if (pont.nap !== latottNap) { latottNap = pont.nap; await napListaz(); await napRajzol(true); }
    else if (elozoVonal) {
      elozoVonal.addLatLng([pont.sz, pont.h]);
      napiPontok.push(pont);
      osszesitoKiir(osszesit(napiPontok.slice()));
    } else await napRajzol(false);
    if (elso) terkep.setView([pont.sz, pont.h], Math.max(terkep.getZoom(), 16));
    else if ($('terkepZar').hidden === false) { /* a felhasználó épp mozgatja: nem rángatjuk */ }
    else if (!terkep.getBounds().pad(-0.2).contains([pont.sz, pont.h])) terkep.panTo([pont.sz, pont.h]);
    allapot('Követés fut – utolsó pont: ' + new Date(pont.ido).toLocaleTimeString('hu-HU'), 'fut');
  }).catch(e => allapot('A pont mentése nem sikerült: ' + e.message, 'hiba'));
}
function helyHiba(e) {
  if (e.code === 1) { leallit(); allapot('A helyhez nincs engedély. Engedélyezd a telefon beállításaiban, majd indítsd újra.', 'hiba'); }
  else allapot('A hely most nem állapítható meg' + (e.message ? ' (' + e.message + ')' : '') + '. A követés fut tovább, amint a jel visszajön.', 'hiba');
}
// Háttérben követés (bővítmény): ugyanazt a helyJott-ot hívja, a böngésző pozíció-formájában.
let hatterId = null;
function hatterIndit() {
  const id = Hatter.addWatcher({
    backgroundTitle: 'Hol jártam ma – követés fut',
    backgroundMessage: 'Az útvonal a háttérben is rögzül. Leállítás az appban.',
    requestPermissions: true,
    stale: false,
    distanceFilter: 0          // a szűrést (MIN_TAV) az app maga végzi
  }, (hely, hiba) => {
    if (hiba) {
      if (hiba.code === 'NOT_AUTHORIZED') {
        leallit();
        allapot('A helyhez nincs engedély, vagy ki van kapcsolva a helymeghatározás. Engedélyezd, majd indítsd újra.', 'hiba');
        if (confirm('Az appnak engedély kell a helyhez. Megnyissam a beállításait?')) Hatter.openSettings();
      } else allapot('A hely most nem állapítható meg (' + (hiba.message || hiba) + '). A követés fut tovább.', 'hiba');
      return;
    }
    if (!hely) return;
    helyJott({ coords: { latitude: hely.latitude, longitude: hely.longitude, accuracy: hely.accuracy, altitude: hely.altitude, speed: hely.speed }, timestamp: hely.time });
  });
  Promise.resolve(id).then(x => { hatterId = x; });
  return 'hatter';
}
// Az értesítési engedélyt a háttér-bővítmény nem kéri el: az első követésnél egyszer megkérdezzük, megnyissuk-e
// az app beállításait (ott az Értesítések bekapcsolhatók). A követés értesítés nélkül is megy.
function ertesitesKerdes() {
  try { if (!Hatter || localStorage.getItem('holjartam-ertesites-kerdes')) return; localStorage.setItem('holjartam-ertesites-kerdes', '1'); } catch (e) { return; }
  if (confirm('Követés közben az értesítési panelen „Hol jártam ma – követés fut” értesítés jelzi, hogy a háttérben is fut. '
    + 'Ehhez az app értesítéseit be kell kapcsolni (ha még nincsenek).\n\nMegnyissam most az app beállításait? (A követés közben elindul.)')) {
    Hatter.openSettings().catch(() => {});
  }
}
async function indit() {
  if (!Hatter && !('geolocation' in navigator)) { allapot('Ez az eszköz nem tud helyet adni.', 'hiba'); return; }
  ertesitesKerdes();
  szakaszId = Date.now();
  utolso = null;
  eloM = 0; eloMax = 0;
  latottNap = ma();
  latottSzakasz = szakaszId;               // követés közben a mostani szakasz látszik (és a km-óra mezői)
  await utIr({ szakasz: szakaszId, nap: latottNap, tol: szakaszId });
  kovetes = Hatter ? hatterIndit() : navigator.geolocation.watchPosition(helyJott, helyHiba, { enableHighAccuracy: true, maximumAge: 0 });
  $('inditas').hidden = true;
  $('leallitas').hidden = false;
  allapot('Követés fut – a hely keresése…', 'fut');
  eloKiir(null);
  ebrenTart();
  await napListaz();
  await napRajzol(false);
}
async function leallit() {
  if (kovetes === 'hatter') { if (hatterId) Hatter.removeWatcher({ id: hatterId }).catch(() => {}); hatterId = null; }
  else if (kovetes !== null) navigator.geolocation.clearWatch(kovetes);
  const volt = kovetes !== null, id = szakaszId;
  kovetes = null;
  if (ebrenZar) ebrenZar.release().catch(() => {});
  ebrenZar = null;
  $('inditas').hidden = false;
  $('leallitas').hidden = true;
  $('gps').textContent = '';
  $('elo').hidden = true;
  ebrenKiir();
  allapot('A követés leállt.');
  if (!volt) return;
  await kovetoIgeret;
  const u = await utFrissit(id);
  if (u.m == null) await tar('readwrite', s => s.delete(id), 'utak');   // pont nélküli szakasz: nincs mit megőrizni
  await napRajzol(true);
  if (u.m != null) uzenet('✓ Szakasz rögzítve: ' + tavSzoveg(u.m, 2) + '. Az óraállást lent írhatod be.');
  if ($('utLista').open) utListaKiir();
}
$('inditas').addEventListener('click', indit);
$('leallitas').addEventListener('click', leallit);

// ---- GPX ----
function gpx(nap, pontok) {
  const x = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const u = latottSzakasz !== null ? napiUtak.get(latottSzakasz) : null;
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<gpx version="1.1" creator="Hol jártam ma" xmlns="http://www.topografix.com/GPX/1/1">\n'
    + '  <trk><name>' + x('Hol jártam – ' + nap + (u && u.nev ? ' – ' + u.nev : '')) + '</name>\n'
    + szakaszok(pontok).flatMap(sz => darabok(sz, napiSzunetek.filter(x => !szunetPontjai(x, pontok))).filter(d => !d.szagg).map(d => d.pontok))
      .map(sz => '    <trkseg>\n' + sz.map(p => '      <trkpt lat="' + p.sz.toFixed(7) + '" lon="' + p.h.toFixed(7) + '">'
      + (p.mag != null ? '<ele>' + p.mag.toFixed(1) + '</ele>' : '') + '<time>' + new Date(p.ido).toISOString() + '</time></trkpt>').join('\n') + '\n    </trkseg>').join('\n')
    + '\n  </trk>\n</gpx>\n';
}
const fajlnev = n => 'holjartam_' + n + (latottSzakasz !== null ? '_' + oraPerc(latottSzakasz).replace(':', '') : '') + '.gpx';

// Szöveges fájl mentése: APK-ban a Dokumentumok/HolJartam mappába, böngészőben letöltésként. Visszaadja, hova került.
async function fajlMent(nev, szoveg, mime) {
  if (apkban) {
    if (!Filesystem) throw new Error('a mentéshez a Fájlmentés bővítmény kell');
    await Filesystem.writeFile({ path: MAPPA + '/' + nev, data: szoveg, encoding: 'utf8', directory: 'DOCUMENTS', recursive: true });
    return 'Dokumentumok/' + MAPPA + '/' + nev;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([szoveg], { type: mime }));
  a.download = nev;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return 'Letöltések/' + nev;
}
async function letolt() {
  if (!napiPontok.length) { uzenet('Itt nincs mit menteni.', true); return; }
  try { uzenet('✓ Elmentve: ' + await fajlMent(fajlnev(latottNap), gpx(latottNap, napiPontok), 'application/gpx+xml')); }
  catch (e) { uzenet('A mentés nem sikerült: ' + (e.message || e), true); }
}
async function megoszt() {
  if (!napiPontok.length) { uzenet('Itt nincs mit megosztani.', true); return; }
  const o = osszesit(napiPontok.slice());
  const szoveg = 'Hol jártam – ' + latottNap + ': ' + tavSzoveg(o.m, 2) + ', ' + idoSzoveg(o.ido);
  try {
    if (apkban) {
      const f = await Filesystem.writeFile({ path: 'megosztas/' + fajlnev(latottNap), data: gpx(latottNap, napiPontok), encoding: 'utf8', directory: 'CACHE', recursive: true });
      await Share.share({ title: 'Hol jártam', text: szoveg, files: [f.uri], dialogTitle: 'Útvonal megosztása' });
    } else {
      await navigator.share({ files: [new File([gpx(latottNap, napiPontok)], fajlnev(latottNap), { type: 'application/gpx+xml' })], title: 'Hol jártam', text: szoveg });
    }
  } catch (e) {
    if (e.name !== 'AbortError' && !/cancel/i.test(String(e.message || e))) uzenet('A megosztás nem sikerült: ' + (e.message || e), true);
  }
}
$('letoltes').addEventListener('click', letolt);
$('megosztas').addEventListener('click', megoszt);
$('torles').addEventListener('click', async () => {
  if (latottSzakasz !== null) {
    if (kovetes && latottSzakasz === szakaszId) { uzenet('A futó szakaszt követés közben nem lehet törölni.', true); return; }
    if (!confirm('Törlöd a(z) ' + oraPerc(latottSzakasz) + '-kor indult szakaszt?')) return;
    await szakaszTorol(latottSzakasz);
    latottSzakasz = null;
    await napListaz();
    await napRajzol(true);
    uzenet('✓ A szakasz törölve.');
  } else {
    if (!napiPontok.length) return;
    if (kovetes && latottNap === ma()) { uzenet('A mai napot követés közben nem lehet törölni.', true); return; }
    if (!confirm('Törlöd a(z) ' + latottNap + ' nap összes útját?')) return;
    await napTorol(latottNap);
    latottNap = ma();
    await napListaz();
    await napRajzol(true);
    uzenet('✓ A nap törölve.');
  }
  if ($('utLista').open) utListaKiir();
});

// ---- Beállítások és biztonsági mentés ----
$('egysegValaszto').value = merfold() ? 'mi' : 'km';
$('egysegValaszto').addEventListener('change', () => {
  try { localStorage.setItem('holjartam-egyseg', $('egysegValaszto').value); } catch (e) {}
  egysegJelek();
  eloKiir(null);
  if (!kovetes) $('elo').hidden = true;
  napRajzol(false);
  if ($('utLista').open) utListaKiir();
  if (!$('vizszintes').hidden) vzKiir();
});
$('sebKapcsolo').checked = sebKell();
$('sebKapcsolo').addEventListener('change', () => {
  try { localStorage.setItem('holjartam-seb', $('sebKapcsolo').checked ? '1' : '0'); } catch (e) {}
  eloKiir(null);
  if (!kovetes) $('elo').hidden = true;
  osszesitoKiir(osszesit(napiPontok.slice()));
});
$('mentesGomb').addEventListener('click', async () => {
  try {
    const adat = { tipus: 'holjartam-mentes', verzio: 1, ido: new Date().toISOString(),
      pontok: (await mindet('pontok')).map(({ id, ...p }) => p),
      szunetek: (await mindet('szunetek')).map(({ id, ...p }) => p),
      utak: await mindet('utak') };
    const hova = await fajlMent('holjartam-mentes-' + ma() + '.json', JSON.stringify(adat), 'application/json');
    uzenet('✓ Biztonsági mentés: ' + hova + ' (' + adat.utak.length + ' út, ' + adat.pontok.length + ' pont)');
  } catch (e) { uzenet('A mentés nem sikerült: ' + (e.message || e), true); }
});
$('visszaGomb').addEventListener('click', () => $('visszaFajl').click());
$('visszaFajl').addEventListener('change', async () => {
  const f = $('visszaFajl').files[0];
  $('visszaFajl').value = '';
  if (!f) return;
  try {
    const adat = JSON.parse(await f.text());
    if (!adat || adat.tipus !== 'holjartam-mentes') throw new Error('ez nem a Hol jártam ma biztonsági mentése');
    // Hozzáadás: ami már megvan (ugyanaz a szakasz és időpont), azt nem veszi fel újra.
    const pk = new Set((await mindet('pontok')).map(p => p.szakasz + '|' + p.ido));
    const sk = new Set((await mindet('szunetek')).map(s => s.szakasz + '|' + s.tol));
    const uk = new Set((await mindet('utak')).map(u => u.szakasz));
    const ujP = (adat.pontok || []).filter(p => !pk.has(p.szakasz + '|' + p.ido));
    const ujS = (adat.szunetek || []).filter(s => !sk.has(s.szakasz + '|' + s.tol));
    const ujU = (adat.utak || []).filter(u => !uk.has(u.szakasz));
    await tar('readwrite', s => { ujP.forEach(p => s.add(p)); });
    await tar('readwrite', s => { ujS.forEach(p => s.add(p)); }, 'szunetek');
    await tar('readwrite', s => { ujU.forEach(u => s.put(u)); }, 'utak');
    await utakPotol();
    await napListaz();
    await napRajzol(true);
    if ($('utLista').open) utListaKiir();
    uzenet('✓ Visszatöltve: ' + ujU.length + ' új út, ' + ujP.length + ' új pont.');
  } catch (e) { uzenet('A visszatöltés nem sikerült: ' + (e.message || e), true); }
});

// ---- Vízszintes kijelző: pontos idő és sebesség ----
let vzSeb = null, vzSebIdo = 0;       // az utolsó GPS-sebesség (m/s) és mikor jött
let vzForgas = 0;                     // a gyorsulásmérő szerint: 0 = álló, 90 / -90 = oldalra fordítva
let vzBezarva = false;                // koppintással elrejtve (a következő elforgatásig)
let vzZar = null;                     // a képernyő ébren tartása, amíg látszik
let vzSavRejtve = false;              // a rendszersávok el vannak-e rejtve
const vzErintos = apkban || matchMedia('(pointer: coarse)').matches;   // asztali széles ablakban ne jelenjen meg
const vzTajolas = matchMedia('(orientation: landscape)');
function vzKiir() {
  const most = new Date();
  $('vzIdo').textContent = k2(most.getHours()) + ':' + k2(most.getMinutes());
  const friss = vzSeb != null && Date.now() - vzSebIdo < 10000;
  $('vzSeb').textContent = kovetes && friss ? sebSzam(vzSeb * 3.6) : '–';
  // Követés közben ezt is kiírja (álló autónál a sebesség 0, abból nem látszana, hogy fut), a megtett úttal.
  $('vzMegj').textContent = kovetes ? '● követés fut · ' + tavSzoveg(eloM, 1) + (friss ? '' : ' · várok a GPS-re…') : 'a követés nincs elindítva';
  $('vzMegj').classList.toggle('fut', !!kovetes);
  vzGombKiir();
}
function vzFrissit() {
  const fekvo = vzErintos && (vzTajolas.matches || vzForgas !== 0);
  if (!fekvo) vzBezarva = false;
  const latszik = fekvo && !vzBezarva;
  const v = $('vizszintes');
  v.hidden = !latszik;
  // Ha a képernyő maga nem fordult el (automatikus elforgatás kikapcsolva), a kijelzőt mi forgatjuk el.
  v.classList.toggle('forgatva-jobbra', latszik && !vzTajolas.matches && vzForgas === 90);
  v.classList.toggle('forgatva-balra', latszik && !vzTajolas.matches && vzForgas === -90);
  // A rendszersávok elrejtése a vízszintes kijelző idejére (különben két világos sáv marad a szélén).
  if (Rendszersav && latszik !== vzSavRejtve) {
    vzSavRejtve = latszik;
    (latszik ? Rendszersav.hide({}) : Rendszersav.show({})).catch(() => {});
  }
  if (latszik) {
    vzKiir();
    if (!vzZar && 'wakeLock' in navigator) navigator.wakeLock.request('screen').then(z => { vzZar = z; z.addEventListener('release', () => { vzZar = null; }); }).catch(() => {});
  } else if (vzZar) { vzZar.release().catch(() => {}); vzZar = null; }
}
vzTajolas.addEventListener('change', vzFrissit);
// A gyorsulásmérő: álló telefonnál a gravitáció a készülék y tengelye mentén hat, oldalra fordítva az x mentén.
// (x < 0: a jobb oldala van lent, a tartalmat balra kell forgatni; x > 0: a bal oldala.)
// Autós tartóban minden zökkenő egy pillanatra elrántja a mért értéket, ezért:
// - simítás: a mért gravitációt lassan követjük (aluláteresztő szűrő, kb. 0,2 s), így a rázkódás kiesik;
// - szög: a képernyő síkjában nézzük (x és y aránya), így a hátradöntött tartó sem zavar; fekvőre vált, ha kb.
//   63°-nál jobban dől (|x| > 2·|y|), állóra, ha 45°-nál kevésbé (|y| > |x|) – közte marad, ami volt;
// - kitartás: csak akkor vált, ha az új helyzet legalább 1 másodpercig folyamatosan fennáll.
const VZ_KITARTAS = 1000;
let vzGx = 0, vzGy = 9.8, vzJelolt = 0, vzJeloltIdo = 0;
window.addEventListener('devicemotion', e => {
  const g = e.accelerationIncludingGravity;
  if (!g || g.x == null) return;
  const a = 0.08;
  vzGx += a * (g.x - vzGx);
  vzGy += a * ((g.y || 0) - vzGy);
  if (Math.hypot(vzGx, vzGy) < 3) return;         // laposan fekszik (asztalon): marad, ami volt
  const ax = Math.abs(vzGx), ay = Math.abs(vzGy);
  let uj = vzForgas;
  if (ax > 2 * ay) uj = vzGx < 0 ? 90 : -90;
  else if (ay > ax) uj = 0;
  const most = Date.now();
  if (uj === vzForgas || uj !== vzJelolt) { vzJelolt = uj; vzJeloltIdo = most; return; }
  if (most - vzJeloltIdo >= VZ_KITARTAS) { vzForgas = uj; vzFrissit(); }
});
$('vizszintes').addEventListener('click', e => { if (e.target.closest('#vzGomb')) return; vzBezarva = true; vzFrissit(); });

// Indítás / leállítás a vízszintes kijelzőn. Indítás: egy koppintás. Leállítás: 1,2 másodpercig nyomva tartva
// (autós tartóban egy véletlen érintés ne állítsa le a követést).
const VZ_TARTAS = 1200;
// A gomb oldala (Beállítások): bal alsó sarok (alapból, balkormányos autóhoz), vagy jobb (jobbkormányos autóhoz).
const vzOldal = () => { try { return localStorage.getItem('holjartam-vzoldal') === 'jobb' ? 'jobb' : 'bal'; } catch (e) { return 'bal'; } };
$('vzGomb').classList.toggle('bal', vzOldal() === 'bal');
$('vzOldalValaszto').value = vzOldal();
$('vzOldalValaszto').addEventListener('change', () => {
  try { localStorage.setItem('holjartam-vzoldal', $('vzOldalValaszto').value); } catch (e) {}
  $('vzGomb').classList.toggle('bal', vzOldal() === 'bal');
});
let vzTartasIdo = null;
function vzGombKiir() {
  const g = $('vzGomb');
  const fut = !!kovetes;
  if (g.dataset.fut === String(fut)) return;
  g.dataset.fut = String(fut);
  g.classList.toggle('stop', fut);
  g.classList.remove('tart');
  g.innerHTML = fut ? '■ Leállítás<small>tartsd nyomva</small>' : '▶ Indítás';
}
function vzTartasVege() { clearTimeout(vzTartasIdo); vzTartasIdo = null; $('vzGomb').classList.remove('tart'); }
$('vzGomb').addEventListener('click', async e => {
  e.stopPropagation();
  if (kovetes) return;                     // a leállítás a nyomva tartással megy
  await indit();
  vzKiir();
});
$('vzGomb').addEventListener('pointerdown', e => {
  if (!kovetes) return;
  e.preventDefault();
  $('vzGomb').classList.add('tart');
  clearTimeout(vzTartasIdo);
  vzTartasIdo = setTimeout(async () => { vzTartasVege(); await leallit(); vzKiir(); }, VZ_TARTAS);
});
['pointerup', 'pointerleave', 'pointercancel'].forEach(t => $('vzGomb').addEventListener(t, () => { if (vzTartasIdo) vzTartasVege(); }));
$('vzGomb').addEventListener('contextmenu', e => e.preventDefault());   // a hosszú nyomás ne nyisson menüt
setInterval(() => { if (!$('vizszintes').hidden) vzKiir(); }, 1000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { vzZar = null; vzSavRejtve = false; vzFrissit(); } });

// ---- Indulás ----
egysegJelek();
$('valtozat').textContent = (apkban ? 'APK' : 'böngésző') + (typeof VERZIO !== 'undefined' ? ' – v' + VERZIO : '');
$('letoltes').hidden = apkban && !Filesystem;
$('megosztas').hidden = !(apkban ? Filesystem && Share
  : navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.gpx', { type: 'application/gpx+xml' })] }));
if (apkban) {
  const hiany = [!Filesystem && 'Fájlmentés', !Share && 'Megosztás', !Hatter && 'Háttérben követés'].filter(Boolean);
  $('apkMegj').hidden = false;
  $('apkMegj').innerHTML = '<br>' + (hiany.length ? 'Hiányzó bővítmény (a JT AppKreatorban kapcsold be): ' + hiany.join(', ') + '. ' : '')
    + (Hatter ? 'Ha követés közben nem látod a „követés fut” értesítést, kapcsold be az app értesítéseit: '
      + '<button type="button" class="linkgomb" id="beallitasok">🔔 az app beállításai</button>' : '');
}
if ($('beallitasok')) $('beallitasok').addEventListener('click', () => Hatter.openSettings().catch(() => {}));
vzFrissit();
napListaz().then(() => napRajzol(true)).then(utakPotol).catch(e => allapot('A tároló nem érhető el: ' + e.message, 'hiba'));

// Service worker regisztrálása (offline működés).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
