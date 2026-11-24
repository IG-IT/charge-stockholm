"""Charge Stockholm — сборщик цен и статусов зарядных станций Alecta.

Источник: открытый Spirii AFIR API (DATEX II), ключ не нужен.
  https://api.spirii.com/v2/afir/energy-infrastructure-tables   — сайты, точки, тарифы
  https://api.spirii.com/v2/afir/energy-infrastructure-statuses — статусы точек, обновления тарифов

Результат:
  docs/data/latest.json — текущий снимок (перезаписывается каждый запуск).
  История на сервере не хранится: её копит приложение на телефоне (localStorage).

Только стандартная библиотека Python 3.10+.
"""

from __future__ import annotations

import gzip
import json
import math
import os
import sys
import unicodedata
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.getenv("CHARGE_DATA_DIR", ROOT / "docs" / "data"))
TZ = ZoneInfo("Europe/Stockholm")
API = "https://api.spirii.com/v2/afir/energy-infrastructure-"

# Сайты Alecta в Spirii называются "Alecta F - <название>".
# Отслеживаем ровно эти восемь DC-станций (точное совпадение названия).
SITE_PREFIX = "alecta f - "
LOCATIONS = [
    "Nacka Strand DC",
    "Solna Centrum DC",
    "Bredden Öst DC",
    "Bredden Väst DC",
    "Barkarby DC",
    "Värmdö Marknad DC",
    "Värmdö Köpcenter DC",
    "Flygfyren DC",
]

KWH_TYPES = {"priceperkwh"}
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


# ---------------------------------------------------------------- helpers

