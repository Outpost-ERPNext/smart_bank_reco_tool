import frappe
from frappe.utils import add_days, date_diff, getdate, nowdate

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

            # Duplicate bank transaction check (run before ERP scoring but don't skip it)
            dup_reason = dup_detector.check(txn)

            # Score all ERP candidates
            scored = signal_calc.score_all(txn, candidates)
            nigerian.apply(txn, scored)

            if not scored:
                queue = "Duplicate" if dup_reason else ("Aging" if self._is_aging(txn) else "Unmatched")
                reasoning = dup_reason or "No matching ERP entry found"
                draft = None if dup_reason else draft_gen.build(txn)

                # For duplicate transactions always surface the best ERP candidate
                # for display — even when confidence is below the 10% scoring floor.
                # This populates the two-column card view and pre-selects the entry
                # in the "Match Against Voucher" modal without affecting reconciliation.
                best_display = None
                if dup_reason and candidates:
                    best_display = signal_calc.best_for_display(txn, candidates)
                    if best_display:
                        best_display["reasoning"] = dup_reason + (
                            " — " + best_display["reasoning"] if best_display.get("reasoning") else ""
                        )

                display_entry_names = (
                    [e["name"] for e in best_display.get("entries", [best_display])]
                    if best_display else None
                )

                self._save(
                    txn["name"],
                    queue=queue,
                    confidence=best_display["confidence"] if best_display else 0,
                    reasoning=best_display["reasoning"] if best_display else reasoning,
                    match_type="Duplicate" if dup_reason else None,
                    matched_entries=frappe.as_json(display_entry_names) if display_entry_names else None,
                    signals_json=frappe.as_json(best_display["signals"]) if best_display else None,
                    draft_payload=draft,
                )
                txn["recon_queue"] = queue
                txn["recon_ai_reasoning"] = best_display["reasoning"] if best_display else reasoning
                if draft:
                    txn["recon_draft_payload"] = draft
                if best_display:
                    txn["matched"] = best_display
                    txn["recon_confidence"] = best_display["confidence"]
                    txn["recon_match_type"] = best_display.get("match_type", "")
                    txn["recon_matched_entries"] = frappe.as_json(display_entry_names)
            else:
                best = scored[0]
                conf = best["confidence"]
                bank_amount = float(txn.get("deposit") or txn.get("withdrawal") or 0)

                if dup_reason:
                    # Always Duplicate queue regardless of confidence; prepend duplicate warning
                    queue = "Duplicate"
                    best["reasoning"] = dup_reason + (" — " + best["reasoning"] if best.get("reasoning") else "")
                elif best.get("_force_review"):
                    queue = "Review"
                elif conf >= self.auto_threshold:
                    queue = "High-Val" if bank_amount > self.high_val_threshold else "Auto"
                elif conf >= self.review_threshold:
                    queue = "Review"
                elif self._is_aging(txn):
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

                is_invoice = best.get("entry_type") in ("Sales Invoice", "Purchase Invoice")
                draft = draft_gen.build(txn, best_invoice=best) if is_invoice else None

                self._save(
                    txn["name"],
                    queue=queue,
                    confidence=conf,
                    matched_entries=frappe.as_json(entry_names) if not is_invoice else None,
                    match_type=best.get("match_type") or ("Partial Invoice Payment" if is_invoice else None),
                    reasoning=best.get("reasoning"),
                    signals_json=frappe.as_json(best.get("signals", {})),
                    wht_amount=best.get("wht_amount"),
                    draft_payload=draft,
                )
                txn["recon_queue"] = queue
                txn["recon_confidence"] = conf
                if draft:
                    txn["recon_draft_payload"] = draft
                txn["recon_match_type"] = best.get("match_type")
                txn["recon_ai_reasoning"] = best.get("reasoning")
                txn["recon_matched_entries"] = frappe.as_json(entry_names)
                txn["matched"] = best

            results.append(txn)

        self._process_many_to_one(results, candidates)
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

    def _process_many_to_one(self, results, candidates):
        from itertools import combinations
        from frappe.utils import getdate, date_diff

        unmatched_txns = [t for t in results if t.get("recon_queue") in ("Unmatched", "Aging")]
        if not unmatched_txns:
            return

        for entry in candidates:
            erp_amount = float(entry.get("amount") or 0)
            if not erp_amount:
                continue

            erp_date = getdate(entry.get("posting_date") or entry.get("cheque_date"))
            if not erp_date:
                continue

            valid_txns = []
            for t in unmatched_txns:
                t_date = getdate(t.get("date"))
                if t_date and abs(date_diff(erp_date, t_date)) <= 7:
                    valid_txns.append(t)

            if len(valid_txns) < 2:
                continue

            match_found = False
            for r in (2, 3):
                for combo in combinations(valid_txns, r):
                    is_credit = bool(combo[0].get("deposit"))
                    if not all(bool(t.get("deposit")) == is_credit for t in combo):
                        continue
                    
                    sum_amount = sum(float(t.get("deposit") or t.get("withdrawal") or 0) for t in combo)
                    if abs(sum_amount - erp_amount) < 0.01:
                        for t in combo:
                            t["recon_queue"] = "Review"
                            t["recon_match_type"] = "Many:1"
                            t["recon_ai_reasoning"] = f"Part of a {r}-transaction group matching {entry.get('entry_type')} {entry.get('reference_no', entry.get('name'))}"
                            t["recon_confidence"] = 85.0
                            
                            is_invoice = entry.get("entry_type") in ("Sales Invoice", "Purchase Invoice")
                            draft = None
                            if is_invoice:
                                # We need to build a draft Payment Entry for this specific bank transaction
                                # against the matched Invoice.
                                from .draft_generator import DraftGenerator
                                draft = DraftGenerator().build(t, best_invoice=entry)
                                t["recon_draft_payload"] = draft
                            
                            self._save(
                                t["name"],
                                queue="Review",
                                confidence=85.0,
                                matched_entries=frappe.as_json([entry["name"]]) if not is_invoice else None,
                                match_type="Many:1",
                                reasoning=t["recon_ai_reasoning"],
                                draft_payload=draft
                            )
                            if t in unmatched_txns:
                                unmatched_txns.remove(t)
                        match_found = True
                        break
                if match_found:
                    break

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
        # Expand search window 60 days beyond the statement range to catch late-posted entries
        date_from = add_days(getdate(self.from_date), -60)
        date_to   = add_days(getdate(self.to_date),   60)

        # Resolve the GL account linked to the selected bank account so we can
        # restrict candidates to entries that actually touched this bank account.
        gl_account = frappe.db.get_value("Bank Account", self.bank_account, "account") or ""

        if not gl_account:
            return []

        # Payment Entries — only those where money moved through this bank's GL account.
        # "Receive" payments: paid_to = company bank GL; "Pay" payments: paid_from = company bank GL.
        pe_rows = frappe.db.sql(
            """
            SELECT name, payment_type, party_type, party,
                   paid_amount, received_amount, posting_date,
                   reference_no, paid_to, paid_from, remarks
            FROM `tabPayment Entry`
              WHERE company = %s
              AND docstatus = 1
              AND (clearance_date IS NULL OR clearance_date = '0000-00-00')
              AND payment_type IN ('Receive', 'Pay')
              AND posting_date BETWEEN %s AND %s
              AND (paid_to = %s OR paid_from = %s)
            ORDER BY posting_date DESC
            """,
            (self.company, date_from, date_to, gl_account, gl_account),
            as_dict=True,
        )

        pe_list = list(pe_rows)
        for pe in pe_list:
            pe["entry_type"] = "Payment Entry"
            pe["amount"] = float(pe.get("received_amount") or pe.get("paid_amount") or 0)

        # Journal Entries — only those that have at least one account row touching
        # this bank's GL account (e.g. bank charges, salary JEs, petty cash).
        je_list = frappe.db.sql(
            """
            SELECT je.name, je.voucher_type, je.posting_date, je.cheque_no,
                   je.cheque_date, je.total_debit, je.total_credit, je.remark
            FROM `tabJournal Entry` je
            INNER JOIN `tabJournal Entry Account` jea ON jea.parent = je.name
            WHERE je.company = %s
              AND je.docstatus = 1
              AND (je.clearance_date IS NULL OR je.clearance_date = '0000-00-00')
              AND je.posting_date BETWEEN %s AND %s
              AND jea.account = %s
            GROUP BY je.name
            ORDER BY je.posting_date DESC
            """,
            (self.company, date_from, date_to, gl_account),
            as_dict=True,
        )

        je_list = list(je_list)
        for je in je_list:
            je["entry_type"] = "Journal Entry"
            je["amount"] = float(je.get("total_debit") or je.get("total_credit") or 0)

        return pe_list + je_list + self._get_invoice_candidates(date_from, date_to)

    def _get_invoice_candidates(self, date_from, date_to):
        si_list = frappe.db.sql(
            """
            SELECT name as reference_no, posting_date, customer as party,
                   outstanding_amount as amount, grand_total, title, po_no as secondary_ref, remarks
            FROM `tabSales Invoice`
            WHERE company = %s
              AND docstatus = 1
              AND outstanding_amount > 0
              AND posting_date BETWEEN %s AND %s
            ORDER BY posting_date DESC
            """,
            (self.company, date_from, date_to),
            as_dict=True,
        )
        for si in si_list:
            si["entry_type"] = "Sales Invoice"
            si["party_type"] = "Customer"

        pi_list = frappe.db.sql(
            """
            SELECT name as reference_no, posting_date, supplier as party,
                   outstanding_amount as amount, grand_total, title, bill_no as secondary_ref, remarks
            FROM `tabPurchase Invoice`
            WHERE company = %s
              AND docstatus = 1
              AND outstanding_amount > 0
              AND posting_date BETWEEN %s AND %s
            ORDER BY posting_date DESC
            """,
            (self.company, date_from, date_to),
            as_dict=True,
        )
        for pi in pi_list:
            pi["entry_type"] = "Purchase Invoice"
            pi["party_type"] = "Supplier"

        return list(si_list) + list(pi_list)

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
