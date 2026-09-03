import frappe
from frappe.utils import add_days, date_diff, getdate, nowdate

from .signal_calculator import SignalCalculator
from .duplicate_detector import DuplicateDetector, ErpDuplicateDetector
from .nigerian_rules import NigerianRules
from .draft_generator import DraftGenerator
from .pattern_store import PatternStore

HIGH_VALUE_THRESHOLD = 50_000_000  # NGN 50 million
AGING_DAYS = 10
AUTO_THRESHOLD = 80.0
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
        self._save_index = {}  # txn_name -> values dict, so a later _save() for the
                                # same txn (e.g. the Many:1 pass overriding the main
                                # scoring pass) merges instead of appending a second,
                                # never-applied entry (see _flush_saves).
        # Apply configurable thresholds (fall back to module-level defaults)
        s = settings or {}
        self.auto_threshold  = float(s.get("auto_threshold",  AUTO_THRESHOLD))
        self.review_threshold = float(s.get("review_threshold", REVIEW_THRESHOLD))
        self.high_val_threshold = float(s.get("high_val_threshold", HIGH_VALUE_THRESHOLD))
        self.aging_days = int(s.get("aging_days", AGING_DAYS))
        self.amount_tolerance_pct = float(s.get("amount_tolerance_pct", 1))
        self.date_window_days = int(s.get("date_window_days", 5))

    def run(self):
        from bisect import bisect_left, bisect_right

        txns = self._get_transactions()
        candidates = self._get_candidates()

        # Pre-parse all dates once — avoids O(T×C) repeated getdate() calls in _signals
        for txn in txns:
            txn['_date'] = getdate(txn['date']) if txn.get('date') else None
        for c in candidates:
            raw = c.get('posting_date') or c.get('cheque_date')
            c['_date'] = getdate(raw) if raw else None

        # Split invoice vs PE/JE candidates — they need different amount filtering
        _invoice_types = ('Sales Invoice', 'Purchase Invoice')
        invoice_cands = [c for c in candidates if c.get('entry_type') in _invoice_types]
        pe_je_cands   = [c for c in candidates if c.get('entry_type') not in _invoice_types]

        # Sort PE/JE by amount once for O(log N) binary-search range lookup per transaction
        pe_je_sorted  = sorted(pe_je_cands, key=lambda c: float(c.get('amount') or 0))
        pe_je_amounts = [float(c.get('amount') or 0) for c in pe_je_sorted]

        # Same treatment for invoices, so a tiny transaction doesn't get scored
        # (incl. fuzzy party match) against every outstanding invoice in the range.
        invoice_sorted  = sorted(invoice_cands, key=lambda c: float(c.get('amount') or 0))
        invoice_amounts = [float(c.get('amount') or 0) for c in invoice_sorted]

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

            # Consolidated via the manual Consolidate feature — a human already
            # decided this group's outcome (Review if it matched an existing
            # ERP entry, Unmatched if nothing fit — see
            # _consolidate_via_existing_match). A routine re-run of AI Match
            # All must not re-score it individually, but it also must not
            # force it to "Review": that would silently turn a genuinely
            # unmatched consolidated group into one that reads as pending
            # review, hiding it from the Unmatched tile/queue entirely.
            if txn.get("recon_match_type") == "Consolidated":
                preserved_queue = txn.get("recon_queue") or "Unmatched"
                self._save(txn["name"], queue=preserved_queue)
                txn["recon_queue"] = preserved_queue
                results.append(txn)
                continue

            # Duplicate bank transaction check (run before ERP scoring but don't skip it)
            dup_reason, dup_names = dup_detector.check(txn)

            # Narrow the candidate pool for this transaction before scoring.
            # This reduces the O(T×C) work without changing any match logic.
            bank_amount = float(txn.get('deposit') or txn.get('withdrawal') or 0)
            if bank_amount > 0 and pe_je_amounts:
                # Keep PE/JE within a 10× amount window — very conservative,
                # only excludes entries with wildly mismatched amounts
                lo = bisect_left(pe_je_amounts, bank_amount / 10.0)
                hi = bisect_right(pe_je_amounts, bank_amount * 10.0)
                nearby_pe_je = pe_je_sorted[lo:hi]
            else:
                nearby_pe_je = pe_je_cands

            # Invoices: partial-payment means bank <= invoice outstanding, so the lower
            # bound stays at bank_amount (no partial payment can exceed the invoice).
            # Upper bound mirrors the PE/JE 10x window — a real partial payment is
            # never a tiny fraction of a wildly larger invoice, and without this bound
            # a small transaction (e.g. a bank charge) was scoring against every
            # outstanding invoice in the whole date range.
            if bank_amount > 0 and invoice_amounts:
                lo_inv = bisect_left(invoice_amounts, bank_amount * 0.99)
                hi_inv = bisect_right(invoice_amounts, bank_amount * 10.0)
                rel_invoices = invoice_sorted[lo_inv:hi_inv]
            else:
                rel_invoices = invoice_cands

            txn_candidates = nearby_pe_je + rel_invoices

            # Score pre-filtered ERP candidates
            scored = signal_calc.score_all(txn, txn_candidates)
            nigerian.apply(txn, scored)

            if not scored:
                # No ERP candidate at all — stays Unmatched however old it gets.
                # "Aging" is reserved for transactions that DO have a matched
                # entry (even a weak one) sitting unreconciled past the
                # threshold; a transaction with nothing to show on the ERP
                # side belongs in Unmatched, not Aging.
                queue = "Duplicate" if dup_reason else "Unmatched"
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

                # A reversal with no ERP counterpart still has to be flagged as
                # one so the tool can highlight it and offer to delete the line
                # (nigerian_rules sets _is_reversal on the transaction itself).
                if dup_reason:
                    unmatched_match_type = "Duplicate"
                elif txn.get("_is_reversal"):
                    unmatched_match_type = "Reversal"
                else:
                    unmatched_match_type = None

                self._save(
                    txn["name"],
                    queue=queue,
                    confidence=best_display["confidence"] if best_display else 0,
                    reasoning=best_display["reasoning"] if best_display else reasoning,
                    match_type=unmatched_match_type,
                    matched_entries=frappe.as_json(display_entry_names) if display_entry_names else None,
                    signals_json=frappe.as_json(best_display["signals"]) if best_display else None,
                    draft_payload=draft,
                )
                if unmatched_match_type:
                    txn["recon_match_type"] = unmatched_match_type
                txn["recon_queue"] = queue
                txn["recon_ai_reasoning"] = best_display["reasoning"] if best_display else reasoning
                if dup_names:
                    txn["recon_duplicate_of"] = dup_names
                if draft:
                    txn["recon_draft_payload"] = draft
                if best_display:
                    txn["matched"] = best_display
                    txn["recon_confidence"] = best_display["confidence"]
                    # This block only runs when dup_reason was truthy (best_display
                    # is only ever built inside `if dup_reason and candidates`), so
                    # the in-memory match_type must agree with the DB write above
                    # ("Duplicate") rather than the underlying candidate's own type.
                    txn["recon_match_type"] = "Duplicate"
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
                    # A row forced into Review (reversal, WHT deduction, etc.)
                    # must never display a confidence that reads as "this
                    # should've been Auto" — cap it just under the Auto
                    # threshold so Review is internally consistent regardless
                    # of *why* the match was held back from auto-approval.
                    conf = min(conf, self.auto_threshold - 1)
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
                        # Same reasoning as the _force_review cap above — this
                        # demotion also happens after an Auto-eligible score,
                        # so it needs the same cap to stay consistent.
                        conf = min(conf, self.auto_threshold - 1)

                is_invoice = best.get("entry_type") in ("Sales Invoice", "Purchase Invoice")
                draft = draft_gen.build(txn, best_invoice=best) if is_invoice else None

                # Queue already forces "Duplicate" above when dup_reason is set —
                # match_type must agree, not keep the underlying candidate's own
                # type (e.g. "1:1 Exact"), otherwise the two fields contradict
                # each other in the DB and in exports.
                match_type = "Duplicate" if dup_reason else (
                    best.get("match_type") or ("Partial Invoice Payment" if is_invoice else None)
                )

                # What actually gets stored as this transaction's matched entry.
                # Three cases deliberately store nothing:
                #   - queue "Unmatched": the best candidate scored below the
                #     review threshold, i.e. too weak to call a match at all.
                #     Storing it anyway made the Unmatched tile/tab display a
                #     "Matched ERP Entry" link (and several same-amount rows all
                #     pointing at the one same entry), which contradicts what
                #     Unmatched means and blocked them from being consolidated.
                #   - invoice matches: a bank transaction can't be reconciled
                #     against an invoice directly (see approve_match), so no
                #     entry is stored for it.
                # An empty string — not None — is required to actually clear the
                # field: _save skips None ("leave as-is"), which would otherwise
                # leave a stale entry name from an earlier run in place.
                store_entries = (
                    "" if (queue == "Unmatched" or is_invoice)
                    else frappe.as_json(entry_names)
                )
                self._save(
                    txn["name"],
                    queue=queue,
                    confidence=conf,
                    matched_entries=store_entries,
                    match_type=match_type,
                    reasoning=best.get("reasoning"),
                    signals_json=frappe.as_json(best.get("signals", {})),
                    wht_amount=best.get("wht_amount"),
                    draft_payload=draft,
                )
                txn["recon_queue"] = queue
                txn["recon_confidence"] = conf
                if dup_names:
                    txn["recon_duplicate_of"] = dup_names
                if draft:
                    txn["recon_draft_payload"] = draft
                txn["recon_match_type"] = match_type
                txn["recon_ai_reasoning"] = best.get("reasoning")
                # Keep the in-memory row in lockstep with what was written, so
                # the table this run returns shows the same thing a reload would.
                # The invoice suggestion itself is not lost — it still reaches the
                # AI Match Pairs card through txn["matched"] below, along with the
                # draft payload that drives "Create PE" for it.
                txn["recon_matched_entries"] = store_entries
                txn["matched"] = best

            results.append(txn)

        self._process_many_to_one(results, candidates)
        self._flush_saves()
        return results

    def get_queue_counts(self, results):
        from collections import Counter
        # A consolidated group is one economic event and renders as one row, so
        # it must count once — otherwise the Total tile reports more
        # transactions than the table shows (the "753 instead of 751" report).
        # Reuses api's helper so this and the non-AI table load can never drift
        # apart on what a group counts as. Imported locally: api imports this
        # module at import time, so a module-level import would be circular.
        from .api import _dedupe_consolidated_groups
        results = _dedupe_consolidated_groups(results)
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
        if len(unmatched_txns) < 2:
            return

        # Pre-compute total so we can skip ERP entries that exceed what the
        # bank transactions could ever sum to — cheap O(U) guard.
        total_unmatched = sum(
            float(t.get("deposit") or t.get("withdrawal") or 0) for t in unmatched_txns
        )

        # Invoices are matched in the main scoring loop; only PE/JE can be
        # split across multiple bank transactions as Many:1.
        _inv_types = ("Sales Invoice", "Purchase Invoice")
        pe_je_candidates = [c for c in candidates if c.get("entry_type") not in _inv_types]

        for entry in pe_je_candidates:
            erp_amount = float(entry.get("amount") or 0)
            if not erp_amount or erp_amount > total_unmatched:
                continue

            # Use pre-parsed _date when available (set by run()) to avoid repeated getdate()
            erp_date = entry.get("_date") or getdate(entry.get("posting_date") or entry.get("cheque_date"))
            if not erp_date:
                continue

            valid_txns = []
            for t in unmatched_txns:
                amt = float(t.get("deposit") or t.get("withdrawal") or 0)
                if amt >= erp_amount:
                    continue
                t_date = t.get("_date") or getdate(t.get("date"))
                if t_date and abs(date_diff(erp_date, t_date)) <= 7:
                    valid_txns.append(t)

            if len(valid_txns) < 2:
                continue

            # Cap at 15: C(15,2)+C(15,3)=560 vs C(40,2)+C(40,3)=10,660 — 19× reduction
            if len(valid_txns) > 15:
                valid_txns.sort(key=lambda x: abs(date_diff(erp_date, x.get("_date") or getdate(x.get("date")))))
                valid_txns = valid_txns[:15]

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
                            # Mirror the write in-memory too, so the table this
                            # run returns shows the Many:1 matched entry instead
                            # of only revealing it after a reload.
                            t["recon_matched_entries"] = frappe.as_json([entry["name"]])
                            self._save(
                                t["name"],
                                queue="Review",
                                confidence=85.0,
                                matched_entries=frappe.as_json([entry["name"]]),
                                match_type="Many:1",
                                reasoning=t["recon_ai_reasoning"],
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
                "recon_match_type", "recon_confidence", "recon_matched_entries",
                "recon_ai_reasoning", "recon_queue",
                # Consolidation group key. The frontend collapses a consolidated
                # group into a single row keyed on this, so it has to survive the
                # AI-match response too — without it, running AI Match silently
                # broke groups back apart into their individual member rows.
                "recon_run_id",
            ],
            order_by="date asc",
        )

    def _get_candidates(self):
        # Expand search window 30 days beyond the statement range to catch late-posted entries
        date_from = add_days(getdate(self.from_date), -30)
        date_to   = add_days(getdate(self.to_date),   30)

        # Resolve the GL account linked to the selected bank account so we can
        # restrict candidates to entries that actually touched this bank account.
        gl_account = frappe.db.get_value("Bank Account", self.bank_account, "account") or ""

        if not gl_account:
            return []

        # Payment Entries — only those where money moved through this bank's GL account.
        # "Receive" payments: paid_to = company bank GL; "Pay" payments: paid_from = company bank GL.
        pe_rows = frappe.db.sql(
            """
            SELECT name, payment_type, party_type, party, party_name,
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
            SELECT name, name as reference_no, posting_date, customer as party, customer_name,
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
            si["name"] = si["reference_no"]
            si["party_name"] = si.get("customer_name")

        pi_list = frappe.db.sql(
            """
            SELECT name, name as reference_no, posting_date, supplier as party, supplier_name,
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
            pi["name"] = pi["reference_no"]
            pi["party_name"] = pi.get("supplier_name")

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

        # A transaction can be saved more than once in a single run (e.g. the
        # main scoring pass, then re-classified by _process_many_to_one). The
        # CASE-WHEN built in _flush_saves only honors the FIRST matching WHEN
        # for a given name, so a second append would be silently ignored on
        # write even though it correctly overwrote the in-memory result —
        # merge into the existing entry instead so the last call always wins.
        existing = self._save_index.get(txn_name)
        if existing is not None:
            existing.update(values)
        else:
            entry = dict(values)
            self._save_batch.append((txn_name, entry))
            self._save_index[txn_name] = entry

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
