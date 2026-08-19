class DuplicateDetector:
    def __init__(self, all_txns):
        self.seen_exact = {}   # (amount, reference, date) → [names]
        self.seen_soft  = {}   # (amount, date, party)    → [names]  — fuzzy fallback
        for txn in all_txns:
            exact_key = self._exact_key(txn)
            self.seen_exact.setdefault(exact_key, []).append(txn["name"])

            soft_key = self._soft_key(txn)
            if soft_key:
                self.seen_soft.setdefault(soft_key, []).append(txn["name"])

    def _exact_key(self, txn):
        # Side (deposit vs withdrawal) is part of the fingerprint — a debit and
        # its equal-and-opposite reversal credit share the same amount/ref/date
        # by design (same NIP session reversed), but they're two distinct real
        # transactions, not the same one posted twice.
        side = "D" if txn.get("deposit") else "W"
        amount = round(float(txn.get("deposit") or txn.get("withdrawal") or 0), 2)
        return (
            side,
            str(amount),
            str(txn.get("reference_number") or ""),
            str(txn.get("date") or ""),
        )

    def _soft_key(self, txn):
        """Party + amount + date — catches same-day same-amount from same party
        even when NIP session IDs differ by a digit (common bank error)."""
        party = (txn.get("party") or "").strip()
        if not party:
            return None
        side = "D" if txn.get("deposit") else "W"
        amount = round(float(txn.get("deposit") or txn.get("withdrawal") or 0), 2)
        return (side, party, str(amount), str(txn.get("date") or ""))

    def check(self, txn):
        """Returns (reasoning, duplicate_names) — (None, []) when no duplicate found.
        duplicate_names is the raw list of other Bank Transaction names this txn
        duplicates, so callers can group/link a pair in the UI instead of relying
        on parsing the reasoning text."""
        # 1. Exact match (same ref + amount + date)
        exact_key = self._exact_key(txn)
        others = [n for n in self.seen_exact.get(exact_key, []) if n != txn["name"]]
        if others:
            return (
                f"Possible duplicate of {', '.join(others)} — "
                "same amount, reference, and date",
                others,
            )

        # 2. Soft match (same party + amount + date, different reference)
        soft_key = self._soft_key(txn)
        if soft_key:
            soft_others = [n for n in self.seen_soft.get(soft_key, []) if n != txn["name"]]
            if soft_others:
                return (
                    f"Possible duplicate of {', '.join(soft_others)} — "
                    "same party, amount, and date (reference numbers differ — likely bank error)",
                    soft_others,
                )
        return None, []


class ErpDuplicateDetector:
    """Detects duplicate ERP entries (PE/JE) among unreconciled candidates.

    Two ERP entries are considered duplicates when they share the same
    party + amount + posting_date + reference (or ref + amount + date when
    no party is set). This catches accidental double-submissions like
    the S-20 scenario (ACC-PAY-2025-0041B).
    """

    def __init__(self, candidates):
        self._dupes = set()
        seen = {}
        for c in candidates:
            key = self._make_key(c)
            if not key:
                continue
            prev = seen.get(key)
            if prev:
                self._dupes.add(prev)
                self._dupes.add(c["name"])
            else:
                seen[key] = c["name"]

    def _make_key(self, entry):
        amount = round(float(entry.get("amount") or 0), 2)
        if not amount:
            return None
        party = (entry.get("party") or "").strip().lower()
        date = str(entry.get("posting_date") or entry.get("cheque_date") or "")
        ref = (entry.get("reference_no") or entry.get("cheque_no") or "").strip().lower()
        # Require at least party+date or ref+date — bare amount alone causes false positives
        if party and date:
            return ("p", party, str(amount), date, ref)
        if ref and date:
            return ("r", ref, str(amount), date)
        return None

    def check_entries(self, entry_names):
        """Return a warning string if any named ERP entry has an identical twin, else None."""
        dupes = [n for n in entry_names if n in self._dupes]
        if not dupes:
            return None
        return (
            f"Matched ERP entr{'ies' if len(dupes) > 1 else 'y'} "
            f"{', '.join(dupes)} may be a duplicate — "
            "another ERP entry with the same party, amount, and date exists. "
            "Please verify before approving."
        )
