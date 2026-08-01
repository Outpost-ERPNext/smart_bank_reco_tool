import re
import frappe

_COT = re.compile(r"\bZ?COT\b|\bCOMMISSION ON TURNOVER\b", re.I)
_INTEREST = re.compile(r"\bINTEREST\b|\bCREDIT INT\b", re.I)
_TRANSFER = re.compile(r"\bTRANSFER\b|\bTRF\b|\bFOREX\b|\bFX\b", re.I)
_STAMP = re.compile(r"\bSTMP\b|\bSTAMP DUTY\b", re.I)


class DraftGenerator:
    def build(self, txn):
        desc = txn.get("description") or ""
        ref = txn.get("reference_number") or ""
        amount = float(txn.get("deposit") or txn.get("withdrawal") or 0)
        date_str = str(txn.get("date") or "")
        hint = txn.get("_draft_hint") or ""

        if hint == "COT" or _COT.search(desc):
            return frappe.as_json({
                "entry_type": "JE",
                "voucher_type": "Bank Entry",
                "debit_account": "Bank Charges",
                "credit_account": txn.get("bank_account"),
                "amount": amount,
                "narration": f"Bank COT charges - {ref}",
                "cheque_no": ref,
                "posting_date": date_str,
            })

        if hint == "INTEREST_CREDIT" or (_INTEREST.search(desc) and txn.get("deposit")):
            return frappe.as_json({
                "entry_type": "JE",
                "voucher_type": "Bank Entry",
                "debit_account": txn.get("bank_account"),
                "credit_account": "Interest Income",
                "amount": amount,
                "narration": f"Bank interest credit - {ref}",
                "posting_date": date_str,
            })

        if hint == "STAMP_DUTY" or _STAMP.search(desc) or ref.upper().startswith("STMP-"):
            return frappe.as_json({
                "entry_type": "JE",
                "voucher_type": "Bank Entry",
                "debit_account": "Bank Charges",
                "credit_account": txn.get("bank_account"),
                "amount": 50,
                "narration": f"Stamp duty - {ref}",
                "posting_date": date_str,
            })

        if _TRANSFER.search(desc):
            return frappe.as_json({
                "entry_type": "JE",
                "voucher_type": "Contra Entry",
                "amount": amount,
                "narration": f"Inter-bank transfer - {ref}",
                "posting_date": date_str,
            })

        # Unknown credit → PE Receive to suspense
        if txn.get("deposit"):
            return frappe.as_json({
                "entry_type": "PE",
                "payment_type": "Receive",
                "received_amount": amount,
                "party_type": "Customer",
                "party": txn.get("party") or "Suspense",
                "paid_to": txn.get("bank_account"),
                "reference_no": ref,
                "posting_date": date_str,
                "remarks": desc,
            })

        # Unknown debit → PE Pay
        return frappe.as_json({
            "entry_type": "PE",
            "payment_type": "Pay",
            "paid_amount": amount,
            "party_type": "Supplier",
            "party": txn.get("party") or "Suspense",
            "paid_from": txn.get("bank_account"),
            "reference_no": ref,
            "posting_date": date_str,
            "remarks": desc,
        })
