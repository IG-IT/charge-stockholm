'use strict';

// ------------------------------------------------------------------ state
const TZ = 'Europe/Stockholm';
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const $ = id => document.getElementById(id);

const state = {
  latest: { stations: [] },
  history: null,              // локальная история (localStorage), см. loadHistory()
  favorites: new Set(JSON.parse(localStorage.getItem('favorites') || '[]')),
  favOnly: localStorage.getItem('favOnly') === '1',
  days: 1,
  position: null,
  // Типичная зарядка: батарея ~100 кВт·ч, 30 → 90 %, пик машины ~130 кВт.
  car: { battery: 100, from: 30, to: 90, kw: 130, ...JSON.parse(localStorage.getItem('car') || '{}') },
};

/** Сколько кВт·ч нужно для обычной зарядки. */
const chargeKwh = () => Math.max(0, state.car.battery * (state.car.to - state.car.from) / 100);

// ------------------------------------------------------------------ format
const fmt = v => v == null ? '—' : v.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtTime = t => new Date(t).toLocaleString('sv-SE', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' });
const range = (a, b) => `${a.slice(0, 2)}–${b === '00:00' ? '24' : b.slice(0, 2)}`;

function node(tag, text, cls) {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}

// ------------------------------------------------------------------ tariff (зеркало parser.py)
const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', weekday: 'long', hourCycle: 'h23',
});

function stockholm(date) {
  const p = Object.fromEntries(partsFmt.formatToParts(date).map(x => [x.type, x.value]));
  return { hhmm: `${p.hour}:${p.minute}`, hour: Number(p.hour), day: WEEKDAYS.indexOf(p.weekday.toLowerCase()) };
}

function inWindow(w, local) {
  const t = local.hhmm, { from, to } = w;
  let inside, day = local.day;
  if (from === to) inside = true;
  else if (from < to || to === '00:00') inside = from <= t && (to === '00:00' || t < to);
  else { inside = t >= from || t < to; if (t < to) day = (day + 6) % 7; }
  return inside && (!w.days || w.days.includes(WEEKDAYS[day]));
}

function priceAt(tariff, date) {
  if (!tariff) return null;
  const local = stockholm(date);
  const hits = tariff.periods.filter(w => inWindow(w, local)).map(w => w.price);
  return hits.length ? Math.min(...hits) : tariff.default;
}

/** Цены на каждый час текущих суток (по Стокгольму, середина часа). */
function hourlyPrices(tariff) {
  const now = new Date(), cur = stockholm(now).hour;
  return Array.from({ length: 24 }, (_, h) => priceAt(tariff, new Date(now.getTime() + ((h - cur) * 60 + 30 - now.getMinutes()) * 60000)));
}

function tariffSummary(t) {
  if (!t) return 'Тариф недоступен';
  const groups = new Map();
  for (const p of t.periods) {
    const key = p.price + '|' + (p.days || []).join(',');
    if (!groups.has(key)) groups.set(key, { price: p.price, days: p.days, ranges: [] });
    groups.get(key).ranges.push(range(p.from, p.to));
  }
  const parts = [...groups.values()]
    .filter(g => g.price !== t.default)
    .map(g => `${fmt(g.price)} kr ${g.ranges.join(', ')}${g.days ? ' (' + g.days.map(d => d.slice(0, 2)).join(',') + ')' : ''}`);
  if (!parts.length) return t.default != null ? 'Круглосуточно одна цена' : '';
  return parts.join(' · ') + (t.default != null ? ` · иначе ${fmt(t.default)} kr` : '');
}

function feeText(f) {
  const unit = { pricePerMinute: 'kr/мин', pricePerHour: 'kr/ч', pricePerKWh: 'kr/кВт·ч' }[f.type] || `kr (${f.type})`;
  let s = `+${fmt(f.value)} ${unit}`;
  if (f.afterMinutes != null) s += ` после ${f.afterMinutes} мин`;
  if (f.windows?.length) s += ` (${f.windows.map(w => range(w.from, w.to)).join(', ')})`;
  return s;
}

