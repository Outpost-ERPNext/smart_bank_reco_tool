import re

WHT_RATES = [0.05, 0.10]
# Tolerance scales with the expected WHT amount instead of a flat NGN figure —
# a flat buffer that's fine for a six-figure invoice (rounding noise) swamps a
# small transaction entirely, making an exact 1:1 match (diff=0) look like a
# "5% WHT deducted" match purely because 0 falls within the flat window.
WHT_REL_TOLERANCE_PCT = 0.02   # accept rounding noise up to 2% of the expected WHT
WHT_MIN_TOLERANCE = 5          # floor, so tiny WHT amounts still allow for kobo rounding
WHT_MAX_TOLERANCE = 500        # cap, matching the old flat buffer for large invoices

_COT = re.compile(r"\bZ?COT\b|\bCOMMISSION ON TURNOVER\b", re.I)
_FIRS = re.compile(r"\bFIRS\b|\bFEDERAL INLAND REVENUE\b|\bTIN\b", re.I)
_REVERSAL = re.compile(r"\bREVERSAL\b|\bREVERSED\b|\bRSVL\b|\bCHQ.?RETURN\b|\bBOUNCE\b", re.I)
_INTEREST = re.compile(r"\bINTEREST\b|\bCREDIT INT\b|\bINTEREST CREDIT\b", re.I)
_PAYROLL = re.compile(r"\bSALARY\b|\bPAYROLL\b|\bSTAFF\b", re.I)


class NigerianRules:
    def apply(self, txn, scored):
        desc = (txn.get("description") or "").upper()
        ref = (txn.get("reference_number") or "").upper()

        if scored:
            self._apply_wht(txn, scored[0])

        # Stamp duty: NGN 50 debit with STMP- ref
        if txn.get("withdrawal") == 50 and ref.startswith("STMP-"):
            parent_ref = ref[5:]
            if scored:
                scored[0]["reasoning"] = (
                    (scored[0].get("reasoning") or "")
                    + f" [Stamp Duty NGN 50 for NIP credit {parent_ref}]"
                )
            else:
                txn["_draft_hint"] = "STAMP_DUTY"

        # COT — hint for draft JE
        if _COT.search(desc) and not scored:
            txn["_draft_hint"] = "COT"

        # Interest credit — hint for draft JE
        if _INTEREST.search(desc) and txn.get("deposit") and not scored:
            txn["_draft_hint"] = "INTEREST_CREDIT"

        # FIRS statutory — small confidence boost
        if _FIRS.search(desc) and scored:
            scored[0]["confidence"] = min(100, scored[0]["confidence"] + 5)
            scored[0]["reasoning"] = (
                (scored[0].get("reasoning") or "")
                + " [FIRS statutory payment detected]"
            )

        # Reversal / bounce. Flagged on the transaction itself, not only on a
        # matched candidate — a reversal with no ERP counterpart is exactly the
        # case that needs surfacing (it's usually money that never really moved
        # and the line may need deleting), and gating the flag behind `scored`
        # meant those went completely unmarked.
        if _REVERSAL.search(desc):
            txn["_is_reversal"] = True
            if scored:
                # Route to Review regardless of confidence
                scored[0]["match_type"] = "Reversal"
                scored[0]["_force_review"] = True

    def _apply_wht(self, txn, best):
        erp_amount = float(best.get("amount") or 0)
        bank_amount = float(txn.get("deposit") or txn.get("withdrawal") or 0)
        if not erp_amount or not bank_amount:
            return
        diff = abs(erp_amount - bank_amount)
        if diff < 0.01:
            return  # exact amount match — nothing was withheld, not a WHT case
        # Evaluate every configured rate and pick whichever is the CLOSEST fit
        # (smallest residual from its expected WHT amount), not just the
        # first one whose tolerance window happens to contain diff — for
        # small invoices the 5%/10% windows can overlap, and first-match-wins
        # would mislabel an exact 10% deduction as 5%.
        best_rate = None
        best_residual = None
        best_expected_wht = None
        for rate in WHT_RATES:
            expected_wht = erp_amount * rate
            tolerance = min(WHT_MAX_TOLERANCE, max(WHT_MIN_TOLERANCE, expected_wht * WHT_REL_TOLERANCE_PCT))
            residual = abs(diff - expected_wht)
            if residual <= tolerance and (best_residual is None or residual < best_residual):
                best_rate = rate
                best_residual = residual
                best_expected_wht = expected_wht

        if best_rate is not None:
            best["match_type"] = f"Partial (WHT {int(best_rate * 100)}%)"
            best["wht_amount"] = best_expected_wht
            best["reasoning"] = (
                (best.get("reasoning") or "")
                + f" [WHT {int(best_rate*100)}%: NGN {best_expected_wht:,.2f} deducted]"
            )
            # Cap confidence — always needs human review for WHT
            best["confidence"] = min(float(best.get("confidence") or 0), 87.0)
            best["_force_review"] = True
