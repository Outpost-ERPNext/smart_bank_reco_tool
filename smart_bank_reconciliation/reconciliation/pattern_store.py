import re
import json
import frappe
from frappe.utils import add_months, nowdate

_DESC_STRIP = re.compile(r'[^a-zA-Z ]')


class PatternStore:
    def __init__(self):
        self._patterns_cache = None   # loaded once per engine run
        self._recurring_cache = None  # populated lazily in is_recurring
    def is_recurring(self, party, amount, months=6):
        if not party or not amount:
            return False

        # Load all recurring parties in a single query to avoid N+1 full table scans
        if self._recurring_cache is None:
            since = add_months(nowdate(), -months)
            parties = frappe.db.sql("""
                SELECT party
                FROM `tabBank Transaction`
                WHERE status = 'Reconciled'
                  AND date >= %s
                  AND party IS NOT NULL
                  AND party != ''
                GROUP BY party
                HAVING count(name) >= 3
            """, (since,))
            self._recurring_cache = {p[0]: True for p in parties}

        return self._recurring_cache.get(party, False)

    # ------------------------------------------------------------------
    # Pattern learning helpers
    # ------------------------------------------------------------------

    def _make_key(self, party, description):
        words = _DESC_STRIP.sub(' ', description or '').lower().split()[:4]
        desc_fp = '_'.join(w for w in words if len(w) > 2)
        return f"{(party or '').strip().lower()}|{desc_fp}"

    def _load(self):
        if self._patterns_cache is None:
            raw = frappe.db.get_default("sbr_patterns")
            try:
                self._patterns_cache = json.loads(raw) if raw else {}
            except Exception:
                self._patterns_cache = {}
        return self._patterns_cache

    def _persist(self, data):
        frappe.db.set_default("sbr_patterns", json.dumps(data))

    def record_approval(self, party, description):
        data = self._load()
        key = self._make_key(party, description)
        entry = data.get(key, {"approved": 0, "rejected": 0})
        entry["approved"] = entry.get("approved", 0) + 1
        data[key] = entry
        self._persist(data)

    def record_rejection(self, party, description):
        data = self._load()
        key = self._make_key(party, description)
        entry = data.get(key, {"approved": 0, "rejected": 0})
        entry["rejected"] = entry.get("rejected", 0) + 1
        data[key] = entry
        self._persist(data)

    def get_pattern_boost(self, party, description):
        """
        Returns a signal value in the -200..+150 range based on historical
        user approvals/rejections for this party+description fingerprint.
        0 means no history found.
        """
        data = self._load()
        key = self._make_key(party, description)
        entry = data.get(key)
        if not entry:
            return 0
        approved = entry.get("approved", 0)
        rejected = entry.get("rejected", 0)
        if rejected >= 2:
            return -200  # 0.07 weight → −14 pts: push below any threshold
        if rejected >= 1 and approved == 0:
            return -100  # → −7 pts: soft suppress
        if approved >= 3:
            return 150   # → +10.5 pts: strong boost
        if approved >= 1:
            return 110   # → +7.7 pts: soft boost (distinct from is_recurring's 100)
        return 0