def walk(obj, key):
    """Рекурсивно находит все значения ключа `key` (списки разворачиваются)."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == key:
                yield from (v if isinstance(v, list) else [v])
            yield from walk(v, key)
    elif isinstance(obj, list):
        for v in obj:
            yield from walk(v, key)


def norm(text: str) -> str:
    """casefold + без диакритики: 'Värmdö' -> 'varmdo'."""
    decomposed = unicodedata.normalize("NFKD", text.casefold())
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def enum(value):
    """DATEX II хранит перечисления как {"value": "..."}."""
    return value.get("value") if isinstance(value, dict) else value


def text(multilingual) -> str:
    """{"values":[{"lang":"en","value":"..."}]} -> первая строка."""
    if not isinstance(multilingual, dict):
        return ""
    values = multilingual.get("values") or []
    return values[0].get("value", "") if values else ""


def parse_time(value: str) -> datetime:
    d = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=TZ)


def hhmm(value: str) -> str:
    return (value or "")[:5]


def fetch(kind: str) -> dict:
    query = {"countryIsos": "SE"}
    for env, key in [("SPIRII_CUSTOMER_IDS", "customerIds"), ("SPIRII_CPO_ID", "cpoId")]:
        if os.getenv(env):
            query[key] = os.environ[env]
    url = API + kind + "?" + urllib.parse.urlencode(query)
    request = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "User-Agent": "ChargeStockholm/1.0",
    })
    last_error = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                body = response.read()
            if body[:2] == b"\x1f\x8b":
                body = gzip.decompress(body)
            return json.loads(body)
        except Exception as error:  # сеть / 5xx / битый JSON — повторяем
            last_error = error
            print(f"fetch {kind} attempt {attempt + 1} failed: {error}", file=sys.stderr)
    raise RuntimeError(f"Spirii API unavailable: {last_error}")


# ---------------------------------------------------------------- tariffs

def window_list(price: dict):
    """Окна действия цены: [{"from","to","days"}]; [] = всегда. None = неподдерживаемое условие."""
    period = price.get("overallPeriod") or {}
    windows = []
    for valid in period.get("validPeriod") or []:
        if set(valid) - {"recurringDayWeekMonthPeriod", "recurringTimePeriodOfDay"}:
            return None
        days = None
        if valid.get("recurringDayWeekMonthPeriod"):
            days = sorted({str(enum(d)).lower() for d in walk(valid, "applicableDay")})
            if not days or set(days) - set(WEEKDAYS):
                return None
        times = valid.get("recurringTimePeriodOfDay") or [{}]
        for t in times:
            start, end = hhmm(t.get("startTimeOfPeriod", "00:00")), hhmm(t.get("endTimeOfPeriod", "00:00"))
            windows.append({"from": start, "to": end, "days": days})
    return windows


def in_window(window: dict, local: datetime) -> bool:
    """end '00:00' означает полночь; start > end — окно через полночь."""
    t = local.strftime("%H:%M")
    start, end = window["from"], window["to"]
    if start == end:
        inside, day = True, local
    elif start < end or end == "00:00":
        inside, day = start <= t and (end == "00:00" or t < end), local
    else:  # 22:00–06:00
        inside = t >= start or t < end
        day = local if t >= start else local - timedelta(days=1)
    if not inside:
        return False
    return window["days"] is None or WEEKDAYS[day.weekday()] in window["days"]


def price_with_tax(price: dict):
    value = price.get("value")
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value < 0:
        return None
    if price.get("taxIncluded") is True:
        return round(float(value), 4)
    if price.get("taxIncluded") is False and isinstance(price.get("taxRate"), (int, float)):
        return round(value * (1 + price["taxRate"] / 100), 4)
    return None  # неизвестно, включён ли НДС — не гадаем


def build_tariff(energy_prices: list, now: datetime) -> dict | None:
    """Превращает список energyPrice в расписание.

    Цена кВт·ч с временным окном — тариф этого окна (например, ночной);
    цена кВт·ч без окна — тариф по умолчанию для остального времени.
    Всё прочее (поминутная плата, плата после N минут) — дополнительные сборы.
    """
    default, periods, fees, unsupported = None, [], [], []
    for p in energy_prices:
        period = p.get("overallPeriod") or {}
        if period.get("overallStartTime") and now < parse_time(period["overallStartTime"]):
            continue
        if period.get("overallEndTime") and now >= parse_time(period["overallEndTime"]):
            continue
        kind = str(enum(p.get("priceType")))
        value = price_with_tax(p)
        windows = window_list(p)
        if value is None or windows is None:
            unsupported.append(kind)
            continue
        conditional = p.get("timeBasedApplicability") or p.get("energyBasedApplicability")
        if kind.lower() in KWH_TYPES and not conditional:
            if windows:
                periods.extend({**w, "price": value} for w in windows)
            elif default is None or value < default:
                default = value
        else:
            fee = {"type": kind, "value": value, "windows": windows}
            time_rule = p.get("timeBasedApplicability") or {}
            if "fromMinute" in time_rule:
                fee["afterMinutes"] = time_rule["fromMinute"]
            if "toMinute" in time_rule:
                fee["untilMinute"] = time_rule["toMinute"]
            if p.get("energyBasedApplicability"):
                fee["energyRule"] = p["energyBasedApplicability"]
            fees.append(fee)
    if default is None and not periods:
        return None
    periods.sort(key=lambda w: w["from"])
    return {"default": default, "periods": periods, "fees": fees, "unsupported": sorted(set(unsupported))}


def current_price(tariff: dict | None, now: datetime):
    if not tariff:
        return None
    local = now.astimezone(TZ)
    matches = [w["price"] for w in tariff["periods"] if in_window(w, local)]
    return min(matches) if matches else tariff["default"]


def point_tariff(point: dict, status: dict, now: datetime) -> dict | None:
    """Тариф ad hoc в SEK; обновление из статусов имеет приоритет над таблицей."""
    updates = {}
    for u in walk(status, "energyRateUpdate"):
        ref = (u.get("energyRateReference") or {}).get("idG")
        if ref:
            updates[ref] = u
    best = None
    for rate in walk(point, "energyRate"):
        if enum(rate.get("ratePolicy")) != "adHoc" or rate.get("applicableCurrency") != ["SEK"]:
            continue
        source = updates.get(rate.get("idG"), rate)
        tariff = build_tariff(source.get("energyPrice") or [], now)
        if tariff and (best is None or (current_price(tariff, now) or math.inf) < (current_price(best, now) or math.inf)):
            best = tariff
    return best


# ---------------------------------------------------------------- sites

def match_location(site_name: str):
    n = norm(site_name)
    if not n.startswith(SITE_PREFIX):
        return None
    for location in LOCATIONS:
        if n == SITE_PREFIX + norm(location):
            return location
    return None


def address_of(site: dict) -> str:
    facility = next(walk(site.get("locationReference", {}), "FacilityLocation"), {})
    address = facility.get("address") or {}
    street = " ".join(text(line.get("text")) for line in address.get("addressLine") or [])
    return ", ".join(x for x in [street.strip(), text(address.get("city"))] if x)


def parse(static: dict, dynamic: dict, now: datetime) -> list[dict]:
    statuses = {}
    for s in walk(dynamic, "aegiElectricChargingPointStatus"):
        ref = (s.get("reference") or {}).get("idG")
        if ref:
            statuses[ref] = s  # в ответе сайты повторяются — оставляем одну запись на точку

    stations = []
    for site in walk(static, "energyInfrastructureSite"):
        full_name = text(site.get("name"))
        location = match_location(full_name)
        if not location:
            continue
        points = {p["idG"]: p for p in walk(site, "aegiElectricChargingPoint") if p.get("idG")}
        tariffs, prices, status_counter, powers, currents = [], [], Counter(), [], set()
        for point_id, point in points.items():
            status = statuses.get(point_id, {})
            status_counter[str(enum(status.get("status")) or "unknown")] += 1
            tariff = point_tariff(point, status, now)
            if tariff:
                tariffs.append(json.dumps(tariff, sort_keys=True))
                prices.append(current_price(tariff, now))
            powers.extend(v / 1000 for v in walk(point, "maxPowerAtSocket") if isinstance(v, (int, float)))
            currents.add(str(enum(point.get("currentType"))).lower())

        tariff_counts = Counter(tariffs)
        tariff = json.loads(tariff_counts.most_common(1)[0][0]) if tariff_counts else None
        prices = [p for p in prices if p is not None]
        coords = next(walk(site, "coordinatesForDisplay"), {}) or {}
        known = sum(n for k, n in status_counter.items() if k != "unknown")
        stations.append({
            "id": site.get("idG"),
            "location": location,
            "name": full_name[len(SITE_PREFIX):].strip() if norm(full_name).startswith(SITE_PREFIX) else full_name,
            "kind": "DC" if "dc" in currents else "AC",
            "kw": round(max(powers)) if powers else None,
            "lat": coords.get("latitude"),
            "lon": coords.get("longitude"),
            "address": address_of(site),
            "price": min(prices) if prices else None,
            "priceMax": max(prices) if prices and max(prices) != min(prices) else None,
            "tariff": tariff,
            "tariffVariants": len(tariff_counts),
            "total": len(points),
            "free": status_counter.get("available", 0) if known else None,
            "statusKnown": known,
            "statuses": dict(status_counter),
        })
    stations.sort(key=lambda s: LOCATIONS.index(s["location"]))
    return stations


# ---------------------------------------------------------------- output

def half_hour_slot(now: datetime) -> datetime:
    """Начало получасового слота: 21:11 -> 21:00, 21:44 -> 21:30. Ключ записи истории."""
    return now.replace(minute=0 if now.minute < 30 else 30, second=0, microsecond=0)


def save_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


def main() -> None:
    now = datetime.now(timezone.utc).replace(microsecond=0)
    static, dynamic = fetch("tables"), fetch("statuses")
    stations = parse(static, dynamic, now)

    found = {s["location"] for s in stations}
    for s in stations:
        print(f"{s['location']:<18} {s['name']:<28} {s['kind']} {s['kw'] or '?':>4} kW  "
              f"price={s['price']}  free={s['free']}/{s['total']}")
    missing = [loc for loc in LOCATIONS if loc not in found]
    if missing:
        print("WARNING: locations not found:", ", ".join(missing))
    unsupported = sorted({u for s in stations if s["tariff"] for u in s["tariff"]["unsupported"]})
    if unsupported:
        print("WARNING: skipped price entries:", unsupported)
    if not stations:
        raise RuntimeError("No Alecta sites matched — site naming in Spirii may have changed.")

    save_json(DATA_DIR / "latest.json", {
        "updated": now.isoformat(),
        "slot": half_hour_slot(now).isoformat(),
        "source": "Spirii AFIR",
        "locations": LOCATIONS,
        "stations": stations,
    })
    print(f"Saved {len(stations)} stations")


if __name__ == "__main__":
    main()