// ------------------------------------------------------------------ helpers
function distanceKm(s) {
  if (!state.position || s.lat == null) return null;
  const [lat1, lon1] = state.position, rad = Math.PI / 180;
  const a = Math.sin((s.lat - lat1) * rad / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(s.lat * rad) * Math.sin((s.lon - lon1) * rad / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

function routeUrl(s) {
  const dest = s.lat != null ? `${s.lat},${s.lon}` : encodeURIComponent(`${s.name} Alecta laddstation`);
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}` + (state.position ? `&origin=${state.position.join(',')}` : '');
}

function availability(s) {
  if (s.free == null) return { cls: 'none', text: 'статус неизвестен' };
  const broken = (s.statuses?.outOfOrder || 0) + (s.statuses?.inoperative || 0);
  const cls = s.free === 0 ? 'bad' : s.free <= Math.max(1, s.total / 4) ? 'warn' : 'ok';
  return { cls, text: `${s.free}/${s.total} свободно` + (broken ? ` · ${broken} не работает` : '') };
}

function visibleStations() {
  return state.latest.stations.filter(s =>
    !state.favOnly || state.favorites.has(s.id));
}

// ------------------------------------------------------------------ render: list
function render() {
  const all = state.latest.stations;
  const known = all.filter(s => s.price != null).sort((a, b) => a.price - b.price);
  $('best').textContent = known.length ? `${fmt(known[0].price)} kr/кВт·ч` : 'Нет данных';
  $('bestName').textContent = known.length
    ? known.filter(s => s.price === known[0].price).map(s => s.name).join(', ')
    : 'Ожидается первый успешный сбор данных';
  const night = all.map(s => ({ s, p: Math.min(...hourlyPrices(s.tariff).filter(x => x != null)) }))
    .filter(x => isFinite(x.p)).sort((a, b) => a.p - b.p)[0];
  $('bestNight').textContent = night && known.length && night.p < known[0].price
    ? `Минимум за сутки: ${fmt(night.p)} kr — ${night.s.name}` : '';

  const sortKey = $('sort').value;
  const rows = visibleStations().sort((a, b) => {
    if (sortKey === 'price') return (a.price ?? Infinity) - (b.price ?? Infinity);
    if (sortKey === 'distance') return (distanceKm(a) ?? Infinity) - (distanceKm(b) ?? Infinity);
    return (b[sortKey] ?? -1) - (a[sortKey] ?? -1);
  });

  const list = $('stations');
  list.replaceChildren();
  if (!rows.length) list.append(node('p', state.favOnly ? 'В избранном пока ничего нет — нажмите ☆ у станции.' : 'Нет станций.', 'meta'));
  for (const s of rows) list.append(stationCard(s));

  fillSelect($('station'), all);
  fillSelect($('calcStation'), all);
  details();
}

function stationCard(s) {
  const card = node('article', null, 'station');
  const main = node('div', null, 'station-main');
  const side = node('div', null, 'station-side');

  const title = node('strong', s.name);
  main.append(title);

  const meta = node('div', null, 'meta');
  meta.append(node('span', s.kind, 'tag'), `${s.kw ?? '—'} кВт · `);
  const av = availability(s);
  meta.append(node('span', null, 'dot ' + av.cls), av.text);
  const d = distanceKm(s);
  if (d != null) meta.append(` · ${d < 10 ? d.toFixed(1) : Math.round(d)} км`);
  main.append(meta);

  main.append(node('div', tariffSummary(s.tariff), 'meta'));
  if (s.tariff?.fees?.length) main.append(node('div', s.tariff.fees.map(feeText).join(' · '), 'meta'));

  const links = node('div', null, 'links');
  const route = node('a', 'Маршрут');
  route.href = routeUrl(s); route.target = '_blank'; route.rel = 'noopener';
  const more = node('a', 'Подробнее');
  more.href = '#details';
  more.onclick = () => { $('station').value = s.id; details(); };
  links.append(route, more);
  main.append(links);

  const price = node('div', null, 'price');
  price.append(fmt(s.price) + (s.priceMax != null ? '–' + fmt(s.priceMax) : ''), node('small', ' kr'));
  const fav = node('button', state.favorites.has(s.id) ? '★' : '☆', 'fav');
  fav.setAttribute('aria-label', (state.favorites.has(s.id) ? 'Убрать из избранного ' : 'В избранное ') + s.name);
  fav.onclick = () => {
    state.favorites.has(s.id) ? state.favorites.delete(s.id) : state.favorites.add(s.id);
    localStorage.setItem('favorites', JSON.stringify([...state.favorites]));
    render();
  };
  side.append(fav, price);
  if (s.price != null && chargeKwh() > 0) {
    side.append(node('div', `≈ ${Math.round(s.price * chargeKwh())} kr за ${state.car.from}→${state.car.to}%`, 'trip'));
  }

  card.append(main, side);
  return card;
}

function fillSelect(select, stations) {
  const old = select.value;
  select.replaceChildren(...stations.map(s => {
    const o = node('option', `${s.name} · ${fmt(s.price)} kr`);
    o.value = s.id;
    return o;
  }));
  if (old && stations.some(s => s.id === old)) select.value = old;
  else {
    const fav = stations.find(s => state.favorites.has(s.id));
    if (fav) select.value = fav.id;
  }
}

// ------------------------------------------------------------------ render: details
function selected() {
  return state.latest.stations.find(s => s.id === $('station').value);
}

function priceColor(p, min, max) {
  if (p == null) return 'var(--line)';
  const r = max > min ? (p - min) / (max - min) : 0;
  return r < 0.34 ? 'var(--cheap)' : r < 0.67 ? 'var(--mid)' : 'var(--dear)';
}

function details() {
  const s = selected();
  calc();
  if (!s) return;

  // тариф на сегодня
  const hours = hourlyPrices(s.tariff), valid = hours.filter(p => p != null);
  const min = Math.min(...valid), max = Math.max(...valid), cur = stockholm(new Date()).hour;
  $('schedule').replaceChildren(...hours.map((p, h) => {
    const bar = node('div', null, h === cur ? 'now' : '');
    bar.style.height = p == null ? '4px' : `${40 + 60 * (max > min ? (p - min) / (max - min) : 0.5)}%`;
    bar.style.background = priceColor(p, min, max);
    bar.title = `${String(h).padStart(2, '0')}:00 — ${fmt(p)} kr/кВт·ч`;
    return bar;
  }));
  $('fees').textContent = tariffSummary(s.tariff) +
    (s.tariff?.fees?.length ? '. Доп. сборы: ' + s.tariff.fees.map(feeText).join('; ') : '') +
    (s.tariffVariants > 1 ? `. Внимание: у точек станции ${s.tariffVariants} разных тарифа.` : '');

  // история
  const series = historySeries(s.id, state.days);
  drawChart($('chart'), series.map(r => [r.t, r.price]), { step: true, unit: 'kr', digits: 2 });
  drawChart($('freeChart'), series.map(r => [r.t, r.free]), { step: true, unit: '', digits: 0, zero: true, max: s.total });
  const prices = series.map(r => r.price).filter(p => p != null);
  $('stats').textContent = prices.length
    ? `Мин. ${fmt(Math.min(...prices))} · Сред. ${fmt(prices.reduce((a, b) => a + b, 0) / prices.length)} · Макс. ${fmt(Math.max(...prices))} kr · ${series.length} замеров`
    : '';
  heatmap(series, s.total);
  renderDataInfo();
}

// ------------------------------------------------------------------ local history (localStorage + CSV)
// История хранится только на этом устройстве. Формат:
// {v:2, sites:[id...], names:{id:name}, rows:[[epochSec, [цены по sites], [свободно по sites]], ...]}
const HISTORY_KEY = 'history', HISTORY_DAYS = 365;
const CSV_HEADER = ['time_utc', 'time_stockholm', 'station_id', 'station', 'price_sek_per_kwh', 'free_spots'];

const emptyHistory = () => ({ v: 2, sites: [], names: {}, rows: [] });

function loadHistory() {
  try {
    const h = JSON.parse(localStorage.getItem(HISTORY_KEY));
    if (h && h.v === 2 && Array.isArray(h.rows) && Array.isArray(h.sites)) return h;
  } catch (e) { console.warn(e); }
  return emptyHistory();
}

function saveHistory(h) {
  const cut = Date.now() / 1000 - HISTORY_DAYS * 86400;
  h.rows = h.rows.filter(r => r[0] >= cut).sort((a, b) => a[0] - b[0]);
  for (;;) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
      return true;
    } catch (e) {                               // нет места — удаляем самые старые 10%
      if (h.rows.length < 10) { console.warn(e); return false; }
      h.rows.splice(0, Math.ceil(h.rows.length / 10));
    }
  }
}

/** records: [{t, id, name, price, free}]. Та же станция в то же время перезаписывается. Возвращает число новых. */
function mergeRecords(h, records) {
  const byTime = new Map(h.rows.map(r => [r[0], r]));
  let added = 0;
  for (const rec of records) {
    let i = h.sites.indexOf(rec.id);
    if (i < 0) i = h.sites.push(rec.id) - 1;
    if (rec.name) h.names[rec.id] = rec.name;
    let row = byTime.get(rec.t);
    if (!row) { row = [rec.t, [], []]; byTime.set(rec.t, row); h.rows.push(row); }
    if (row[1][i] == null && row[2][i] == null) added++;
    row[1][i] = rec.price;
    row[2][i] = rec.free;
  }
  return added;
}

/** Вливает в локальную историю последние 7 дней с сервера и текущий снимок (один раз на новый снимок). */
function recordSnapshot(latest) {
  if (!latest.updated || !latest.stations?.length) return;
  if (state.history.lastUpdated === latest.updated) return;   // этот снимок уже сохранён
  const names = Object.fromEntries(latest.stations.map(s => [s.id, s.name]));
  const records = [];
  const recent = latest.recent;
  if (recent && Array.isArray(recent.sites) && Array.isArray(recent.rows)) {
    for (const [t, prices, free] of recent.rows) {
      recent.sites.forEach((id, i) => {
        if (prices?.[i] == null && free?.[i] == null) return;
        records.push({ t, id, name: names[id], price: prices[i] ?? null, free: free[i] ?? null });
      });
    }
  }
  // Ключ — начало получасового слота (21:00, 21:30…): повторный запуск в том же слоте перезапишет запись.
  const t = Math.floor(Date.parse(latest.slot || latest.updated) / 1000);
  for (const s of latest.stations) records.push({ t, id: s.id, name: s.name, price: s.price, free: s.free });
  mergeRecords(state.history, records);
  state.history.lastUpdated = latest.updated;
  saveHistory(state.history);
}

const csvCell = v => {
  v = v == null ? '' : String(v);
  return /[",;\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

function historyToCsv(h) {
  const lines = [CSV_HEADER.join(',')];
  for (const [t, prices, free] of h.rows) {
    h.sites.forEach((id, i) => {
      if (prices[i] == null && free[i] == null) return;
      const d = new Date(t * 1000);
      lines.push([d.toISOString(), fmtTime(d), id, h.names[id] || id, prices[i], free[i]].map(csvCell).join(','));
    });
  }
  return lines.join('\r\n') + '\r\n';
}

/** CSV-парсер с поддержкой кавычек; разделитель , или ; */
function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}

function importCsv(text) {
  const [header, ...rows] = parseCsv(text);
  const names = (header || []).map(x => x.trim().toLowerCase());
  const col = n => names.indexOf(n);
  const iT = col('time_utc'), iId = col('station_id'), iName = col('station'), iP = col('price_sek_per_kwh'), iF = col('free_spots');
  if (iT < 0 || iId < 0) throw new Error('Неверный формат: нужны столбцы time_utc и station_id.');
  const num = v => {
    v = (v ?? '').trim().replace(',', '.');
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const records = [];
  let skipped = 0;
  for (const r of rows) {
    const t = Date.parse(r[iT]), id = (r[iId] || '').trim();
    if (!Number.isFinite(t) || !id) { skipped++; continue; }
    records.push({
      t: Math.floor(t / 1000), id,
      name: iName >= 0 ? (r[iName] || '').trim() : '',
      price: iP >= 0 ? num(r[iP]) : null,
      free: iF >= 0 ? num(r[iF]) : null,
    });
  }
  const added = mergeRecords(state.history, records);
  saveHistory(state.history);
  return { added, total: records.length, skipped };
}

async function exportCsv() {
  const name = `charge-stockholm-${new Date().toISOString().slice(0, 10)}.csv`;
  const file = new File(['\uFEFF' + historyToCsv(state.history)], name, { type: 'text/csv' });
  if (navigator.canShare?.({ files: [file] })) {   // iPhone: меню «Поделиться» → «Сохранить в Файлы»
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = node('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

const plural = (n, one, few, many) =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many;

function renderDataInfo() {
  const h = state.history, rows = h.rows;
  const kb = Math.round((localStorage.getItem(HISTORY_KEY) || '').length / 1024);
  $('historyInfo').textContent = rows.length
    ? `${rows.length} ${plural(rows.length, 'снимок', 'снимка', 'снимков')} · ${fmtTime(rows[0][0] * 1000)} — ${fmtTime(rows.at(-1)[0] * 1000)} · ~${kb} КБ`
    : 'История пока пуста.';
}

function historySeries(id, days) {
  const h = state.history;
  if (!h || h.v !== 2) return [];
  const i = h.sites.indexOf(id), cut = Date.now() / 1000 - days * 86400;
  if (i < 0) return [];
  return h.rows.filter(r => r[0] >= cut).map(r => ({ t: r[0] * 1000, price: r[1][i] ?? null, free: r[2][i] ?? null }));
}

function heatmap(series, total) {
  const bins = Array.from({ length: 24 }, () => ({ p: [], f: [] }));
  for (const r of series) {
    const b = bins[stockholm(new Date(r.t)).hour];
    if (r.price != null) b.p.push(r.price);
    if (r.free != null) b.f.push(r.free);
  }
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  $('heat').replaceChildren(...bins.map((b, h) => {
    const cell = node('div', null, 'cell'), share = total && b.f.length ? avg(b.f) / total : null;
    cell.append(node('b', String(h).padStart(2, '0') + ':00'), fmt(avg(b.p)), node('br'),
      share == null ? '—' : `${Math.round(share * 100)}% своб.`);
    if (share != null) cell.style.background = `color-mix(in srgb, var(--ok) ${Math.round(share * 45)}%, var(--bg))`;
    return cell;
  }));
}

/** Простой SVG-график. points: [[timeMs, value|null], ...] */
function drawChart(el, points, opt) {
  const data = points.filter(p => p[1] != null);
  el.replaceChildren();
  if (data.length < 1) { el.append(node('div', 'История пока не накоплена — новые данные появляются каждые 30 минут.', 'empty')); return; }
  const W = 340, H = 140, L = 34, R = 6, T = 8, B = 20;
  const t0 = data[0][0], t1 = data.at(-1)[0];
  let lo = Math.min(...data.map(p => p[1])), hi = Math.max(...data.map(p => p[1]));
  if (opt.zero) lo = 0;
  if (opt.max != null) hi = Math.max(hi, opt.max);
  if (hi === lo) { hi += opt.digits ? 0.5 : 1; lo = Math.max(0, lo - (opt.digits ? 0.5 : 1)); }
  const x = t => L + (W - L - R) * (t1 > t0 ? (t - t0) / (t1 - t0) : 1);
  const y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const add = (tag, attrs, text) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    svg.append(e);
    return e;
  };
  for (const v of [lo, (lo + hi) / 2, hi]) {
    add('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' });
    add('text', { x: L - 4, y: y(v) + 3, 'text-anchor': 'end', class: 'axis' }, v.toFixed(opt.digits));
  }
  add('text', { x: L, y: H - 4, class: 'axis' }, fmtTime(t0));
  add('text', { x: W - R, y: H - 4, 'text-anchor': 'end', class: 'axis' }, fmtTime(t1));
  let d = '';
  data.forEach(([t, v], k) => {
    d += k === 0 ? `M${x(t)},${y(v)}` : (opt.step ? `H${x(t)}V${y(v)}` : `L${x(t)},${y(v)}`);
  });
  if (data.length === 1) add('circle', { cx: x(t0), cy: y(data[0][1]), r: 3, fill: 'var(--accent)' });
  add('path', { d, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, 'stroke-linejoin': 'round' });
  el.append(svg);
}

// ------------------------------------------------------------------ calculator
function calc() {
  const s = state.latest.stations.find(x => x.id === $('calcStation').value);
  const kwh = chargeKwh();
  const out = $('cost');
  out.replaceChildren();
  if (!s || s.price == null) { out.textContent = 'Нет тарифа для расчёта'; return; }
  if (!(kwh > 0)) { out.textContent = 'Укажите заряд «до» больше, чем «с».'; return; }
  out.append(`Нужно ~${fmt(kwh)} кВт·ч (${state.car.from} → ${state.car.to} %)`, node('br'));
  const hours = hourlyPrices(s.tariff).filter(p => p != null);
  const cheapest = Math.min(...hours);
  out.append('Сейчас: ', node('strong', `${fmt(s.price * kwh)} kr`), ` (${fmt(s.price)} kr/кВт·ч)`);
  if (cheapest < s.price) {
    out.append(node('br'), `В самый дешёвый час: ${fmt(cheapest * kwh)} kr — экономия ${fmt((s.price - cheapest) * kwh)} kr`);
  }
  const minuteFee = s.tariff?.fees?.find(f => f.type === 'pricePerMinute');
  if (minuteFee) {
    out.append(node('br'), node('span', `⚠ ${feeText(minuteFee)} — не забудьте отключиться вовремя.`, 'meta'));
  }
  if (s.kw) {
    // Средняя мощность DC-сессии ~65 % от пика (машина снижает мощность после ~50–60 %).
    const avg = s.kind === 'AC' ? Math.min(s.kw, 11) : Math.min(s.kw, state.car.kw) * 0.65;
    const minutes = Math.round(kwh / avg * 60);
    out.append(node('br'), node('span', `Примерное время: ~${minutes} мин (в среднем ~${Math.round(avg)} кВт).`, 'meta'));
  }
}

// ------------------------------------------------------------------ data loading
async function getJSON(name) {
  const r = await fetch(`data/${name}.json`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return r.json();
}

const clock = d => d.toLocaleTimeString('sv-SE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

async function load(manual = false) {
  const btn = $('refresh');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('spin');
  const started = Date.now();
  const before = state.latest.updated;
  try {
    state.latest = await getJSON('latest');
    recordSnapshot(state.latest);
    const updated = state.latest.updated;
    const stale = updated && Date.now() - Date.parse(updated) > 90 * 60000;
    const fresh = manual && before && updated !== before ? ' · ✓ новые данные' : '';
    $('status').textContent = updated
      ? `Данные от ${fmtTime(updated)} · проверено ${clock(new Date())}${fresh}${stale ? ' · ⚠ данные устарели' : ''}${navigator.onLine ? '' : ' · офлайн'}`
      : 'Первый сбор данных ещё не выполнен';
    render();
  } catch (e) {
    console.warn(e);
    $('status').textContent = `Не удалось загрузить данные (${clock(new Date())}) — проверьте соединение.`;
  } finally {
    // чтобы анимация была заметна даже при мгновенном ответе
    setTimeout(() => { btn.disabled = false; btn.classList.remove('spin'); }, Math.max(0, 600 - (Date.now() - started)));
  }
}

/** Проверяет новую версию приложения; новый service worker сразу берёт управление → перезагрузка. */
function checkAppUpdate() {
  navigator.serviceWorker?.getRegistration().then(r => r?.update()).catch(() => {});
}

// ------------------------------------------------------------------ events
document.querySelectorAll('[data-days]').forEach(b => b.onclick = () => {
  state.days = Number(b.dataset.days);
  document.querySelectorAll('[data-days]').forEach(x => x.classList.toggle('active', x === b));
  details();
});
$('favOnly').onclick = () => {
  state.favOnly = !state.favOnly;
  localStorage.setItem('favOnly', state.favOnly ? '1' : '0');
  $('favOnly').setAttribute('aria-pressed', state.favOnly);
state.history = loadHistory();
renderDataInfo();
navigator.storage?.persist?.().catch(() => {});   // просим браузер не удалять данные
  render();
};
$('refresh').onclick = () => { load(true); checkAppUpdate(); };
$('exportCsv').onclick = () => exportCsv().catch(e => { $('dataMsg').textContent = 'Не удалось экспортировать: ' + e.message; });
$('importBtn').onclick = () => $('importCsv').click();
$('importCsv').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const r = importCsv(await file.text());
    $('dataMsg').textContent = `Импортировано: ${r.added} новых записей из ${r.total}` + (r.skipped ? `, пропущено ${r.skipped} строк` : '') + '.';
    render();
  } catch (err) {
    $('dataMsg').textContent = err.message;
  }
};
$('clearHistory').onclick = () => {
  if (!confirm('Удалить всю историю на этом устройстве? Сначала можно сделать экспорт CSV.')) return;
  state.history = emptyHistory();
  saveHistory(state.history);
  $('dataMsg').textContent = 'История удалена.';
  render();
};
$('sort').onchange = render;
$('station').onchange = details;
$('calcStation').onchange = calc;
for (const [id, key] of [['battery', 'battery'], ['socFrom', 'from'], ['socTo', 'to'], ['carKw', 'kw']]) {
  $(id).value = state.car[key];
  $(id).oninput = () => {
    const v = Number($(id).value);
    if (!Number.isFinite(v) || $(id).value === '') return;
    state.car[key] = key === 'from' || key === 'to' ? Math.min(100, Math.max(0, v)) : Math.max(1, v);
    localStorage.setItem('car', JSON.stringify(state.car));
    render();
  };
}
$('loc').onclick = () => {
  if (!navigator.geolocation) return alert('Геолокация не поддерживается');
  $('loc').textContent = '📍 Определяю…';
  navigator.geolocation.getCurrentPosition(p => {
    state.position = [p.coords.latitude, p.coords.longitude];
    $('loc').textContent = '📍 Рядом со мной';
    $('sort').value = 'distance';
    render();
  }, () => {
    $('loc').textContent = '📍 Рядом со мной';
    alert('Местоположение недоступно. Разрешите доступ в настройках браузера.');
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
};
window.addEventListener('online', () => load());
document.addEventListener('visibilitychange', () => { if (!document.hidden) { load(); checkAppUpdate(); } });

$('favOnly').setAttribute('aria-pressed', state.favOnly);
state.history = loadHistory();
renderDataInfo();
navigator.storage?.persist?.().catch(() => {});   // просим браузер не удалять данные
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloading) { reloading = true; location.reload(); }   // вышла новая версия
  });
  navigator.serviceWorker.register('./sw.js').catch(console.warn);
}
load();
setInterval(() => load(), 5 * 60000);
