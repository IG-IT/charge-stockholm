"""Тесты парсера. Запуск: python -m unittest discover -s scripts

fixtures/ — реальный ответ Spirii AFIR от 2026-11-24, урезанный до сайтов Alecta.
"""

import json
import unittest
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import parser as P

FIXTURES = Path(__file__).parent / "fixtures"
TZ = ZoneInfo("Europe/Stockholm")


def at(text: str) -> datetime:
    """Время по Стокгольму -> UTC."""
    return datetime.fromisoformat(text).replace(tzinfo=TZ).astimezone(timezone.utc)


def kwh(value, start=None, end=None, **extra):
    price = {"priceType": {"value": "pricePerKWh"}, "value": value, "taxIncluded": True, **extra}
    if start:
        price["overallPeriod"] = {"validPeriod": [{"recurringTimePeriodOfDay": [
            {"startTimeOfPeriod": start, "endTimeOfPeriod": end}]}]}
    return price


class TariffTest(unittest.TestCase):
    def test_default_and_night_window(self):
        t = P.build_tariff([kwh(2.95, "00:00", "07:00"), kwh(3.95)], at("2026-11-24T12:00"))
        self.assertEqual(P.current_price(t, at("2026-11-24T12:00")), 3.95)
        self.assertEqual(P.current_price(t, at("2026-11-24T03:00")), 2.95)
        self.assertEqual(P.current_price(t, at("2026-11-24T07:00")), 3.95)

    def test_window_ending_at_midnight(self):
        t = P.build_tariff([kwh(3.49, "23:00", "00:00"), kwh(4.95)], at("2026-11-24T12:00"))
        self.assertEqual(P.current_price(t, at("2026-11-24T23:30")), 3.49)
        self.assertEqual(P.current_price(t, at("2026-11-24T22:59")), 4.95)

    def test_overnight_window(self):
        t = P.build_tariff([kwh(3.0, "22:00", "06:00"), kwh(5.0)], at("2026-11-24T12:00"))
        self.assertEqual(P.current_price(t, at("2026-11-24T23:00")), 3.0)
        self.assertEqual(P.current_price(t, at("2026-11-24T05:59")), 3.0)
        self.assertEqual(P.current_price(t, at("2026-11-24T06:00")), 5.0)

    def test_weekday_restriction(self):
        price = kwh(2.0)
        price["overallPeriod"] = {"validPeriod": [{"recurringDayWeekMonthPeriod": {
            "applicableDay": [{"value": "saturday"}, {"value": "sunday"}]}}]}
        t = P.build_tariff([price, kwh(4.0)], at("2026-11-24T12:00"))
        self.assertEqual(P.current_price(t, at("2026-11-28T12:00")), 2.0)  # суббота
        self.assertEqual(P.current_price(t, at("2026-11-24T12:00")), 4.0)  # вторник

    def test_idle_fee_is_not_energy_price(self):
        fee = {"priceType": {"value": "pricePerMinute"}, "value": 5, "taxIncluded": True,
               "timeBasedApplicability": {"fromMinute": 120}}
        t = P.build_tariff([fee, kwh(4.95)], at("2026-11-24T12:00"))
        self.assertEqual(P.current_price(t, at("2026-11-24T12:00")), 4.95)
        self.assertEqual(t["fees"][0]["afterMinutes"], 120)

    def test_tax_handling(self):
        excl = P.build_tariff([kwh(4.0, taxIncluded=False, taxRate=25)], at("2026-11-24T12:00"))
        self.assertEqual(excl["default"], 5.0)
        self.assertIsNone(P.build_tariff([{"priceType": {"value": "pricePerKWh"}, "value": 4}], at("2026-11-24T12:00")))

    def test_not_yet_valid_price_ignored(self):
        future = kwh(1.0, overallPeriod={"overallStartTime": "2030-01-01T00:00:00Z"})
        t = P.build_tariff([future, kwh(3.0)], at("2026-11-24T12:00"))
        self.assertEqual(t["default"], 3.0)

    def test_status_rate_update_overrides_table(self):
        point = {"energyRate": [{"idG": "r", "ratePolicy": {"value": "adHoc"},
                                 "applicableCurrency": ["SEK"], "energyPrice": [kwh(3)]}]}
        now = at("2026-11-24T12:00")
        self.assertEqual(P.current_price(P.point_tariff(point, {}, now), now), 3)
        update = {"energyRateUpdate": [{"energyRateReference": {"idG": "r"}, "energyPrice": [kwh(2)]}]}
        self.assertEqual(P.current_price(P.point_tariff(point, update, now), now), 2)


class RealDataTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.static = json.loads((FIXTURES / "tables.json").read_text(encoding="utf-8"))
        cls.dynamic = json.loads((FIXTURES / "statuses.json").read_text(encoding="utf-8"))

    def stations(self, when):
        return {s["name"]: s for s in P.parse(self.static, self.dynamic, at(when))}

    def test_all_locations_found(self):
        found = {s["location"] for s in self.stations("2026-11-24T12:00").values()}
        self.assertEqual(found, set(P.LOCATIONS))

    def test_day_and_night_prices(self):
        day, night = self.stations("2026-11-24T12:00"), self.stations("2026-11-24T03:00")
        self.assertEqual(day["Solna Centrum DC"]["price"], 4.95)
        self.assertEqual(night["Solna Centrum DC"]["price"], 3.45)
        self.assertEqual(day["Barkarby DC"]["price"], 4.95)
        self.assertEqual(self.stations("2026-11-24T23:30")["Barkarby DC"]["price"], 3.49)

    def test_station_details(self):
        s = self.stations("2026-11-24T12:00")["Nacka Strand DC"]
        self.assertEqual((s["kind"], s["kw"], s["total"], s["free"]), ("DC", 300, 4, 3))
        self.assertAlmostEqual(s["lat"], 59.3157, places=3)
        names = set(self.stations("2026-11-24T12:00"))
        self.assertEqual(len(names), 8)
        for other in ["Solna Centrum", "Flygfyren 50KW DC", "Värmdö Marknad P1-P12", "Värmdö Lastbilsladdning"]:
            self.assertNotIn(other, names)

    def test_empty_input(self):
        self.assertEqual(P.parse({}, {}, at("2026-11-24T12:00")), [])


class HistoryTest(unittest.TestCase):
    def test_append_trim_and_new_sites(self):
        now = at("2026-11-24T12:00")
        old = {"v": 2, "sites": ["a"], "names": {}, "rows": [[int(now.timestamp()) - 400 * 86400, [1], [1]]]}
        stations = [{"id": "b", "name": "B", "price": 3.0, "free": 2},
                    {"id": "a", "name": "A", "price": 4.0, "free": 1}]
        h = P.update_history(old, stations, now)
        self.assertEqual(h["sites"], ["a", "b"])
        self.assertEqual(h["rows"], [[int(now.timestamp()), [4.0, 3.0], [1, 2]]])


if __name__ == "__main__":
    unittest.main()
