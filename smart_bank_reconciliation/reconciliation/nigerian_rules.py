import re

WHT_RATES = [0.05, 0.10]
WHT_TOLERANCE = 500  # NGN rounding buffer

_COT = re.compile(r"\bZ?COT\b|\bCOMMISSION ON TURNOVER\b", re.I)
_FIRS = re.compile(r"\bFIRS\b|\bFEDERAL INLAND REVENUE\b|\bTIN\b", re.I)
_REVERSAL = re.compile(r"\bREVERSAL\b|\bREVERSED\b|\bCHQ.?RETURN\b|\bBOUNCE\b", re.I)
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

        # Reversal / bounce — route to Review regardless of confidence
        if _REVERSAL.search(desc) and scored:
            scored[0]["match_type"] = "Reversal"
            scored[0]["_force_review"] = True

    def _apply_wht(self, txn, best):
        erp_amount = float(best.get("amount") or 0)
        bank_amount = float(txn.get("deposit") or txn.get("withdrawal") or 0)
        if not erp_amount or not bank_amount:
            return
        diff = abs(erp_amount - bank_amount)
        for rate in WHT_RATES:
            expected_wht = erp_amount * rate
            if abs(diff - expected_wht) <= WHT_TOLERANCE:
                best["match_type"] = f"Partial (WHT {int(rate * 100)}%)"
                best["wht_amount"] = expected_wht
                best["reasoning"] = (
                    (best.get("reasoning") or "")
                    + f" [WHT {int(rate*100)}%: NGN {expected_wht:,.2f} deducted]"
                )
                # Cap confidence — always needs human review for WHT
                best["confidence"] = min(float(best.get("confidence") or 0), 87.0)
                best["_force_review"] = True
                return
