import frappe
from frappe.utils import date_diff, getdate, nowdate

from .signal_calculator import SignalCalculator
from .duplicate_detector import DuplicateDetector, ErpDuplicateDetector
from .nigerian_rules import NigerianRules
from .draft_generator import DraftGenerator
from .pattern_store import PatternStore

HIGH_VALUE_THRESHOLD = 50_000_000  # NGN 50 million
AGING_DAYS = 10
AUTO_THRESHOLD = 90.0
REVIEW_THRESHOLD = 50.0


class BankMatchingEngine:
    def __init__(self, bank_account, from_date, to_date, company, settings=None, only_names=None):
        self.bank_account = bank_account
        self.from_date = from_date
        self.to_date = to_date
        self.company = company
        self.only_names = only_names
        self.pattern_store = PatternStore()
        self._save_batch = []
        # Apply configurable thresholds (fall back to module-level defaults)
        s = settings or {}
        self.auto_threshold  = float(s.get("auto_threshold",  AUTO_THRESHOLD))
        self.review_threshold = float(s.get("review_threshold", REVIEW_THRESHOLD))
        self.high_val_threshold = float(s.get("high_val_threshold", HIGH_VALUE_THRESHOLD))
        self.aging_days = int(s.get("aging_days", AGING_DAYS))
        self.amount_tolerance_pct = float(s.get("amount_tolerance_pct", 1))
        self.date_window_days = int(s.get("date_window_days", 5))

    def run(self):
        txns = self._get_transactions()
        candidates = self._get_candidates()

        dup_detector = DuplicateDetector(txns)
        erp_dup_detector = ErpDuplicateDetector(candidates)
        signal_calc = SignalCalculator(
            self.pattern_store,
            amount_tolerance_pct=getattr(self, "amount_tolerance_pct", None),
            date_window=getattr(self, "date_window_days", None),
        )
        nigerian = NigerianRules()
        draft_gen = DraftGenerator()

        results = []

        for txn in txns:
            txn = dict(txn)  # make mutable copy

            # Already fully reconciled — preserve existing recon_confidence (don't overwrite with 0)
            if (txn.get("status") == "Reconciled"
                    or float(txn.get("unallocated_amount") or 0) == 0):
                self._save(txn["name"], queue="Reconciled")
                txn["recon_queue"] = "Reconciled"
                results.append(txn)
                continue

            # Duplicate bank transaction
            dup_reason = dup_detector.check(txn)
            if dup_reason:
                self._save(txn["name"], queue="Duplicate", confidence=0,
                           reasoning=dup_reason, match_type="Duplicate")
                txn["recon_queue"] = "Duplicate"
                txn["recon_ai_reasoning"] = dup_reason
                results.append(txn)
                continue

            # Score all ERP candidates
            scored = signal_calc.score_all(txn, candidates)
            nigerian.apply(txn, scored)

            if not scored:
                is_aging = self._is_aging(txn)
                queue = "Aging" if is_aging else "Unmatched"
                draft = draft_gen.build(txn)
                self._save(txn["name"], queue=queue, confidence=0,
                           reasoning="No matching ERP entry found",
                           draft_payload=draft)
                txn["recon_queue"] = queue
                txn["recon_draft_payload"] = draft
            else:
                best = scored[0]
                conf = best["confidence"]
                bank_amount = float(txn.get("deposit") or txn.get("withdrawal") or 0)

                # Force Review override (WHT, Reversal)
                if best.get("_force_review"):
                    queue = "Review"
                elif conf >= self.auto_threshold:
                    queue = "High-Val" if bank_amount > self.high_val_threshold else "Auto"
                elif conf >= self.review_threshold:
                    queue = "Review"
                elif self._is_aging(txn):
                    # Old transaction with no strong match → Aging, not Unmatched
                    queue = "Aging"
                else:
                    queue = "Unmatched"

                # Check if the matched ERP entry has an accidental twin in ERP
                entry_names = [e["name"] for e in best.get("entries", [best])]
                erp_dup_warn = erp_dup_detector.check_entries(entry_names)
                if erp_dup_warn:
                    best["reasoning"] = (
                        (best.get("reasoning") or "") + ". ⚠ " + erp_dup_warn
                    ).lstrip(". ")
                    if queue not in ("Review", "High-Val", "Duplicate"):
                        queue = "Review"

                self._save(
                    txn["name"],
                    queue=queue,
                    confidence=conf,
                    matched_entries=frappe.as_json(entry_names),
                    match_type=best.get("match_type"),
                    reasoning=best.get("reasoning"),
                    signals_json=frappe.as_json(best.get("signals", {})),
                    wht_amount=best.get("wht_amount"),
                )
                txn["recon_queue"] = queue
                txn["recon_confidence"] = conf
                txn["recon_match_type"] = best.get("match_type")
                txn["recon_ai_reasoning"] = best.get("reasoning")
                txn["matched"] = best

            results.append(txn)

        self._flush_saves()
        return results

    def get_queue_counts(self, results):
        from collections import Counter
        counts = Counter(t.get("recon_queue") or "Unmatched" for t in results)
        return {
            "total": len(results),
            "auto": counts.get("Auto", 0),
            "review": counts.get("Review", 0),
            "unmatched": counts.get("Unmatched", 0),
            "high_val": counts.get("High-Val", 0),
            "duplicate": counts.get("Duplicate", 0),
            "aging": counts.get("Aging", 0),
            "reconciled": counts.get("Reconciled", 0),
        }

    def _get_transactions(self):
        filters = {
            "bank_account": self.bank_account,
            "date": ["between", [self.from_date, self.to_date]],
            "docstatus": 1,
        }
        if self.only_names:
            filters["name"] = ["in", self.only_names]
        return frappe.db.get_all(
            "Bank Transaction",
            filters=filters,
            fields=[
                "name", "date", "deposit", "withdrawal", "description",
                "reference_number", "party_type", "party", "bank_account",
                "status", "unallocated_amount",
            ],
            order_by="date asc",
        )

    def _get_candidates(self):
        pe_list = frappe.db.get_all(
            "Payment Entry",
            filters={
                "company": self.company,
                "docstatus": 1,
                "clearance_date": ["is", "not set"],
                "payment_type": ["in", ["Receive", "Pay"]],
            },
            fields=[
                "name", "payment_type", "party_type", "party",
                "paid_amount", "received_amount", "posting_date",
                "reference_no", "paid_to", "paid_from", "remarks",
            ],
            order_by="posting_date desc",
            limit=500,
        )
        for pe in pe_list:
            pe["entry_type"] = "Payment Entry"
            pe["amount"] = float(pe.get("received_amount") or pe.get("paid_amount") or 0)

        je_list = frappe.db.get_all(
            "Journal Entry",
            filters={
                "company": self.company,
                "docstatus": 1,
                "clearance_date": ["is", "not set"],
            },
            fields=[
                "name", "voucher_type", "posting_date", "cheque_no",
                "cheque_date", "total_debit", "total_credit", "remark",
            ],
            order_by="posting_date desc",
            limit=300,
        )
        for je in je_list:
            je["entry_type"] = "Journal Entry"
            je["amount"] = float(je.get("total_debit") or je.get("total_credit") or 0)

        return pe_list + je_list

    def _is_aging(self, txn):
        days = date_diff(nowdate(), getdate(txn["date"]))
        return days > self.aging_days

    def _save(self, txn_name, queue, confidence=None, matched_entries=None,
              match_type=None, reasoning=None, draft_payload=None,
              signals_json=None, wht_amount=None):
        values = {"recon_queue": queue}
        if confidence is not None:
            values["recon_confidence"] = confidence
        if matched_entries is not None:
            values["recon_matched_entries"] = matched_entries
        if match_type is not None:
            values["recon_match_type"] = match_type
        if reasoning is not None:
            values["recon_ai_reasoning"] = reasoning
        if draft_payload is not None:
            values["recon_draft_payload"] = draft_payload
        if signals_json is not None:
            values["recon_signals_json"] = signals_json
        if wht_amount is not None:
            values["recon_wht_amount"] = wht_amount
        self._save_batch.append((txn_name, values))

    def _flush_saves(self):
        """Write all accumulated saves in one bulk SQL query instead of N set_value calls."""
        if not self._save_batch:
            return

        all_fields = [
            "recon_queue", "recon_confidence", "recon_matched_entries",
            "recon_match_type", "recon_ai_reasoning", "recon_draft_payload",
            "recon_signals_json", "recon_wht_amount",
        ]
        names = [name for name, _ in self._save_batch]
        in_placeholders = ", ".join(["%s"] * len(names))

        set_parts = []
        params = []

        for field in all_fields:
            case_whens = []
            field_params = []
            for name, values in self._save_batch:
                if field in values:
                    case_whens.append("WHEN %s THEN %s")
                    field_params.extend([name, values[field]])
            if case_whens:
                set_parts.append(
                    f"`{field}` = CASE `name` " + " ".join(case_whens) + f" ELSE `{field}` END"
                )
                params.extend(field_params)

        if not set_parts:
            return

        params.extend(names)
        frappe.db.sql(
            "UPDATE `tabBank Transaction` SET " + ", ".join(set_parts) +
            f" WHERE `name` IN ({in_placeholders})",
            params
        )
