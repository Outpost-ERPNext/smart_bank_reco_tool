import re
import itertools
from frappe.utils import date_diff, getdate

try:
    from rapidfuzz import fuzz as _fuzz
    def _fuzzy(a, b):
        return _fuzz.token_sort_ratio(a, b)
except ImportError:
    import difflib
    def _fuzzy(a, b):
        return int(difflib.SequenceMatcher(None, a, b).ratio() * 100)

WEIGHTS = {
    "amount": 0.35,
    "reference": 0.25,
    "date": 0.15,
    "party": 0.10,
    "side": 0.08,
    "history": 0.07,
}

AMOUNT_TOLERANCE_PCT = 0.01  # 1%
DATE_WINDOW = 5  # days

_STRIP_PREFIX = re.compile(r"^(NIP|NEFT|RTGS|CHQ|STMP)[/-]?", re.I)


class SignalCalculator:
    def __init__(self, pattern_store=None, amount_tolerance_pct=None, date_window=None):
        self.pattern_store = pattern_store
        self.amount_tolerance_pct = (amount_tolerance_pct or AMOUNT_TOLERANCE_PCT) / 100.0 if amount_tolerance_pct else AMOUNT_TOLERANCE_PCT
        self.date_window = date_window or DATE_WINDOW

    def score_all(self, txn, candidates):
        bank_amount = float(txn.get("deposit") or txn.get("withdrawal") or 0)
        is_credit = bool(txn.get("deposit"))
        scored = []

        for entry in candidates:
            signals = self._signals(txn, entry, bank_amount, is_credit)
            confidence = self._confidence(signals)
            if confidence < 10:
                continue
            scored.append(self._build_result(entry, signals, confidence))

        # Try 1:Many subset-sum
        subset = self._subset_sum(txn, bank_amount, candidates)
        if subset and len(subset) > 1:
            sig = self._subset_signals(txn, subset, is_credit)
            conf = self._confidence(sig)
            scored.append({
                "name": f"1:Many({len(subset)})",
                "entry_type": "Payment Entry",
                "confidence": round(conf, 1),
                "signals": sig,
                "match_type": "1:Many",
                "reasoning": f"Sum of {len(subset)} Payment Entries equals bank amount",
                "entries": subset,
                "amount": bank_amount,
            })

        scored.sort(key=lambda x: x["confidence"], reverse=True)
        return scored

    def _signals(self, txn, entry, bank_amount, is_credit):
        return {
            "amount": self._amount(bank_amount, float(entry.get("amount") or 0), entry.get("entry_type")),
            "reference": self._reference(txn.get("reference_number") or "", entry),
            # Use pre-parsed _date objects when available (set by matching_engine.run())
            "date": self._date(
                txn.get("_date") or txn.get("date"),
                entry.get("_date") or entry.get("posting_date") or entry.get("cheque_date"),
            ),
            "party": self._party(txn, entry),
            "side": self._side(is_credit, entry),
            "history": self._history(txn, entry),
        }

    def _confidence(self, signals):
        return sum(signals[s] * WEIGHTS[s] for s in WEIGHTS)

    def _amount(self, bank, erp, entry_type=None):
        if not bank or not erp:
            return 0
        if abs(bank - erp) < 0.01:
            return 100
        if entry_type in ("Sales Invoice", "Purchase Invoice") and bank < erp:
            return 70  # Partial payment gives a solid baseline, but needs reference/party to push to Auto/Review
        pct = abs(bank - erp) / max(bank, erp)
        if pct <= self.amount_tolerance_pct:
            return 95
        if pct <= 0.05:
            return max(0, 100 - pct * 1000)
        return 0

    def _reference(self, bank_ref, entry):
        if not bank_ref:
            return 0
        clean = _STRIP_PREFIX.sub("", bank_ref).strip()
        erp_refs = [
            str(entry.get("reference_no") or ""),
            str(entry.get("cheque_no") or ""),
        ]
        for r in erp_refs:
            if not r:
                continue
            if bank_ref.upper() == r.upper():
                return 100
            if clean and clean.upper() == r.upper():
                return 95
            if clean and (clean.upper() in r.upper() or r.upper() in clean.upper()):
                return 70
        return 0

    def _date(self, bank_date, erp_date):
        if not bank_date or not erp_date:
            return 50
        # Accept pre-parsed date objects (set by matching_engine) or raw strings
        diff = abs(date_diff(bank_date, erp_date))
        if diff == 0:
            return 100
        if diff == 1:
            return 90
        if diff <= self.date_window:
            return max(0, 100 - diff * 15)
        return 0

    def _party(self, txn, entry):
        a = (txn.get("party") or txn.get("description") or "").strip().upper()
        b = (entry.get("party") or entry.get("pay_to_recd_from") or "").strip().upper()
        if not a or not b:
            return 50
        if a == b:
            return 100  # exact match — skip expensive fuzzy
        return _fuzzy(a, b)

    def _side(self, is_credit, entry):
        if entry.get("entry_type") == "Payment Entry":
            ptype = entry.get("payment_type") or ""
            if is_credit and ptype == "Receive":
                return 100
            if not is_credit and ptype == "Pay":
                return 100
            return 0
        return 80  # JE — neutral

    def _history(self, txn, entry):
        if not self.pattern_store:
            return 0
        party = entry.get("party") or ""
        amount = float(txn.get("deposit") or txn.get("withdrawal") or 0)
        description = txn.get("description") or ""
        # User approval/rejection patterns take precedence over recurring check
        boost = self.pattern_store.get_pattern_boost(party, description)
        if boost != 0:
            return boost
        return 100 if self.pattern_store.is_recurring(party, amount) else 0

    def _build_result(self, entry, signals, confidence):
        hist = signals["history"]
        # Infer match type
        if signals["amount"] == 100 and signals["reference"] >= 95:
            mtype = "1:1 Exact"
        elif hist >= 110:
            mtype = "Approved Pattern"
        elif hist == 100:
            mtype = "Recurring"
        elif signals["amount"] >= 95:
            mtype = "Fuzzy"
        else:
            mtype = "Partial"

        # Build reasoning
        parts = []
        if signals["amount"] == 100:
            parts.append("Exact amount match")
        elif signals["amount"] >= 95:
            parts.append("Amount within 1% tolerance")
        if signals["reference"] >= 95:
            parts.append("Reference number matches")
        if signals["date"] >= 90:
            parts.append("Same posting date")
        if signals["party"] >= 80:
            parts.append(f"Party match {int(signals['party'])}%")
        if hist >= 150:
            parts.append("Approved 3+ times by users")
        elif hist >= 110:
            parts.append("Previously approved by user")
        elif hist == 100:
            parts.append("Recurring pattern (6-month history)")
        elif hist < 0:
            parts.append("Previously rejected by user")

        return {
            "name": entry["name"],
            "entry_type": entry["entry_type"],
            "confidence": round(confidence, 1),
            "signals": signals,
            "match_type": mtype,
            "reasoning": ". ".join(parts) or "Low confidence match",
            "entries": [entry],
            "amount": entry.get("amount"),
            "party": entry.get("party"),
            "party_type": entry.get("party_type") or "",
            "posting_date": entry.get("posting_date") or entry.get("cheque_date"),
            "payment_type": entry.get("payment_type"),
            "voucher_type": entry.get("voucher_type"),
        }

    def best_for_display(self, txn, candidates):
        """Return the single highest-scoring candidate ignoring the 10% floor.
        Used for Duplicate cards so a best-effort ERP suggestion is always shown."""
        if not candidates:
            return None
        bank_amount = float(txn.get("deposit") or txn.get("withdrawal") or 0)
        is_credit = bool(txn.get("deposit"))
        best = None
        best_conf = -1.0
        for entry in candidates:
            signals = self._signals(txn, entry, bank_amount, is_credit)
            confidence = self._confidence(signals)
            if confidence > best_conf:
                best_conf = confidence
                best = self._build_result(entry, signals, confidence)
        return best

    def _subset_sum(self, txn, bank_amount, candidates):
        if not bank_amount:
            return None
        party = txn.get("party") or ""
        # Skip 1:Many when the bank transaction has no known party — without a
        # party anchor any N amounts could accidentally sum to the bank total,
        # producing false positives for unmatched / aging / charge transactions.
        if not party:
            return None

        # Try Payment Entries first (most common case)
        pe_filtered = [
            c for c in candidates
            if c.get("entry_type") == "Payment Entry"
            and c.get("party") == party
            and float(c.get("amount") or 0) < bank_amount
        ]
        result = self._find_combo(pe_filtered[:15], bank_amount)
        if result:
            return result

        # Fall back to Journal Entries (payroll batches, salary JEs share cheque_no)
        ref = txn.get("reference_number") or ""
        je_filtered = [
            c for c in candidates
            if c.get("entry_type") == "Journal Entry"
            and float(c.get("amount") or 0) < bank_amount
            and (
                c.get("party") == party
                or (ref and ref == (c.get("cheque_no") or c.get("reference_no") or ""))
            )
        ]
        return self._find_combo(je_filtered[:15], bank_amount)

    def _find_combo(self, pool, target):
        for r in range(2, min(6, len(pool) + 1)):
            for combo in itertools.combinations(pool, r):
                total = sum(float(c.get("amount") or 0) for c in combo)
                if abs(total - target) < 0.01:
                    return list(combo)
        return None

    def _subset_signals(self, txn, entries, is_credit):
        return {
            "amount": 100,
            "reference": 50,
            "date": self._date(txn.get("date"), entries[0].get("posting_date")),
            "party": 100 if len(set(e.get("party") for e in entries)) == 1 else 70,
            "side": 100,
            "history": 0,
        }
