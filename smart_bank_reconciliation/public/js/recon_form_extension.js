/* recon_form_extension.js
   Loaded via doctype_js hook — runs only on Bank Reconciliation Tool form.

   Default state : load raw transactions (no AI) when filters are filled.
   AI Match All  : run matching engine → update confidence badges + show AI tab.
*/

// Suppress native ERPNext reconciliation UI immediately via CSS injection.
(function sbr_suppress_native_css() {
  if (document.getElementById("sbr-suppress-native")) return;
  var style = document.createElement("style");
  style.id = "sbr-suppress-native";
  style.textContent =
    '[data-fieldname="reconciliation_tool_cards"],' +
    '[data-fieldname="reconciliation_tool_dt"],' +
    '[data-fieldname="no_bank_transactions"]' +
    "{ display: none !important; }";
  document.head.appendChild(style);
})();

// ── AI Result Persistence ─────────────────────────────────────────────────
// Results are saved to localStorage keyed by (bank_account, from_date, to_date).
// On page reload the same filters are restored from the form, so we can
// re-hydrate the canvas without re-running the engine.

function sbr_get_storage_key(frm) {
  var ba = frm.doc.bank_account;
  var fd = frm.doc.bank_statement_from_date;
  var td = frm.doc.bank_statement_to_date;
  if (!ba || !fd || !td) return null;
  return "sbr_c_" + ba.replace(/\W/g, "_") + "_" + fd + "_" + td;
}

function sbr_save_ai_cache(frm, data) {
  var key = sbr_get_storage_key(frm);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify({
      data: {
        transactions:  data.transactions,
        suggestions:   data.suggestions,
        queue_counts:  data.queue_counts,
      },
      saved_at: Date.now(),
    }));
  } catch (e) {} // ignore QuotaExceededError
}

function sbr_clear_ai_cache(frm) {
  var key = sbr_get_storage_key(frm);
  if (key) localStorage.removeItem(key);
}

function sbr_inject_unmatched_suggestions(data) {
  if (!data || !data.transactions) return;
  data.suggestions = data.suggestions || [];
  
  var suggMap = {};
  data.suggestions.forEach(function(s) {
    if (s.bank_txn) suggMap[s.bank_txn] = true;
  });
  
  data.transactions.forEach(function(t) {
    if (t.recon_queue === "Reconciled") return;
    if (suggMap[t.name]) return; // Already present
    
    var q_raw = t.recon_queue || "Unmatched";
    var queue = (["Auto", "Review", "Unmatched", "High-Val", "Duplicate", "Aging", "Reconciled"].indexOf(q_raw) === -1) ? "Unmatched" : q_raw;
    var entryNames = [];
    if (t.recon_matched_entries) {
      try {
        entryNames = typeof t.recon_matched_entries === "string"
          ? JSON.parse(t.recon_matched_entries) : (t.recon_matched_entries || []);
      } catch (e) { entryNames = []; }
    }
    var mType = t.recon_match_type || (entryNames.length > 1 ? "1:Many" : "1:1");
    var firstName = entryNames[0] || "";
    var nUp = firstName.toUpperCase();
    var entryType = nUp.indexOf("-JV-") !== -1 ? "Journal Entry" : "Payment Entry";
    var txnAmt = parseFloat(t.withdrawal || 0) || parseFloat(t.deposit || 0);

    data.suggestions.push({
      bank_txn:    t.name,
      date:        t.date || "",
      deposit:     t.deposit || 0,
      withdrawal:  t.withdrawal || 0,
      description: t.description || "",
      party:       t.party || "",
      queue:       queue,
      confidence:  parseFloat(t.recon_confidence) || 0,
      matched: entryNames.length ? {
        name:       firstName,
        match_type: mType,
        entry_type: entryType,
        amount:     txnAmt,
        entries:    entryNames.map(function (n) { return { name: n }; }),
      } : null,
    });
  });
}

var _sbr_filter_timer = null;
function sbr_debounce_filter_load(frm) {
  if (_sbr_filter_timer) clearTimeout(_sbr_filter_timer);
  _sbr_filter_timer = setTimeout(function () {
    _sbr_filter_timer = null;
    if (frm.doc.bank_account && frm.doc.bank_statement_from_date && frm.doc.bank_statement_to_date) {
      sbr_load_transactions(frm);
    }
  }, 700);
}

function sbr_restore_from_cache(frm, $canvas) {
  if (!$canvas) return;
  // Skip if the engine is running or a transaction table is already rendered
  if (frm._sbr_ai_running || $canvas.find(".sbr-table").length) return;

  var key = sbr_get_storage_key(frm);
  if (!key) return;

  var raw = localStorage.getItem(key);
  if (!raw) return;

  var saved;
  try { saved = JSON.parse(raw); } catch (e) { localStorage.removeItem(key); return; }
  if (!saved || !saved.data || !(saved.data.transactions || []).length) return;

  var data = saved.data;

  $canvas.html('<div class="sbr-panel-inner"></div>');
  sbr_bind_card_actions(frm, $canvas);

  ReconUI.renderSummaryTiles($canvas, data.queue_counts);
  ReconUI.renderTabShell($canvas, (data.transactions || []).length);
  ReconUI.renderTransactionTable($canvas, data.transactions);
  ReconUI.updateTabBadge($canvas, "bank", (data.transactions || []).length);
  sbr_inject_unmatched_suggestions(data);
  ReconUI.renderSuggestionsPanel($canvas, data.suggestions);
  ReconUI.renderAIBanner($canvas, data.queue_counts);
  ReconUI.filterByQueue($canvas, null);
  ReconUI.switchTab($canvas, "bank");

  frm._sbr_ai_done        = true;
  frm._sbr_auto_count     = (data.queue_counts || {}).auto   || 0;
  frm._sbr_review_count   = (data.queue_counts || {}).review || 0;
  sbr_build_toolbar(frm);
  frm.page.set_indicator(__("Done"), "green");

  // Refresh lightweight live data in background (balances, ERP vouchers, aging alerts)
  var ba = frm.doc.bank_account;
  var fd = frm.doc.bank_statement_from_date;
  var td = frm.doc.bank_statement_to_date;
  var co = frm.doc.company || "";

  frappe.call({
    method: "smart_bank_reconciliation.reconciliation.api.get_balance_summary",
    args: { bank_account: ba, from_date: fd, to_date: td, company: co },
    callback: function (br) {
      if (br.exc) return;
      var erp_closing  = parseFloat((br.message || {}).erp_closing || 0);
      var bank_closing = parseFloat(frm.doc.bank_statement_closing_balance || 0);
      $canvas.data("sbr-erp-closing", erp_closing);
      ReconUI.renderBalanceSummary($canvas, {
        bank_closing: bank_closing, erp_closing: erp_closing, difference: bank_closing - erp_closing,
      });
    },
  });
  frappe.call({
    method: "smart_bank_reconciliation.reconciliation.api.get_erp_vouchers",
    args: { bank_account: ba, from_date: fd, to_date: td },
    callback: function (er) {
      if (!er.exc) { ReconUI.renderERPVouchersTab($canvas, (er.message || {}).vouchers || []); }
    },
  });
  frappe.call({
    method: "smart_bank_reconciliation.reconciliation.api.get_aging_erp_entries",
    args: { bank_account: ba, from_date: fd, to_date: td, company: co },
    callback: function (ar) {
      if (!ar.exc && ar.message && (ar.message.entries || []).length) {
        ReconUI.renderAgingErpAlerts($canvas, ar.message.entries, ar.message.aging_days);
      }
    },
  });
}
// ─────────────────────────────────────────────────────────────────────────────

frappe.ui.form.on("Bank Reconciliation Tool", {

  onload: function (frm) {
    // Completely nullify standard ERPNext fetch so it never races with our fetch
    if (frappe.ui.form.handlers["Bank Reconciliation Tool"]) {
        frappe.ui.form.handlers["Bank Reconciliation Tool"]["get_account_opening_balance"] = [];
    }
    if (frm.events) {
        frm.events["get_account_opening_balance"] = [];
    }
    sbr_set_defaults(frm);
    sbr_schedule_erp_default_load(frm);
  },

  refresh: function (frm) {
    frm.disable_save();

    // Hide only the native reconciliation tool widgets; keep balance fields visible.
    // filter_by_reference_date / from_reference_date / to_reference_date / account_currency
    // don't exist pre-v14 — set_df_property no-ops safely when the field is absent,
    // so this list is safe to run unconditionally on v13.
    // filter_by_reference_date in particular must be hidden, not just cosmetic: its
    // native v15 handler clears bank_statement_from_date/to_date when checked, which
    // are the two fields SBR's own data loading depends on.
    ["reconciliation_tool_cards", "reconciliation_tool_dt", "no_bank_transactions",
     "filter_by_reference_date", "from_reference_date", "to_reference_date",
    ].forEach(function (f) { frm.set_df_property(f, "hidden", 1); });

    // Make account_opening_balance read-only (auto-fetched from GL)
    frm.set_df_property("account_opening_balance", "read_only", 1);
    frm.set_df_property("account_opening_balance", "hidden", 0);
    frm.set_df_property("bank_statement_closing_balance", "hidden", 0);

    // Clarify which side each balance represents
    frm.set_df_property("account_opening_balance",      "label", __("Opening Balance as per ERP (GL)"));
    frm.set_df_property("bank_statement_closing_balance", "label", __("Closing Balance (Bank)"));

    // Hide "Reconcile" section header — two-pass for reliability
    frm.layout && frm.layout.sections && frm.layout.sections.forEach(function (sec) {
      if (sec.df && sec.df.fieldname === "section_break_1") {
        sec.$wrapper && sec.$wrapper.find(".section-head").hide();
      }
    });
    setTimeout(function () {
      frm.$wrapper.find(".section-head").each(function () {
        if ($(this).text().trim() === "Reconcile") { $(this).hide(); }
      });
    }, 300);
    frm.upload_statement_button && frm.upload_statement_button.hide();

    // Resolve currency early (covers page reload where bank_account is already
    // set, e.g. restored filter state) so cached-result rendering below uses
    // the right symbol instead of the fallback.
    sbr_resolve_currency(frm);

    // Fetch opening balance if both bank_account and from_date are set
    sbr_fetch_opening_balance(frm);

    sbr_build_toolbar(frm);

    var $canvas = frm.fields_dict.recon_ui_container
      ? frm.fields_dict.recon_ui_container.$wrapper : null;
    if ($canvas) {
      if (!$canvas.find(".sbr-tiles, .sbr-tab-bar, .sbr-loading").length) {
        $canvas.html('<div class="sbr-panel-inner"></div>');
        ReconUI.renderTabShell($canvas, 0);
        sbr_render_inline_upload(frm, $canvas);
      }
      sbr_bind_card_actions(frm, $canvas);
      // Restore AI results from localStorage if available (bank_account may already be set)
      sbr_restore_from_cache(frm, $canvas);
    }
  },

  // Fetch opening balance and auto-reload data whenever filters change
  company: function (frm) {
    sbr_save_filter_state(frm);
  },

  bank_account: function (frm) {
    sbr_save_filter_state(frm);
    // Clear stale closing balance from a previous account
    frm.doc.bank_statement_closing_balance = 0;
    frm.refresh_field("bank_statement_closing_balance");
    sbr_resolve_currency(frm);
    sbr_update_balance_bar(frm);
    sbr_fetch_opening_balance(frm);
    sbr_debounce_filter_load(frm);
  },

  bank_statement_from_date: function (frm) {
    sbr_save_filter_state(frm);
    sbr_fetch_opening_balance(frm);
    sbr_debounce_filter_load(frm);
  },

  bank_statement_to_date: function (frm) {
    sbr_save_filter_state(frm);
    sbr_debounce_filter_load(frm);
  },

  // When user edits the bank closing balance, refresh the balance bar immediately
  bank_statement_closing_balance: function (frm) {
    sbr_update_balance_bar(frm);
  }

});

/* ── Resolve the selected bank account's actual currency (not hardcoded Naira) ──
   Same Bank Account -> Account -> account_currency chain ERPNext's own stock
   bank_reconciliation_tool.js uses in both v13 (frm.currency) and v15
   (frm.doc.account_currency) — but resolved independently here so SBR doesn't
   depend on which of those two version-specific properties actually got set. */
function sbr_resolve_currency(frm, cb) {
  if (!frm.doc.bank_account) return;
  if (frm._sbr_currency_account === frm.doc.bank_account) { if (cb) cb(); return; }
  frappe.db.get_value("Bank Account", frm.doc.bank_account, "account", function (r) {
    if (!r || !r.account) { if (cb) cb(); return; }
    frappe.db.get_value("Account", r.account, "account_currency", function (r2) {
      frm._sbr_currency_account = frm.doc.bank_account;
      ReconUI.setCurrency(r2 && r2.account_currency);
      if (cb) cb();
    });
  });
}

/* ── Persist filter selections across page refreshes ── */
var SBR_FILTER_KEY = "sbr_filter_state";

function sbr_save_filter_state(frm) {
  try {
    localStorage.setItem(SBR_FILTER_KEY, JSON.stringify({
      company:    frm.doc.company || "",
      bank_account: frm.doc.bank_account || "",
      from_date:  frm.doc.bank_statement_from_date || "",
      to_date:    frm.doc.bank_statement_to_date || "",
    }));
  } catch (e) {}
}

function sbr_load_filter_state() {
  try {
    var raw = localStorage.getItem(SBR_FILTER_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
}

/* ── Set default field values on first load ── */
function sbr_set_defaults(frm) {
  // Write directly to frm.doc + refresh_field to avoid triggering change handlers
  // (frm.set_value triggers bank_account/date change → sbr_debounce_load → auto-loads data)

  var saved = sbr_load_filter_state();

  if (saved && (saved.company || saved.bank_account || saved.from_date)) {
    // Saved state always wins — Frappe pre-populates frm.doc.company before onload,
    // so we must unconditionally overwrite, not just fill empty fields.
    if (saved.company) {
      frm.doc.company = saved.company;
      frm.refresh_field("company");
    }
    if (saved.bank_account) {
      frm.doc.bank_account = saved.bank_account;
      frm.refresh_field("bank_account");
    }
    if (saved.from_date) {
      frm.doc.bank_statement_from_date = saved.from_date;
      frm.refresh_field("bank_statement_from_date");
    }
    if (saved.to_date) {
      frm.doc.bank_statement_to_date = saved.to_date;
      frm.refresh_field("bank_statement_to_date");
    }
    return;
  }

  // No saved state — apply initial defaults

  // Dates: from = 1st of last month, to = today
  if (!frm.doc.bank_statement_from_date) {
    var today = new Date();
    var firstOfLastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    function pad(n) { return n < 10 ? "0" + n : "" + n; }
    function toISO(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
    frm.doc.bank_statement_from_date = toISO(firstOfLastMonth);
    frm.doc.bank_statement_to_date   = toISO(today);
    frm.refresh_field("bank_statement_from_date");
    frm.refresh_field("bank_statement_to_date");
  }

  // Company: use Frappe user default
  var company = frm.doc.company || frappe.defaults.get_default("company");
  if (!frm.doc.company && company) {
    frm.doc.company = company;
    frm.refresh_field("company");
  }

  // Bank account: pick the first company bank account (silent — no change event)
  if (!frm.doc.bank_account && company) {
    frappe.call({
      method: "frappe.client.get_list",
      args: {
        doctype: "Bank Account",
        filters: { company: company, is_company_account: 1 },
        fields: ["name"],
        order_by: "creation asc",
        limit_page_length: 1,
      },
      callback: function (r) {
        if (r.message && r.message.length) {
          frm.doc.bank_account = r.message[0].name;
          frm.refresh_field("bank_account");
        }
      },
    });
  }
}

/* ── Fetch Account Opening Balance from ERP GL ── */
function sbr_fetch_opening_balance(frm) {
  var bank_account = frm.doc.bank_account;
  var from_date    = frm.doc.bank_statement_from_date;
  if (!bank_account || !from_date) return;

  frappe.call({
    method: "smart_bank_reconciliation.reconciliation.api.get_account_opening_balance",
    args: { bank_account: bank_account, from_date: from_date },
    callback: function (r) {
      if (!r.exc) {
        frm.set_value("account_opening_balance", r.message || 0);
      }
    },
  });
}

/* ── Refresh the balance bar inside the custom panel ── */
function sbr_update_balance_bar(frm) {
  var $canvas = frm.fields_dict.recon_ui_container
    ? frm.fields_dict.recon_ui_container.$wrapper : null;
  if (!$canvas || !$canvas.find(".sbr-balance-bar").length) return;

  var erp_closing = $canvas.data("sbr-erp-closing") || 0;
  var bank_closing = parseFloat(frm.doc.bank_statement_closing_balance || 0);

  ReconUI.renderBalanceSummary($canvas, {
    bank_closing: bank_closing,
    erp_closing:  erp_closing,
    difference:   bank_closing - erp_closing,
  });
}

/* ── Auto-load ERP Vouchers on form open (polls until bank_account + tab shell are ready) ── */
function sbr_schedule_erp_default_load(frm) {
  var attempts = 0;
  function check() {
    if (frm._sbr_erp_default_loaded) return;
    attempts++;
    var bank_account = frm.doc.bank_account;
    var from_date    = frm.doc.bank_statement_from_date;
    var to_date      = frm.doc.bank_statement_to_date;
    var $canvas = frm.fields_dict.recon_ui_container
      ? frm.fields_dict.recon_ui_container.$wrapper : null;
    var tabReady = $canvas && $canvas.find('.sbr-tab-content[data-tab="erp"]').length > 0;
    if (bank_account && from_date && to_date && tabReady) {
      frm._sbr_erp_default_loaded = true;
      // Try to restore cached AI results now that all filters and the tab shell are confirmed ready.
      // This catches the case where bank_account was set asynchronously after refresh() ran.
      sbr_restore_from_cache(frm, $canvas);
      frappe.call({
        method: "smart_bank_reconciliation.reconciliation.api.get_erp_vouchers",
        args: { bank_account: bank_account, from_date: from_date, to_date: to_date },
        callback: function (er) {
          if (!er.exc) {
            ReconUI.renderERPVouchersTab($canvas, (er.message || {}).vouchers || []);
          }
        },
      });
    } else if (attempts < 25) {
      setTimeout(check, 200);
    }
  }
  setTimeout(check, 150);
}

/* ── Load ERP Vouchers into tab (called after fetch or CSV import) ── */
function sbr_load_erp_vouchers_default(frm, $canvas) {
  var bank_account = frm.doc.bank_account;
  var from_date    = frm.doc.bank_statement_from_date;
  var to_date      = frm.doc.bank_statement_to_date;
  if (!bank_account || !from_date || !to_date) return;
  if (!$canvas) {
    $canvas = frm.fields_dict.recon_ui_container
      ? frm.fields_dict.recon_ui_container.$wrapper : null;
  }
  if (!$canvas) return;
  frappe.call({
    method: "smart_bank_reconciliation.reconciliation.api.get_erp_vouchers",
    args: { bank_account: bank_account, from_date: from_date, to_date: to_date },
    callback: function (er) {
      if (!er.exc) {
        ReconUI.renderERPVouchersTab($canvas, (er.message || {}).vouchers || []);
      }
    },
  });
}

/* ── Build toolbar (called on refresh and after AI state change) ── */
function sbr_build_toolbar(frm) {
  frm.page.clear_inner_toolbar();
  frm.page.add_inner_button(__("Fetch Transactions"), function () {
    sbr_load_transactions(frm);
  });
  frm.page.add_inner_button(__("↺ Reset AI"), function () {
    if (!frm.doc.bank_account || !frm.doc.bank_statement_from_date || !frm.doc.bank_statement_to_date) {
      frappe.msgprint(__("Please set Bank Account and date range first."));
      return;
    }
    frappe.confirm(
      __("Clear all AI suggestions for this period?<br><br>Reconciled transactions will not be affected. You can re-run AI Match All after resetting."),
      function () {
        frappe.call({
          method: "smart_bank_reconciliation.reconciliation.api.reset_ai_suggestions",
          args: {
            bank_account: frm.doc.bank_account,
            from_date:    frm.doc.bank_statement_from_date,
            to_date:      frm.doc.bank_statement_to_date,
          },
          callback: function (r) {
            if (r.exc) return;
            frm._sbr_ai_done = false;
            sbr_clear_ai_cache(frm); // remove persisted results for this period
            sbr_build_toolbar(frm);
            frm._sbr_no_auto_ai = true; // reset should never trigger auto AI
            sbr_load_transactions(frm);
            frappe.show_alert({ message: __("AI suggestions cleared. Run AI Match All to re-analyse."), indicator: "orange" });
          },
        });
      }
    );
  });
  frm.page.add_inner_button(__("Upload Statement"), function () {
    var $canvas = frm.fields_dict.recon_ui_container
      ? frm.fields_dict.recon_ui_container.$wrapper : null;
    sbr_open_upload_modal(frm, $canvas);
  });
  frm.page.add_inner_button(__("Consolidate Bank Charges"), function () {
    sbr_open_bank_charges_modal(frm);
  }, __("Consolidate"));
  frm.page.add_inner_button(__("Consolidate Transactions"), function () {
    sbr_open_consolidate_transactions_modal(frm);
  }, __("Consolidate"));
  frm.page.add_inner_button(__("Report"), function () {
    ReconUI.renderReportModal(frm);
  }, __("More"));
  frm.page.add_inner_button(__("⚙ Settings"), function () {
    frappe.call({
      method: "smart_bank_reconciliation.reconciliation.api.get_sbr_settings",
      callback: function (r) {
        ReconUI.openSettingsModal(r.message || {}, function () {
          // Re-run AI match after settings change if already analyzed
          if (frm._sbr_ai_done) {
            frm._sbr_ai_done = false;
            sbr_build_toolbar(frm);
          }
        });
      },
    });
  }, __("More"));
  var _aiLabel = __("AI Match All");
  var _aiIcon  = "magic";
  if (frm._sbr_ai_running) {
    _aiLabel = __("◌ AI Matching…");
    _aiIcon  = null;
  } else if (frm._sbr_ai_done) {
    _aiLabel = __("✦ AI: Done ✓");
    _aiIcon  = "check";
  }
  frm.page.set_primary_action(_aiLabel, function () {
    if (!frm._sbr_ai_running) sbr_run_suggestions(frm);
  }, _aiIcon);
  if (frm._sbr_ai_running) {
    setTimeout(function () {
      var $btn = frm.page.get_primary_btn();
      if ($btn && $btn.length) { $btn.prop("disabled", true); }
    }, 30);
  }
}

/* ── Load raw transactions (no AI scoring) ── */
function sbr_load_transactions(frm) {
  var bank_account = frm.doc.bank_account;
  var from_date    = frm.doc.bank_statement_from_date;
  var to_date      = frm.doc.bank_statement_to_date;
  if (!bank_account || !from_date || !to_date) return;

  var $canvas = frm.fields_dict.recon_ui_container
    ? frm.fields_dict.recon_ui_container.$wrapper : null;
  if (!$canvas) return;

  // Reset AI state on reload; cancel any in-flight poll
  frm._sbr_ai_done = false;
  frm._sbr_ai_running = false;
  if (frm._sbr_poll_timer) { clearInterval(frm._sbr_poll_timer); frm._sbr_poll_timer = null; }
  sbr_build_toolbar(frm);

  $canvas.html(
    '<div class="sbr-panel-inner">' +
    '<div class="sbr-loading"><div class="sbr-spinner"></div>' +
    "<span>Loading transactions…</span></div></div>"
  );

  frappe.call({
    method: "smart_bank_reconciliation.reconciliation.api.get_bank_transactions",
    args: { bank_account: bank_account, from_date: from_date, to_date: to_date },
    callback: function (r) {
      if (r.exc) return;
      var data = r.message;

      $canvas.html('<div class="sbr-panel-inner"></div>');
      sbr_bind_card_actions(frm, $canvas);

      // Use queue_counts from API to populate tiles (includes prior AI scoring from DB)
      var qCounts = data.queue_counts || { total: data.total || 0 };
      ReconUI.renderSummaryTiles($canvas, qCounts);
      ReconUI.renderTabShell($canvas, data.total || 0);
      if (data.total) {
        ReconUI.renderTransactionTable($canvas, data.transactions);
        ReconUI.filterByQueue($canvas, null);
      } else {
        sbr_render_inline_upload(frm, $canvas);
      }

      // Auto-run fresh AI on every load; skip only after manual Reset AI.
      if (data.total > 0 && !frm._sbr_ai_running && !frm._sbr_no_auto_ai) {
        setTimeout(function() { sbr_run_suggestions(frm); }, 300);
      }
      frm._sbr_no_auto_ai = false;

      // Fetch balance summary in background (non-blocking)
      frappe.call({
        method: "smart_bank_reconciliation.reconciliation.api.get_balance_summary",
        args: {
          bank_account: bank_account,
          from_date:    from_date,
          to_date:      to_date,
          company:      frm.doc.company || "",
        },
        callback: function (br) {
          if (br.exc) return;
          var erp_closing  = parseFloat((br.message || {}).erp_closing || 0);
          var bank_closing = parseFloat(frm.doc.bank_statement_closing_balance || 0);
          // Store ERP closing so the bank_statement_closing_balance trigger can re-use it
          $canvas.data("sbr-erp-closing", erp_closing);
          ReconUI.renderBalanceSummary($canvas, {
            bank_closing: bank_closing,
            erp_closing:  erp_closing,
            difference:   bank_closing - erp_closing,
          });
        },
      });

      // Fetch ERP vouchers in background (non-blocking)
      frappe.call({
        method: "smart_bank_reconciliation.reconciliation.api.get_erp_vouchers",
        args: { bank_account: bank_account, from_date: from_date, to_date: to_date },
        callback: function (er) {
          if (!er.exc) {
            ReconUI.renderERPVouchersTab($canvas, (er.message || {}).vouchers || []);
          }
        },
      });


    },
  });
}

/* ── Run AI matching engine ── */
function sbr_run_suggestions(frm) {
  var bank_account = frm.doc.bank_account;
  var from_date    = frm.doc.bank_statement_from_date;
  var to_date      = frm.doc.bank_statement_to_date;
  var company      = frm.doc.company;

  if (!bank_account || !from_date || !to_date) {
    frappe.msgprint(__("Please fill Bank Account, From Date and To Date first."));
    return;
  }

  var $canvas = frm.fields_dict.recon_ui_container.$wrapper;

  // Build tab shell if table was never loaded
  if (!$canvas.find(".sbr-tab-bar").length) {
    $canvas.html('<div class="sbr-panel-inner"></div>');
    sbr_bind_card_actions(frm, $canvas);
    ReconUI.renderSummaryTiles($canvas, {});
    ReconUI.renderTabShell($canvas, 0);
  }

  // Set running state — button shows ◌ AI Matching…; stay on bank tab so records stay visible
  frm._sbr_ai_running = true;
  frm._sbr_ai_done = false;
  sbr_build_toolbar(frm);
  frm.page.set_indicator(__("Running AI…"), "orange");

  // Prime the AI tab with a spinner without switching to it
  $canvas.find('.sbr-tab-content[data-tab="ai"] .sbr-suggestion-panel').html(
    '<div class="sbr-loading"><div class="sbr-spinner"></div>' +
    "<span>Running matching engine…</span></div>"
  );

  // Start background job — engine runs in an RQ worker, UI polls for completion
  frappe.call({
    method: "smart_bank_reconciliation.reconciliation.api.start_recon_job",
    args: { bank_account: bank_account, from_date: from_date, to_date: to_date, company: company },
    callback: function (r) {
      if (r.exc || !r.message) {
        frm._sbr_ai_running = false;
        sbr_build_toolbar(frm);
        frm.page.set_indicator(__("Error"), "red");
        return;
      }
      sbr_poll_recon_job(frm, $canvas, r.message.job_key);
    },
  });
}

function sbr_poll_recon_job(frm, $canvas, job_key) {
  if (frm._sbr_poll_timer) { clearInterval(frm._sbr_poll_timer); }

  var elapsed = 0;
  var MAX_WAIT = 600; // 10 minutes
  var POLL_INTERVAL = 3000; // ms between polls

  function doPoll() {
    elapsed += POLL_INTERVAL / 1000;
    if (elapsed > MAX_WAIT) {
      clearInterval(frm._sbr_poll_timer);
      frm._sbr_ai_running = false;
      sbr_build_toolbar(frm);
      frm.page.set_indicator(__("Timeout"), "red");
      frappe.msgprint(__("Matching engine timed out. Please try again with a smaller date range."));
      return;
    }

    frappe.call({
      method: "smart_bank_reconciliation.reconciliation.api.get_recon_job_status",
      args: { job_key: job_key },
      callback: function (r) {
        if (r.exc) return; // network glitch — keep polling
        var result = r.message || {};
        if (result.status === "running") return; // still going

        clearInterval(frm._sbr_poll_timer);

        if (result.status === "error" || result.status === "expired") {
          frm._sbr_ai_running = false;
          sbr_build_toolbar(frm);
          frm.page.set_indicator(__("Error"), "red");
          var detail = result.message
            ? "<pre style=\"white-space:pre-wrap;max-height:300px;overflow:auto;\">" +
              frappe.utils.escape_html(result.message) + "</pre>"
            : "";
          frappe.msgprint({
            title: __("AI Matching Failed"),
            indicator: "red",
            message: __("AI matching failed. This has been logged to the Error Log.") + detail,
          });
          return;
        }

        // status === "complete"
        var data = result.data;

        // Render or update transaction table
        if (!$canvas.find(".sbr-table").length) {
          ReconUI.renderTransactionTable($canvas, data.transactions);
          ReconUI.updateTabBadge($canvas, "bank", data.transactions.length);
        } else {
          ReconUI.updateMatchBadges($canvas, data.transactions);
        }

        ReconUI.renderSummaryTiles($canvas, data.queue_counts);
        sbr_inject_unmatched_suggestions(data);
        ReconUI.renderSuggestionsPanel($canvas, data.suggestions);
        ReconUI.renderAIBanner($canvas, data.queue_counts);
        ReconUI.filterByQueue($canvas, null);
        ReconUI.switchTab($canvas, "bank");

        frm._sbr_ai_running = false;
        frm._sbr_ai_done = true;
        frm._sbr_auto_count = data.queue_counts.auto || 0;
        frm._sbr_review_count = data.queue_counts.review || 0;
        sbr_build_toolbar(frm);
        frm.page.set_indicator(__("Done"), "green");

        // Persist results so page reload restores without re-running the engine
        sbr_save_ai_cache(frm, data);

        // Surface aging ERP entries in the AI Match Pairs panel
        frappe.call({
          method: "smart_bank_reconciliation.reconciliation.api.get_aging_erp_entries",
          args: {
            bank_account: frm.doc.bank_account,
            from_date:    frm.doc.bank_statement_from_date,
            to_date:      frm.doc.bank_statement_to_date,
            company:      frm.doc.company || "",
          },
          callback: function (ar) {
            if (!ar.exc && ar.message && (ar.message.entries || []).length) {
              ReconUI.renderAgingErpAlerts($canvas, ar.message.entries, ar.message.aging_days);
            }
          },
        });
      },
    });
  }

  // First quick check at 1.5 s (fast for small batches), then steady 3 s poll
  if (frm._sbr_first_poll) { clearTimeout(frm._sbr_first_poll); }
  frm._sbr_first_poll = setTimeout(doPoll, 1500);
  frm._sbr_poll_timer = setInterval(doPoll, POLL_INTERVAL);
}

/* ── Bulk Approve Auto ── */
function sbr_bulk_approve(frm) {
  var count = frm._sbr_auto_count || 0;
  if (!count) {
    frappe.msgprint(__("No Auto-queue transactions to approve. Run AI Match All first."));
    return;
  }
  frappe.confirm(
    __("Approve all {0} Auto-matched transaction(s)?", [count]),
    function () {
      frappe.call({
        method: "smart_bank_reconciliation.reconciliation.api.bulk_approve_auto",
        args: {
          bank_account: frm.doc.bank_account,
          from_date:    frm.doc.bank_statement_from_date,
          to_date:      frm.doc.bank_statement_to_date,
        },
        callback: function (r) {
          if (r.exc) return;
          var data = r.message;
          var $canvas = frm.fields_dict.recon_ui_container.$wrapper;
          (data.approved_transactions || []).forEach(function (name) {
            $canvas.find('.sbr-row[data-txn="' + name + '"]')
              .addClass("sbr-row-done")
              .attr("data-queue", "Reconciled")
              .find(".sbr-match-cell")
              .html('<span class="sbr-conf-badge sbr-conf-reconciled">✓ Reconciled</span>');
          });
          ReconUI.renderSummaryTiles($canvas, data.new_counts);
          ReconUI.renderAIBanner($canvas, data.new_counts);
          frm._sbr_auto_count = data.new_counts.auto || 0;
          frm._sbr_review_count = data.new_counts.review || 0;
          frappe.msgprint(__(data.count + " transaction(s) reconciled."));
        },
      });
    }
  );
}



/* ── Re-run AI on selected transactions ── */
function sbr_rerun_selected(frm) {
  var $canvas = frm.fields_dict.recon_ui_container.$wrapper;
  var names = [];
  $canvas.find(".sbr-row-check:checked").each(function () {
    names.push($(this).data("txn"));
  });

  if (!names.length) {
    frappe.msgprint(__("Select at least one transaction to re-run AI on."));
    return;
  }

  frappe.confirm(
    __("Re-run AI matching on {0} selected transaction(s)? This resets and re-scores their AI results.", [names.length]),
    function () {
      frm.page.set_indicator(__("Running..."), "orange");

      frappe.call({
        method: "smart_bank_reconciliation.reconciliation.api.rerun_ai_on_transactions",
        args: {
          transaction_names: JSON.stringify(names),
          bank_account: frm.doc.bank_account,
          from_date:    frm.doc.bank_statement_from_date,
          to_date:      frm.doc.bank_statement_to_date,
          company:      frm.doc.company || "",
        },
        callback: function (r) {
          if (r.exc) {
            frm.page.set_indicator(__("Error"), "red");
            return;
          }
          var data = r.message;

          ReconUI.updateMatchBadges($canvas, data.transactions);
          ReconUI.updateSuggestionCards($canvas, data.suggestions);
          ReconUI.renderSummaryTiles($canvas, data.queue_counts);
          ReconUI.renderAIBanner($canvas, data.queue_counts);
          frm._sbr_auto_count  = data.queue_counts.auto   || 0;
          frm._sbr_review_count = data.queue_counts.review || 0;

          // Uncheck all rows after re-run
          $canvas.find(".sbr-row-check, .sbr-select-all").prop("checked", false);
          $canvas.find(".sbr-toolbar-rerun-sel, .sbr-toolbar-consolidate-sel").hide();

          frm.page.set_indicator(__("Done"), "green");
          frappe.show_alert({
            message: __(data.rerun_count + " transaction(s) re-analyzed."),
            indicator: "green",
          }, 4);
        },
      });
    }
  );
}

/* ── Handle reconcile-modal confirm ── */
function sbr_handle_modal_confirm(frm, $canvas, txnName, result, $modal) {
  if (result.pane === "reconcile") {
    frappe.confirm(__("Mark {0} as Reconciled without linking an ERP voucher?", [txnName]), function () {
      frappe.call({
        method: "smart_bank_reconciliation.reconciliation.api.approve_match",
        args: { bank_transaction: txnName, matched_entries: [] },
        callback: function (r) {
          if (!r.exc) {
            $modal.remove();
            sbr_mark_row_reconciled($canvas, txnName);
            frappe.show_alert({ message: __("Transaction marked as Reconciled."), indicator: "green" });
          }
        },
      });
    });
    return;
  }
  if (result.pane === "match") {
    // 1:Many returns selectedVouchers (array of {name,amount}); 1:1 returns selectedVoucher (string)
    var entriesToReconcile = result.selectedVouchers ||
        (result.selectedVoucher ? [{ name: result.selectedVoucher, amount: 0 }] : []);
    frappe.call({
      method: "smart_bank_reconciliation.reconciliation.api.approve_match",
      args: { bank_transaction: txnName, matched_entries: entriesToReconcile },
      callback: function (r) {
        if (!r.exc) {
          $modal.remove();
          sbr_mark_row_reconciled($canvas, txnName);
          frappe.show_alert({ message: __("Transaction reconciled."), indicator: "green" });
        }
      },
    });
  } else if (result.pane === "createVoucher") {
    $modal.remove();
    $(document).off("keydown.sbrmodal");
    sbr_open_create_voucher_dialog(frm, $canvas, txnName);
  } else if (result.pane === "updateTransaction") {
    $modal.remove();
    $(document).off("keydown.sbrmodal");
    sbr_open_update_transaction_dialog(txnName);
  } else if (result.pane === "transfer") {
    frappe.call({
      method: "smart_bank_reconciliation.reconciliation.api.escalate_to_ar",
      args: { bank_transaction: txnName, note: "[Internal Transfer] " + result.note },
      callback: function (r) {
        if (!r.exc) {
          $modal.remove();
          frappe.show_alert({ message: __("Marked as internal transfer."), indicator: "blue" });
        }
      },
    });
  } else if (result.pane === "escalate") {
    frappe.call({
      method: "smart_bank_reconciliation.reconciliation.api.escalate_to_ar",
      args: { bank_transaction: txnName, note: result.note },
      callback: function (r) {
        if (!r.exc) {
          $modal.remove();
          frappe.show_alert({ message: __("Transaction escalated to AR/AP."), indicator: "orange" });
        }
      },
    });
  }
}

/* ── Create Voucher dialog (matches standard V13 flow) ── */
function sbr_open_create_voucher_dialog(frm, $canvas, txnName) {
  frappe.db.get_value(
    "Bank Transaction",
    txnName,
    ["deposit", "withdrawal", "description", "unallocated_amount"],
    function (txn) {
      if (!txn) { frappe.msgprint(__("Could not load bank transaction.")); return; }

      var dep   = parseFloat(txn.deposit || 0);
      var wit   = parseFloat(txn.withdrawal || 0);
      var unal  = parseFloat(txn.unallocated_amount || 0);
      var alloc = (dep || wit) - unal;

      var d = new frappe.ui.Dialog({
        title: __("Reconcile the Bank Transaction"),
        size: "large",
        fields: [
          {
            label: __("Document Type"),
            fieldname: "document_type",
            fieldtype: "Select",
            options: "Payment Entry\nJournal Entry",
            default: "Payment Entry",
          },
          /* ── Details section ── */
          { fieldtype: "Section Break", label: __("Details") },
          { fieldname: "reference_number", fieldtype: "Data",    label: __("Reference Number"),     reqd: 1 },
          { fieldname: "posting_date",     fieldtype: "Date",    label: __("Posting Date"),          reqd: 1, default: frappe.datetime.get_today() },
          { fieldname: "reference_date",   fieldtype: "Date",    label: __("Cheque/Reference Date"), reqd: 1 },
          { fieldname: "mode_of_payment",  fieldtype: "Link",    label: __("Mode of Payment"),       options: "Mode of Payment" },
          {
            fieldname: "edit_in_full_page",
            fieldtype: "Button",
            label: __("Edit in Full Page"),
            click: function () { _doEditInFullPage(d); },
          },
          { fieldtype: "Column Break" },
          /* ── Journal Entry only ── */
          {
            fieldname: "journal_entry_type",
            fieldtype: "Select",
            label: __("Journal Entry Type"),
            options: "Journal Entry\nInter Company Journal Entry\nBank Entry\nCash Entry\nCredit Card Entry\nDebit Note\nCredit Note\nContra Entry\nExcise Entry\nWrite Off Entry\nOpening Entry\nDepreciation Entry\nExchange Rate Revaluation\nDeferred Revenue\nDeferred Expense",
            depends_on: "eval:doc.document_type=='Journal Entry'",
            mandatory_depends_on: "eval:doc.document_type=='Journal Entry'",
          },
          {
            fieldname: "second_account",
            fieldtype: "Link",
            label: __("Account"),
            options: "Account",
            depends_on: "eval:doc.document_type=='Journal Entry'",
            mandatory_depends_on: "eval:doc.document_type=='Journal Entry'",
            get_query: function () { return { filters: { is_group: 0, disabled: 0, company: frm.doc.company } }; },
          },
          /* ── Payment Entry only ── */
          {
            fieldname: "party_type",
            fieldtype: "Link",
            label: __("Party Type"),
            options: "DocType",
            depends_on: "eval:doc.document_type=='Payment Entry'",
            mandatory_depends_on: "eval:doc.document_type=='Payment Entry'",
            get_query: function () {
              var types = (frappe.boot.party_account_types && Object.keys(frappe.boot.party_account_types)) ||
                          ["Customer", "Supplier", "Employee"];
              return { filters: { name: ["in", types] } };
            },
          },
          {
            fieldname: "party",
            fieldtype: "Dynamic Link",
            label: __("Party"),
            options: "party_type",
            depends_on: "eval:doc.document_type=='Payment Entry'",
            mandatory_depends_on: "eval:doc.document_type=='Payment Entry'",
          },
          {
            fieldname: "project",
            fieldtype: "Link",
            label: __("Project"),
            options: "Project",
            depends_on: "eval:doc.document_type=='Payment Entry'",
          },
          {
            fieldname: "cost_center",
            fieldtype: "Link",
            label: __("Cost Center"),
            options: "Cost Center",
            depends_on: "eval:doc.document_type=='Payment Entry'",
          },
          /* ── Transaction Details (read-only) ── */
          { fieldtype: "Section Break", label: __("Transaction Details"), collapsible: 1 },
          { fieldname: "dep_disp",   fieldtype: "Currency",   label: __("Deposit"),           read_only: 1, default: dep },
          { fieldname: "wit_disp",   fieldtype: "Currency",   label: __("Withdrawal"),         read_only: 1, default: wit },
          { fieldname: "desc_disp",  fieldtype: "Small Text", label: __("Description"),        read_only: 1, default: txn.description || "" },
          { fieldtype: "Column Break" },
          { fieldname: "alloc_disp", fieldtype: "Currency",   label: __("Allocated Amount"),   read_only: 1, default: alloc },
          { fieldname: "unal_disp",  fieldtype: "Currency",   label: __("Unallocated Amount"), read_only: 1, default: unal },
        ],
        primary_action_label: __("Create Voucher"),
        primary_action: function (values) { _doCreate(d, values); },
      });

      d.show();

      /* ── Primary: create + submit + auto-reconcile via V13 backend ── */
      function _doCreate(dialog, values) {
        var isJE = values.document_type === "Journal Entry";
        frappe.call({
          method: isJE
            ? "erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.create_journal_entry_bts"
            : "erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.create_payment_entry_bts",
          args: isJE ? {
            bank_transaction_name: txnName,
            reference_number: values.reference_number,
            reference_date:   values.reference_date,
            posting_date:     values.posting_date,
            entry_type:       values.journal_entry_type,
            second_account:   values.second_account,
            mode_of_payment:  values.mode_of_payment || "",
            party_type:       values.party_type || "",
            party:            values.party || "",
          } : {
            bank_transaction_name: txnName,
            reference_number: values.reference_number,
            reference_date:   values.reference_date,
            party_type:       values.party_type,
            party:            values.party,
            posting_date:     values.posting_date,
            mode_of_payment:  values.mode_of_payment || "",
            project:          values.project || "",
            cost_center:      values.cost_center || "",
          },
          btn: dialog.get_primary_btn(),
          freeze: true,
          freeze_message: isJE ? __("Creating Journal Entry…") : __("Creating Payment Entry…"),
          callback: function (r) {
            if (r.exc) return;
            dialog.hide();
            sbr_mark_row_reconciled($canvas, txnName);
            frappe.show_alert({
              message: isJE ? __("Journal Entry created and reconciled.") : __("Payment Entry created and reconciled."),
              indicator: "green",
            }, 8);
          },
        });
      }

      /* ── Edit in Full Page: insert draft then open in new tab ── */
      function _doEditInFullPage(dialog) {
        var values = dialog.get_values(true) || {};
        var isJE = values.document_type === "Journal Entry";
        var prefill = isJE ? {
          posting_date:    values.posting_date || "",
          cheque_no:       values.reference_number || "",
          cheque_date:     values.reference_date || "",
          voucher_type:    values.journal_entry_type || "Bank Entry",
          second_account:  values.second_account || "",
          party_type:      values.party_type || "",
          party:           values.party || "",
          mode_of_payment: values.mode_of_payment || "",
        } : {
          posting_date:    values.posting_date || "",
          reference_no:    values.reference_number || "",
          reference_date:  values.reference_date || "",
          party_type:      values.party_type || "",
          party:           values.party || "",
          mode_of_payment: values.mode_of_payment || "",
          project:         values.project || "",
          cost_center:     values.cost_center || "",
        };
        frappe.call({
          method: "smart_bank_reconciliation.reconciliation.api.create_draft_entry",
          args: {
            bank_transaction: txnName,
            entry_type: isJE ? "JE" : "PE",
            prefill: JSON.stringify(prefill),
          },
          callback: function (r) {
            if (!r.exc && r.message && r.message.name) {
              dialog.hide();
              var url = "/app/" + r.message.doctype.toLowerCase().replace(/ /g, "-") +
                        "/" + encodeURIComponent(r.message.name);
              window.open(url, "_blank");
            }
          },
        });
      }
    }
  );
}

/* ── Update Bank Transaction dialog (reuses ERPNext V13 update_bank_transaction backend) ── */
function sbr_open_update_transaction_dialog(txnName) {
  frappe.call({
    method: "frappe.client.get_value",
    args: {
      doctype: "Bank Transaction",
      filters: { name: txnName },
      fieldname: [
        "name", "date", "deposit", "withdrawal", "description",
        "reference_number", "party_type", "party",
        "allocated_amount", "unallocated_amount",
      ],
    },
    callback: function (r) {
      if (!r.message) return;
      var bt = r.message;

      var amtColor = bt.deposit ? "#16a34a" : "#dc2626";
      var rawAmt   = parseFloat(bt.deposit || bt.withdrawal || 0);
      var amtText  = ReconUI.fmtCurrency(rawAmt) + (bt.deposit ? " CR" : " DR");
      var infoHtml =
        '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;' +
        'padding:8px 12px;margin-bottom:2px;font-size:12px;font-variant-numeric:tabular-nums;' +
        'display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
        '<span style="font-family:ui-monospace,monospace;font-weight:700;color:#0f172a">' +
          txnName + '</span>' +
        '<span style="color:' + amtColor + ';font-weight:600">' + amtText + '</span>' +
        (bt.description
          ? '<span style="color:#64748b;overflow:hidden;text-overflow:ellipsis;' +
            'white-space:nowrap;flex:1">' +
            $("<span>").text(bt.description).html() + "</span>"
          : "") +
        "</div>";

      var d = new frappe.ui.Dialog({
        title: __("Update Bank Transaction"),
        fields: [
          { fieldtype: "HTML", options: infoHtml },
          {
            fieldname: "reference_number",
            fieldtype: "Data",
            label: __("Reference Number"),
          },
          { fieldtype: "Column Break" },
          {
            fieldname: "party_type",
            fieldtype: "Link",
            options: "DocType",
            label: __("Party Type"),
            get_query: function () {
              return {
                filters: {
                  name: ["in", ["Customer", "Supplier", "Employee",
                                "Shareholder", "Student", "Member"]],
                },
              };
            },
          },
          { fieldtype: "Section Break" },
          {
            fieldname: "party",
            fieldtype: "Dynamic Link",
            options: "party_type",
            label: __("Party"),
          },
          {
            fieldtype: "Section Break",
            label: __("Transaction Details"),
            collapsible: 1,
            collapsed: 1,
          },
          {
            fieldname: "deposit",
            fieldtype: "Currency",
            label: __("Deposit"),
            read_only: 1,
          },
          { fieldtype: "Column Break" },
          {
            fieldname: "withdrawal",
            fieldtype: "Currency",
            label: __("Withdrawal"),
            read_only: 1,
          },
          { fieldtype: "Section Break" },
          {
            fieldname: "description",
            fieldtype: "Small Text",
            label: __("Description"),
            read_only: 1,
          },
          { fieldtype: "Column Break" },
          {
            fieldname: "allocated_amount",
            fieldtype: "Currency",
            label: __("Allocated Amount"),
            read_only: 1,
          },
          {
            fieldname: "unallocated_amount",
            fieldtype: "Currency",
            label: __("Unallocated Amount"),
            read_only: 1,
          },
        ],
        primary_action_label: __("Update"),
        primary_action: function (values) {
          frappe.call({
            method: "erpnext.accounts.doctype.bank_reconciliation_tool" +
                    ".bank_reconciliation_tool.update_bank_transaction",
            args: {
              bank_transaction_name: txnName,
              reference_number: values.reference_number || "",
              party_type: values.party_type || "",
              party: values.party || "",
            },
            callback: function (resp) {
              if (!resp.exc) {
                d.hide();
                frappe.show_alert({
                  message: __("Bank Transaction {0} updated", [txnName]),
                  indicator: "green",
                });
              }
            },
          });
        },
      });

      d.set_values({
        reference_number:   bt.reference_number   || "",
        party_type:         bt.party_type         || "",
        party:              bt.party              || "",
        deposit:            bt.deposit            || 0,
        withdrawal:         bt.withdrawal         || 0,
        description:        bt.description        || "",
        allocated_amount:   bt.allocated_amount   || 0,
        unallocated_amount: bt.unallocated_amount || 0,
      });

      d.show();
    },
  });
}

/* ── Unreconcile a Bank Transaction ── */
function sbr_open_unreconcile_dialog(frm, $canvas, txnName) {
  frappe.call({
    method: "frappe.client.get_value",
    args: {
      doctype: "Bank Transaction",
      filters: { name: txnName },
      fieldname: ["name", "date", "deposit", "withdrawal", "description"],
    },
    callback: function (r) {
      if (!r.message) return;
      var bt = r.message;

      frappe.call({
        method: "smart_bank_reconciliation.reconciliation.api.get_linked_payment_entries_for_bt",
        args: { bank_transaction_name: txnName },
        callback: function (resp) {
          if (resp.exc) return;
          var entries = resp.message || [];
          if (!entries.length) {
            frappe.show_alert({ message: __("No linked vouchers found on this Bank Transaction."), indicator: "orange" });
            return;
          }

          // ── Build transaction info banner ──────────────────────────────────
          var isCredit = parseFloat(bt.deposit || 0) > 0;
          var rawAmt   = parseFloat(bt.deposit || bt.withdrawal || 0);
          var amtColor = isCredit ? "#16a34a" : "#dc2626";
          var amtText  = ReconUI.fmtCurrency(rawAmt) + (isCredit ? " CR" : " DR");

          var bannerHtml =
            '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;' +
            'padding:8px 12px;margin-bottom:14px;font-size:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
            '<span style="font-family:ui-monospace,monospace;font-weight:700;color:#0f172a">' + txnName + '</span>' +
            '<span style="color:' + amtColor + ';font-weight:600">' + amtText + '</span>' +
            '<span style="color:#64748b">' + (bt.date || "") + '</span>' +
            (bt.description
              ? '<span style="color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">' +
                $("<span>").text(bt.description).html() + '</span>'
              : '') +
            '</div>';

          // ── Build voucher list ─────────────────────────────────────────────
          var listHtml = '<div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:6px">' +
            __("Select voucher to unreconcile") + '</div>' +
            '<div style="border:1px solid #e5e7eb;border-radius:6px;overflow:hidden">';

          entries.forEach(function (e, i) {
            var entryAmt = ReconUI.fmtCurrency(parseFloat(e.allocated_amount || 0));
            var docRoute = (e.payment_document || "").toLowerCase().replace(/ /g, "-");
            listHtml +=
              '<label style="display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer;' +
              (i > 0 ? 'border-top:1px solid #e5e7eb;' : '') +
              'background:#fff;transition:background 0.15s" ' +
              'onmouseover="this.style.background=\'#f9fafb\'" onmouseout="this.style.background=\'#fff\'">' +
              '<input type="radio" name="sbr_unr_pe" value="' + e.payment_entry + '"' +
              (entries.length === 1 ? ' checked' : '') + ' style="margin:0;accent-color:#dc2626">' +
              '<span style="display:flex;flex-direction:column;flex:1;gap:2px">' +
                '<span style="font-family:ui-monospace,monospace;font-size:12px;font-weight:600;color:#1e293b">' +
                  '<a href="/app/' + docRoute + '/' + encodeURIComponent(e.payment_entry) +
                  '" target="_blank" onclick="event.stopPropagation()" style="color:#1d4ed8;text-decoration:none">' +
                  e.payment_entry + '</a>' +
                '</span>' +
                '<span style="font-size:11px;color:#64748b">' + (e.payment_document || "") + '</span>' +
              '</span>' +
              '<span style="font-variant-numeric:tabular-nums;font-weight:600;color:#0f172a">' +
                entryAmt +
              '</span>' +
              '</label>';
          });
          listHtml += '</div>';

          // ── Warning note ───────────────────────────────────────────────────
          var noteHtml =
            '<div style="margin-top:12px;padding:10px 12px;background:#fef3c7;border:1px solid #fde68a;' +
            'border-radius:6px;font-size:12px;color:#92400e;line-height:1.5">' +
            '<strong>What this does:</strong> Removes the bank-to-voucher link and clears the ' +
            '<em>clearance date</em> on the voucher. The voucher\'s accounting allocation to ' +
            'invoices is <strong>not</strong> affected — it remains balanced in the books.' +
            '</div>';

          var d = new frappe.ui.Dialog({
            title: __("Unreconcile Bank Transaction"),
            fields: [
              { fieldtype: "HTML", options: bannerHtml + listHtml + noteHtml },
            ],
            primary_action_label: __("Unreconcile"),
            primary_action: function () {
              var selectedPE = d.$wrapper.find('input[name="sbr_unr_pe"]:checked').val();
              if (!selectedPE) {
                frappe.show_alert({ message: __("Please select a voucher."), indicator: "orange" });
                return;
              }

              d.disable_primary_action();

              frappe.call({
                method: "smart_bank_reconciliation.reconciliation.api.unreconcile_bank_transaction",
                args: {
                  bank_transaction_name: txnName,
                  payment_entry_name: selectedPE,
                },
                callback: function (res) {
                  if (res.exc) {
                    d.enable_primary_action();
                    return;
                  }
                  d.hide();
                  frappe.show_alert({
                    message: __("Unreconciled {0} from {1}", [txnName, selectedPE]),
                    indicator: "green",
                  });

                  // ── Update the row in the Bank Transactions table ──────────
                  var $row = $canvas.find('.sbr-row[data-txn="' + txnName + '"]');
                  $row.removeClass("sbr-row-done").attr("data-queue", "Unreconciled");

                  // Restore checkbox
                  $row.find("td.sbr-check-col").html(
                    '<input type="checkbox" class="sbr-row-check" data-txn="' + txnName + '">'
                  );

                  // Update unallocated_amount cell (column index 6)
                  var unal = parseFloat(res.message.unallocated_amount || 0);
                  $row.find("td").eq(6).html(
                    unal > 0
                      ? '<span style="color:#64748b;font-variant-numeric:tabular-nums">' +
                        ReconUI.fmtCurrency(unal) + "</span>"
                      : "—"
                  );

                  // Restore Actions button (remove Reconciled badge + Unreconcile btn)
                  $row.find("td").last().html(
                    '<button class="sbr-btn sbr-row-action-btn sbr-btn-action-blue" data-txn="' +
                    txnName + '">Actions</button>'
                  );

                  // Clear match badge
                  $row.find(".sbr-match-cell").html("");

                  // Restore the suggestion card in the AI panel (fade back in, restore buttons)
                  $canvas.find('.sbr-card[data-txn="' + txnName + '"]')
                    .css("opacity", "1")
                    .find(".sbr-card-actions")
                    .html(
                      '<button class="sbr-btn sbr-btn-accept" data-txn="' + txnName +
                      '">&#10003; Approve Match</button>' +
                      '<button class="sbr-btn sbr-pair-view-btn sbr-pair-detail-btn" data-txn="' +
                      txnName + '">View Details &#8250;</button>' +
                      '<button class="sbr-btn sbr-btn-update" data-txn="' + txnName +
                      '">&#9998; Update</button>'
                    );
                },
              });
            },
          });
          d.show();
        },
      });
    },
  });
}

/* ── Mark a single row as reconciled in the table ── */
function sbr_mark_row_reconciled($canvas, txnName) {
  var $row = $canvas.find('.sbr-row[data-txn="' + txnName + '"]');
  $row.addClass("sbr-row-done").attr("data-queue", "Reconciled");
  $row.find(".sbr-match-cell").html('<span class="sbr-conf-badge sbr-conf-reconciled">✓ Reconciled</span>');
  $row.find(".sbr-row-action-btn").replaceWith(
    '<span style="font-size:11px;color:#16a34a;font-weight:500">&#10003; Reconciled</span>' +
    ' <button class="sbr-btn sbr-btn-unreconcile" data-txn="' + txnName +
    '" title="Remove this reconciliation">&#8617; Unreconcile</button>'
  );
  $row.find(".sbr-row-check").remove();

  // Also update the suggestion card in the AI panel so it reflects reconciled state
  $canvas.find('.sbr-card[data-txn="' + txnName + '"]')
    .css("opacity", ".45")
    .find(".sbr-card-actions")
    .html('<p class="sbr-success">&#10003; Reconciled.</p>');
}

/* ── Consolidate Bank Charges modal (two-panel, auto-identified charges) ── */
function sbr_open_bank_charges_modal(frm) {
  var bank_account = frm.doc.bank_account;
  var from_date    = frm.doc.bank_statement_from_date;
  var to_date      = frm.doc.bank_statement_to_date;

  if (!bank_account || !from_date || !to_date) {
    frappe.msgprint(__("Please set Bank Account and date range first."));
    return;
  }

  var d = new frappe.ui.Dialog({
    title: __("Consolidate Bank Charges"),
    fields: [{ fieldtype: "HTML", fieldname: "content" }],
    primary_action_label: __("Select ≥ 2 Charges"),
    primary_action: function () { _doConsolidateCharges(); },
  });
  d.$wrapper.find(".modal-dialog").css("max-width", "980px");
  d.get_primary_btn().prop("disabled", true);

  d.fields_dict.content.$wrapper.html(
    '<div style="text-align:center;padding:40px 0;color:#9ca3af">' +
      '<div style="font-size:28px;margin-bottom:8px">⏳</div>Identifying bank charges…</div>'
  );
  d.show();

  var charges  = [];   // all fetched charge txns
  var selected = {};   // name → charge object

  /* ─── helpers ─── */
  function fmtAmt(v) {
    v = parseFloat(v) || 0;
    if (!v) return "—";
    return ReconUI.fmtCurrency(v);
  }
  function truncate(str, n) {
    str = str || "";
    return str.length > n ? str.substring(0, n) + "…" : str;
  }
  function matchedByBadge(mb) {
    var isKw = mb === "Keyword";
    return '<span style="font-size:10px;padding:2px 7px;border-radius:99px;font-weight:600;white-space:nowrap;' +
      (isKw
        ? 'background:#dbeafe;color:#1d4ed8">' + mb
        : 'background:#fef3c7;color:#92400e">' + mb) +
      '</span>';
  }

  /* ─── sync right panel + button label ─── */
  function syncRight() {
    var selArr     = Object.values(selected);
    var totalWit   = selArr.reduce(function (s, t) { return s + parseFloat(t.withdrawal || 0); }, 0);
    var totalDep   = selArr.reduce(function (s, t) { return s + parseFloat(t.deposit    || 0); }, 0);
    var $w         = d.fields_dict.content.$wrapper;

    $w.find(".sbr-chg-sel-count").text(selArr.length);

    var bodyHtml = selArr.length
      ? selArr.map(function (t) {
          return "<tr>" +
            '<td style="font-family:monospace;font-size:11px;padding:6px 8px;color:#374151">' + t.name + "</td>" +
            '<td style="padding:6px 8px;font-size:12px;color:#6b7280">' + (t.date || "") + "</td>" +
            '<td style="padding:6px 8px;font-size:12px;color:#374151;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + (t.description || "") + '">' + truncate(t.description, 28) + "</td>" +
            '<td style="padding:6px 8px;font-size:11px;color:#374151">' + (t.charge_type || "") + "</td>" +
            '<td style="padding:6px 8px;text-align:right;color:#dc2626;font-weight:600">' + fmtAmt(t.withdrawal) + "</td>" +
            "</tr>";
        }).join("")
      : '<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:28px 0;font-size:12px">No charges selected yet</td></tr>';

    $w.find(".sbr-chg-right-body").html(bodyHtml);

    if (selArr.length) {
      $w.find(".sbr-chg-totals").show()
        .find(".sbr-chg-total-dep").text(totalDep > 0 ? fmtAmt(totalDep) : "—").end()
        .find(".sbr-chg-total-wit").text(totalWit > 0 ? fmtAmt(totalWit) : "—");
    } else {
      $w.find(".sbr-chg-totals").hide();
    }

    var n    = selArr.length;
    var $btn = d.get_primary_btn();
    if (n < 2) {
      $btn.prop("disabled", true).text(n === 0 ? __("Select ≥ 2 Charges") : __("Select 1 more Charge"));
    } else {
      $btn.prop("disabled", false).text(__("Consolidate {0} Charges", [n]));
    }
  }

  /* ─── build left panel rows from a (filtered) array ─── */
  function buildLeftRows(arr) {
    if (!arr.length) {
      return '<tr><td colspan="6" style="text-align:center;color:#9ca3af;padding:28px 0;font-size:12px">No charges match the filter</td></tr>';
    }
    return arr.map(function (t) {
      var isSel = !!selected[t.name];
      return '<tr class="sbr-chg-row" data-name="' + t.name + '" style="cursor:pointer;transition:background .12s' + (isSel ? ";background:#eff6ff" : "") + '">' +
        '<td style="width:36px;text-align:center;padding:8px">' +
          '<input type="checkbox" class="sbr-chg-chk" data-name="' + t.name + '"' + (isSel ? " checked" : "") + ' style="cursor:pointer;width:14px;height:14px">' +
        "</td>" +
        '<td style="padding:8px 6px;font-size:12px;color:#6b7280;white-space:nowrap">' + (t.date || "") + "</td>" +
        '<td style="padding:8px 6px;font-size:12px;color:#374151;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + (t.description || "") + '">' + truncate(t.description, 30) + "</td>" +
        '<td style="padding:8px 6px;font-size:11px;color:#374151;white-space:nowrap">' + (t.charge_type || "") + "</td>" +
        '<td style="padding:8px 6px;text-align:right;color:#dc2626;font-weight:600;white-space:nowrap">' + fmtAmt(t.withdrawal) + "</td>" +
        '<td style="padding:8px 6px;text-align:center">' + matchedByBadge(t.matched_by) + "</td>" +
        "</tr>";
    }).join("");
  }

  /* ─── TH helper ─── */
  function TH(label, align) {
    return '<th style="padding:7px 6px;text-align:' + (align || "left") + ';font-size:10px;color:#9ca3af;font-weight:700;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap">' + label + "</th>";
  }

  /* ─── render full layout once data arrives ─── */
  function renderLayout() {
    // Build charge type options for filter
    var types = [];
    charges.forEach(function (c) {
      if (types.indexOf(c.charge_type) === -1) types.push(c.charge_type);
    });
    var typeOptions = '<option value="">All Types</option>' +
      types.map(function (t) { return '<option value="' + t + '">' + t + "</option>"; }).join("");

    d.fields_dict.content.$wrapper.html(
      /* info banner */
      '<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:9px 14px;margin-bottom:14px;display:flex;gap:10px;align-items:flex-start">' +
        '<span style="font-size:16px;line-height:1.5">🏦</span>' +
        '<div style="font-size:12px;color:#1e40af;line-height:1.5">' +
          'Transactions are identified as bank charges by <strong>keyword match</strong> (description contains a known charge keyword) ' +
          'or <strong>amount rule</strong> (debit ≤ configured threshold). ' +
          'Select the ones to consolidate, then click <strong>Consolidate</strong>. ' +
          'The original transactions will be marked Reconciled; the new combined transaction stays Unreconciled for manual Journal Entry creation.' +
        '</div>' +
      '</div>' +

      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;font-size:13px">' +

      /* ── LEFT ── */
      "<div>" +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding-bottom:8px;border-bottom:2px solid #e5e7eb">' +
          '<span style="font-weight:700;color:#111827">Identified Bank Charge Transactions</span>' +
          '<span class="sbr-chg-avail-count" style="font-size:11px;background:#f3f4f6;color:#6b7280;border-radius:99px;padding:2px 10px">' + charges.length + " found</span>" +
        "</div>" +
        '<div style="display:flex;gap:8px;margin-bottom:8px;align-items:center">' +
          '<select class="sbr-chg-filter-type" style="flex:1;padding:5px 8px;font-size:12px;border:1px solid #d1d5db;border-radius:6px;background:#fff;color:#374151">' + typeOptions + "</select>" +
          '<button class="sbr-chg-select-all" style="padding:4px 10px;font-size:11px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;color:#374151">Select All</button>' +
          '<button class="sbr-chg-clear-sel" style="padding:4px 10px;font-size:11px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;color:#374151">Clear</button>' +
        "</div>" +
        '<div style="max-height:340px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:8px">' +
          '<table style="width:100%;border-collapse:collapse;table-layout:fixed">' +
            '<thead style="position:sticky;top:0;z-index:1;background:#f9fafb;border-bottom:1px solid #e5e7eb"><tr>' +
              '<th style="width:36px"></th>' +
              TH("Date") + TH("Description") + TH("Charge Type") + TH("Amount (" + ReconUI.currencySymbol() + ")", "right") + TH("Matched By", "center") +
            "</tr></thead>" +
            '<tbody class="sbr-chg-left-body">' + buildLeftRows(charges) + "</tbody>" +
          "</table>" +
        "</div>" +
      "</div>" +

      /* ── RIGHT ── */
      "<div>" +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding-bottom:8px;border-bottom:2px solid #e5e7eb">' +
          '<span style="font-weight:700;color:#111827">Selected to be Consolidated</span>' +
          '<span class="sbr-chg-sel-count" style="min-width:22px;text-align:center;background:#3b82f6;color:white;border-radius:99px;padding:1px 8px;font-size:11px;font-weight:700">0</span>' +
        "</div>" +
        '<div style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">' +
          '<table style="width:100%;border-collapse:collapse">' +
            '<thead style="background:#f9fafb;border-bottom:1px solid #e5e7eb"><tr>' +
              TH("Name") + TH("Date") + TH("Description") + TH("Charge Type") + TH("Amount (" + ReconUI.currencySymbol() + ")", "right") +
            "</tr></thead>" +
            '<tbody class="sbr-chg-right-body" style="max-height:240px;overflow-y:auto">' +
              '<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:28px 0;font-size:12px">No charges selected yet</td></tr>' +
            "</tbody>" +
            '<tfoot class="sbr-chg-totals" style="display:none">' +
              '<tr style="background:#fef2f2;font-weight:700;border-top:2px solid #fecaca">' +
                '<td colspan="3" style="padding:7px 10px;color:#374151">Totals</td>' +
                '<td class="sbr-chg-total-dep" style="padding:7px 10px;text-align:right;color:#16a34a">—</td>' +
                '<td class="sbr-chg-total-wit" style="padding:7px 10px;text-align:right;color:#dc2626">—</td>' +
              "</tr>" +
            "</tfoot>" +
          "</table>" +
        "</div>" +
      "</div>" +

      "</div>" /* grid */
    );

    var $w        = d.fields_dict.content.$wrapper;
    var $leftBody = $w.find(".sbr-chg-left-body");

    /* filter by charge type */
    $w.on("change", ".sbr-chg-filter-type", function () {
      var typ      = $(this).val();
      var filtered = typ ? charges.filter(function (c) { return c.charge_type === typ; }) : charges;
      $leftBody.html(buildLeftRows(filtered));
      $w.find(".sbr-chg-avail-count").text(filtered.length + " found");
    });

    /* select all (filtered rows only) */
    $w.on("click", ".sbr-chg-select-all", function () {
      $leftBody.find(".sbr-chg-chk").each(function () {
        var name = $(this).data("name");
        var txn  = charges.find(function (c) { return c.name === name; });
        if (txn) {
          selected[name] = txn;
          $(this).prop("checked", true).closest("tr").css("background", "#eff6ff");
        }
      });
      syncRight();
    });

    /* clear all selections */
    $w.on("click", ".sbr-chg-clear-sel", function () {
      selected = {};
      $leftBody.find(".sbr-chg-chk").prop("checked", false).closest("tr").css("background", "");
      syncRight();
    });

    /* checkbox toggle */
    $leftBody.on("change", ".sbr-chg-chk", function () {
      var name = $(this).data("name");
      var txn  = charges.find(function (c) { return c.name === name; });
      if (!txn) return;
      if ($(this).is(":checked")) {
        selected[name] = txn;
        $(this).closest("tr").css("background", "#eff6ff");
      } else {
        delete selected[name];
        $(this).closest("tr").css("background", "");
      }
      syncRight();
    });

    /* row click → toggle checkbox */
    $leftBody.on("click", ".sbr-chg-row", function (e) {
      if ($(e.target).is("input[type=checkbox]")) return;
      $(this).find(".sbr-chg-chk").trigger("click");
    });
  }

  /* ─── consolidate action ─── */
  function _doConsolidateCharges() {
    var selArr = Object.values(selected);
    if (selArr.length < 2) {
      frappe.msgprint(__("Select at least 2 charges to consolidate."));
      return;
    }

    var totalWit = selArr.reduce(function (s, t) { return s + parseFloat(t.withdrawal || 0); }, 0);
    var totalDep = selArr.reduce(function (s, t) { return s + parseFloat(t.deposit    || 0); }, 0);

    // Build charge category summary
    var categories = {};
    selArr.forEach(function (t) { categories[t.charge_type] = (categories[t.charge_type] || 0) + 1; });
    var catLines = Object.keys(categories).map(function (k) {
      return "  • " + k + " (" + categories[k] + ")";
    }).join("\n");

    var confirmMsg =
      "Selected transactions: " + selArr.length + "\n" +
      (totalWit > 0 ? "Total charges (debit): " + ReconUI.fmtCurrency(totalWit) + "\n" : "") +
      (totalDep > 0 ? "Total credits: "        + ReconUI.fmtCurrency(totalDep) + "\n" : "") +
      "Categories:\n" + catLines + "\n\n" +
      "Original transactions will be marked Reconciled.\n" +
      "The consolidated transaction remains Unreconciled for manual Journal Entry creation.";

    frappe.confirm(confirmMsg, function () {
      frappe.call({
        method: "smart_bank_reconciliation.reconciliation.api.consolidate_selected_bank_charges",
        args: {
          transaction_names: JSON.stringify(selArr.map(function (t) { return t.name; })),
          bank_account:      bank_account,
          company:           frm.doc.company || "",
        },
        btn: d.get_primary_btn(),
        freeze: true,
        freeze_message: __("Consolidating Bank Charges…"),
        callback: function (r) {
          if (r.exc) return;
          d.hide();
          var data   = r.message;
          var txnUrl = "/app/bank-transaction/" + encodeURIComponent(data.bank_transaction);
          frappe.show_alert({
            message: data.count + __(" bank charge(s) consolidated → ") +
              '<a href="' + txnUrl + '" target="_blank">' + data.bank_transaction + "</a>",
            indicator: "green",
          }, 12);
          setTimeout(function () { sbr_load_transactions(frm); }, 400);
        },
      });
    });
  }

  /* ─── fetch and render ─── */
  frappe.call({
    method: "smart_bank_reconciliation.reconciliation.api.get_bank_charge_transactions",
    args: { bank_account: bank_account, from_date: from_date, to_date: to_date },
    callback: function (r) {
      if (r.exc) { d.hide(); return; }
      charges = r.message || [];
      if (!charges.length) {
        d.fields_dict.content.$wrapper.html(
          '<div style="text-align:center;padding:48px 0;color:#9ca3af">' +
            '<div style="font-size:36px;margin-bottom:10px">🎉</div>' +
            '<div style="font-size:14px">No unreconciled bank charge transactions found for this period.</div>' +
          "</div>"
        );
        d.get_primary_btn().prop("disabled", true);
        return;
      }
      renderLayout();
    },
  });
}

/* ── Consolidate Transactions modal (two-panel, full transaction list) ── */
function sbr_open_consolidate_transactions_modal(frm) {
  var bank_account = frm.doc.bank_account;
  var from_date    = frm.doc.bank_statement_from_date;
  var to_date      = frm.doc.bank_statement_to_date;

  if (!bank_account || !from_date || !to_date) {
    frappe.msgprint(__("Please set Bank Account and date range first."));
    return;
  }

  var d = new frappe.ui.Dialog({
    title: __("Consolidate Transactions"),
    fields: [{ fieldtype: "HTML", fieldname: "content" }],
    primary_action_label: __("Select ≥ 2 Transactions"),
    primary_action: function () { _doConsolidate(); },
  });
  d.$wrapper.find(".modal-dialog").css("max-width", "900px");
  d.get_primary_btn().prop("disabled", true);

  d.fields_dict.content.$wrapper.html(
    '<div style="text-align:center;padding:40px 0;color:#9ca3af">' +
      '<div style="font-size:28px;margin-bottom:8px">⏳</div>Loading transactions…</div>'
  );
  d.show();

  var txns    = [];
  var selected = {};   // name → txn object

  /* ─── helpers ─── */
  function fmt(v) {
    v = parseFloat(v) || 0;
    if (!v) return "—";
    return ReconUI.fmtCurrency(v);
  }

  /* ─── update right panel + button (cheap, no full re-render) ─── */
  function syncRight() {
    var selArr  = Object.values(selected);
    var totalDep = selArr.reduce(function (s, t) { return s + parseFloat(t.deposit || 0); }, 0);
    var totalWit = selArr.reduce(function (s, t) { return s + parseFloat(t.withdrawal || 0); }, 0);
    var $w = d.fields_dict.content.$wrapper;

    $w.find(".sbr-cons-count").text(selArr.length);

    var bodyHtml = selArr.length
      ? selArr.map(function (t) {
          return "<tr>" +
            '<td style="font-family:monospace;font-size:11px;padding:6px 10px;color:#374151">' + t.name + "</td>" +
            '<td style="padding:6px 10px;color:#6b7280;font-size:12px">' + (t.date || "") + "</td>" +
            '<td style="padding:6px 10px;text-align:right;color:#16a34a;font-weight:600">' + (parseFloat(t.deposit || 0) > 0 ? fmt(t.deposit) : "—") + "</td>" +
            '<td style="padding:6px 10px;text-align:right;color:#dc2626;font-weight:600">' + (parseFloat(t.withdrawal || 0) > 0 ? fmt(t.withdrawal) : "—") + "</td>" +
            "</tr>";
        }).join("")
      : '<tr><td colspan="4" style="text-align:center;color:#9ca3af;padding:28px 0;font-size:12px">No transactions selected yet</td></tr>';

    $w.find(".sbr-cons-right-body").html(bodyHtml);

    if (selArr.length) {
      $w.find(".sbr-cons-totals").show()
        .find(".sbr-cons-total-dep").text(totalDep > 0 ? fmt(totalDep) : "—").end()
        .find(".sbr-cons-total-wit").text(totalWit > 0 ? fmt(totalWit) : "—");
    } else {
      $w.find(".sbr-cons-totals").hide();
    }

    var n    = selArr.length;
    var $btn = d.get_primary_btn();
    if (n < 2) {
      $btn.prop("disabled", true).text(n === 0 ? __("Select ≥ 2 Transactions") : __("Select 1 more Transaction"));
    } else {
      $btn.prop("disabled", false).text(__("Consolidate {0} Transactions", [n]));
    }
  }

  /* ─── build left-panel rows from a (filtered) array ─── */
  function buildLeftRows(arr) {
    if (!arr.length) {
      return '<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:28px 0;font-size:12px">No transactions match the filter</td></tr>';
    }
    return arr.map(function (t) {
      var isSel = !!selected[t.name];
      return '<tr class="sbr-cons-row" data-name="' + t.name + '" style="cursor:pointer;transition:background .12s' + (isSel ? ";background:#eff6ff" : "") + '">' +
        '<td style="width:40px;text-align:center;padding:8px">' +
          '<input type="checkbox" class="sbr-cons-chk" data-name="' + t.name + '"' + (isSel ? " checked" : "") + ' style="cursor:pointer;width:15px;height:15px">' +
        "</td>" +
        '<td style="font-family:monospace;font-size:11px;padding:8px 6px;color:#374151">' + t.name + "</td>" +
        '<td style="padding:8px 6px;font-size:12px;color:#6b7280">' + (t.date || "") + "</td>" +
        '<td style="padding:8px 6px;text-align:right;color:#16a34a;font-weight:600">' + (parseFloat(t.deposit || 0) > 0 ? fmt(t.deposit) : "—") + "</td>" +
        '<td style="padding:8px 6px;text-align:right;color:#dc2626;font-weight:600">' + (parseFloat(t.withdrawal || 0) > 0 ? fmt(t.withdrawal) : "—") + "</td>" +
        "</tr>";
    }).join("");
  }

  /* ─── initial render (left panel + empty right panel) ─── */
  function renderLayout() {
    var TH = function (label, align) {
      return '<th style="padding:7px 6px;text-align:' + (align || "left") + ';font-size:10px;color:#9ca3af;font-weight:700;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap">' + label + "</th>";
    };
    var filterInputHtml = function (cls, placeholder) {
      return '<input type="number" class="' + cls + '" placeholder="' + placeholder + '" min="0" step="1"' +
        ' style="flex:1;min-width:0;box-sizing:border-box;padding:5px 8px;font-size:12px;border:1px solid #d1d5db;' +
        'border-radius:6px;outline:none;background:#fff;color:#374151;">';
    };

    d.fields_dict.content.$wrapper.html(
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;font-size:13px">' +

      /* ── LEFT ── */
      "<div>" +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding-bottom:8px;border-bottom:2px solid #e5e7eb">' +
          '<span style="font-weight:700;color:#111827">List of Bank Transactions</span>' +
          '<span class="sbr-cons-avail-count" style="font-size:11px;background:#f3f4f6;color:#6b7280;border-radius:99px;padding:2px 10px">' + txns.length + " available</span>" +
        "</div>" +
        /* ── filter bar (outside table, always visible) ── */
        '<div style="display:flex;gap:8px;margin-bottom:8px">' +
          filterInputHtml("sbr-filter-dep", "Enter Deposit Amount") +
          filterInputHtml("sbr-filter-wit", "Enter Withdrawal Amount") +
        "</div>" +
        '<div style="max-height:340px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:8px">' +
          '<table style="width:100%;border-collapse:collapse">' +
            '<thead style="position:sticky;top:0;z-index:1;background:#f9fafb;border-bottom:1px solid #e5e7eb"><tr>' +
              "<th></th>" +
              TH("Name") + TH("Date") + TH("Deposit", "right") + TH("Withdrawal", "right") +
            "</tr></thead>" +
            '<tbody class="sbr-cons-left-body">' + buildLeftRows(txns) + "</tbody>" +
          "</table>" +
        "</div>" +
      "</div>" +

      /* ── RIGHT ── */
      "<div>" +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding-bottom:8px;border-bottom:2px solid #e5e7eb">' +
          '<span style="font-weight:700;color:#111827">Selected to be Consolidated</span>' +
          '<span class="sbr-cons-count" style="min-width:22px;text-align:center;background:#3b82f6;color:white;border-radius:99px;padding:1px 8px;font-size:11px;font-weight:700">0</span>' +
        "</div>" +
        '<div style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">' +
          '<table style="width:100%;border-collapse:collapse">' +
            '<thead style="background:#f9fafb;border-bottom:1px solid #e5e7eb"><tr>' +
              TH("Name") + TH("Date") + TH("Deposit", "right") + TH("Withdrawal", "right") +
            "</tr></thead>" +
            '<tbody class="sbr-cons-right-body" style="max-height:240px;overflow-y:auto">' +
              '<tr><td colspan="4" style="text-align:center;color:#9ca3af;padding:28px 0;font-size:12px">No transactions selected yet</td></tr>' +
            "</tbody>" +
            '<tfoot class="sbr-cons-totals" style="display:none">' +
              '<tr style="background:#f0fdf4;font-weight:700;border-top:2px solid #bbf7d0">' +
                '<td colspan="2" style="padding:7px 10px;color:#374151">Totals</td>' +
                '<td class="sbr-cons-total-dep" style="padding:7px 10px;text-align:right;color:#16a34a">—</td>' +
                '<td class="sbr-cons-total-wit" style="padding:7px 10px;text-align:right;color:#dc2626">—</td>' +
              "</tr>" +
            "</tfoot>" +
          "</table>" +
        "</div>" +
      "</div>" +

      "</div>" // grid
    );

    var $wrap     = d.fields_dict.content.$wrapper;
    var $leftBody = $wrap.find(".sbr-cons-left-body");

    /* ─ filter inputs: re-render only the left tbody ─ */
    $wrap.on("input", ".sbr-filter-dep, .sbr-filter-wit", function () {
      var depVal = parseFloat($wrap.find(".sbr-filter-dep").val());
      var witVal = parseFloat($wrap.find(".sbr-filter-wit").val());
      var filtered = txns.filter(function (t) {
        var dep = parseFloat(t.deposit    || 0);
        var wit = parseFloat(t.withdrawal || 0);
        if (!isNaN(depVal) && dep < depVal) return false;
        if (!isNaN(witVal) && wit < witVal) return false;
        return true;
      });
      $leftBody.html(buildLeftRows(filtered));
      $wrap.find(".sbr-cons-avail-count").text(filtered.length + " available");
    });

    /* ─ bind checkbox + row-click events (event delegation, single binding) ─ */
    $leftBody.on("change", ".sbr-cons-chk", function () {
      var name = $(this).data("name");
      var txn  = txns.find(function (t) { return t.name === name; });
      if (!txn) return;
      if ($(this).is(":checked")) {
        selected[name] = txn;
        $(this).closest("tr").css("background", "#eff6ff");
      } else {
        delete selected[name];
        $(this).closest("tr").css("background", "");
      }
      syncRight();
    });

    $leftBody.on("click", ".sbr-cons-row", function (e) {
      if ($(e.target).is("input[type=checkbox]")) return;
      $(this).find(".sbr-cons-chk").trigger("click");
    });
  }

  /* ─── consolidate action ─── */
  function _doConsolidate() {
    var selArr = Object.values(selected);
    if (selArr.length < 2) {
      frappe.msgprint(__("Select at least 2 transactions to consolidate."));
      return;
    }
    frappe.call({
      method: "smart_bank_reconciliation.reconciliation.api.consolidate_transactions",
      args: {
        transaction_names: JSON.stringify(selArr.map(function (t) { return t.name; })),
        company: frm.doc.company || "",
      },
      btn: d.get_primary_btn(),
      freeze: true,
      freeze_message: __("Consolidating Transactions…"),
      callback: function (r) {
        if (r.exc) return;
        d.hide();
        var data = r.message;
        var txnUrl = "/app/bank-transaction/" + encodeURIComponent(data.bank_transaction);
        frappe.show_alert({
          message: data.count + __(" transactions consolidated → ") +
            '<a href="' + txnUrl + '" target="_blank">' + data.bank_transaction + "</a>",
          indicator: "green",
        }, 10);
        // Reload the transaction list so the new combined transaction appears
        setTimeout(function () { sbr_load_transactions(frm); }, 400);
      },
    });
  }

  /* ─── fetch transactions and render ─── */
  frappe.call({
    method: "smart_bank_reconciliation.reconciliation.api.get_consolidatable_transactions",
    args: { bank_account: bank_account, from_date: from_date, to_date: to_date },
    callback: function (r) {
      if (r.exc) { d.hide(); return; }
      txns = r.message || [];
      if (!txns.length) {
        d.fields_dict.content.$wrapper.html(
          '<div style="text-align:center;padding:48px 0;color:#9ca3af">' +
            '<div style="font-size:36px;margin-bottom:10px">📭</div>' +
            '<div style="font-size:14px">No unreconciled transactions found for this period.</div>' +
          "</div>"
        );
        d.get_primary_btn().prop("disabled", true);
        return;
      }
      renderLayout();
      syncRight();
    },
  });
}

/* ── Bind action button clicks (event delegation on $canvas) ── */
function sbr_bind_card_actions(frm, $canvas) {
  // Audit Trail tab — load on first click
  $canvas.off("click", ".sbr-tab[data-tab='audit']");
  $canvas.on("click", ".sbr-tab[data-tab='audit']", function () {
    if (frm._sbr_audit_loaded) return;
    var bank_account = frm.doc.bank_account;
    var from_date    = frm.doc.bank_statement_from_date;
    var to_date      = frm.doc.bank_statement_to_date;
    if (!bank_account || !from_date || !to_date) return;
    frm._sbr_audit_loaded = true;
    frappe.call({
      method: "smart_bank_reconciliation.reconciliation.api.get_audit_trail",
      args: { bank_account: bank_account, from_date: from_date, to_date: to_date },
      callback: function (r) {
        if (!r.exc) ReconUI.renderAuditTab($canvas, (r.message || {}).actions || []);
      },
    });
  });

  // Accept / reconcile
  $canvas.off("click", ".sbr-btn-accept:not(.sbr-banner-approve-btn)");
  $canvas.on("click", ".sbr-btn-accept:not(.sbr-banner-approve-btn)", function () {
    var $btn = $(this);
    // Guard against double-clicks and stacked handlers
    if ($btn.prop("disabled") || $btn.data("sbr-pending")) return;
    $btn.data("sbr-pending", true).prop("disabled", true).css("opacity", "0.6");

    var txn     = $btn.data("txn");
    var entries = $btn.data("entries") || [];
    var mtype   = $btn.data("type") || "";
    if (typeof entries === "string") {
      try { entries = JSON.parse(entries); } catch (e) { entries = []; }
    }
    frappe.confirm(__("Confirm reconciliation for {0}?", [txn]), function () {
      frappe.call({
        method: "smart_bank_reconciliation.reconciliation.api.approve_match",
        args: { bank_transaction: txn, matched_entries: entries, match_type: mtype },
        callback: function (r) {
          if (!r.exc) {
            frm._sbr_audit_loaded = false; // force audit tab to refresh
            $canvas.find('.sbr-row[data-txn="' + txn + '"]')
              .addClass("sbr-row-done")
              .attr("data-queue", "Reconciled")
              .find(".sbr-match-cell")
              .html('<span class="sbr-conf-badge sbr-conf-reconciled">✓ Reconciled</span>');
            $canvas.find('.sbr-card[data-txn="' + txn + '"]')
              .css("opacity", ".45")
              .find(".sbr-card-actions")
              .html('<p class="sbr-success">Reconciled.</p>');
          } else {
            // Re-enable button if the call failed so user can retry
            $btn.data("sbr-pending", false).prop("disabled", false).css("opacity", "");
          }
        },
      });
    }, function () {
      // User clicked "No" in the confirm dialog — re-enable the button
      $btn.data("sbr-pending", false).prop("disabled", false).css("opacity", "");
    });
  });

  // Banner approve-all button
  $canvas.off("click", ".sbr-banner-approve-btn");
  $canvas.on("click", ".sbr-banner-approve-btn", function () {
    sbr_bulk_approve(frm);
  });

  // Mark duplicate investigated
  $canvas.off("click", ".sbr-btn-dup");
  $canvas.on("click", ".sbr-btn-dup", function () {
    var txn = $(this).data("txn");
    frappe.call({
      method: "smart_bank_reconciliation.reconciliation.api.mark_duplicate_investigated",
      args: { bank_transaction: txn },
      callback: function () {
        $canvas.find('.sbr-card[data-txn="' + txn + '"]')
          .find(".sbr-card-actions")
          .html('<p class="sbr-empty">Marked as Investigated.</p>');
      },
    });
  });

  // Delete duplicate bank transaction
  $canvas.off("click", ".sbr-btn-del-dup");
  $canvas.on("click", ".sbr-btn-del-dup", function () {
    var $btn = $(this);
    if ($btn.prop("disabled") || $btn.data("sbr-pending")) return;
    var txn = $btn.data("txn");
    frappe.confirm(
      __("Permanently delete bank transaction <b>{0}</b>?<br><br>" +
         "This removes it from ERPNext. The remaining twin record will be " +
         "re-evaluated by AI so you can match and reconcile it.", [txn]),
      function () {
        $btn.data("sbr-pending", true).prop("disabled", true).css("opacity", "0.6");
        frappe.call({
          method: "smart_bank_reconciliation.reconciliation.api.delete_duplicate_transaction",
          args: { bank_transaction: txn },
          callback: function (r) {
            $btn.data("sbr-pending", false).prop("disabled", false).css("opacity", "");
            if (r.exc) return;
            $canvas.find('.sbr-card[data-txn="' + txn + '"]').fadeOut(200, function () {
              $(this).remove();
            });
            frappe.show_alert({
              message: __("{0} deleted. Re-running AI match…", [txn]),
              indicator: "green",
            });
            setTimeout(function () { sbr_load_transactions(frm); }, 500);
          },
        });
      },
      function () {
        // User clicked "No" — nothing to re-enable since we didn't disable yet
      }
    );
  });

  // ── Duplicate bulk-delete toolbar ──

  // Show/hide bulk toolbar when queue tab changes
  $canvas.off("click", ".sbr-sp-queue-tab");
  $canvas.on("click", ".sbr-sp-queue-tab", function () {
    var filter = $(this).data("filter");
    var $bar = $canvas.find(".sbr-dup-bulk-bar");
    if (filter === "Duplicate") {
      $bar.css("display", "flex");
    } else {
      $bar.hide();
      // Uncheck everything when leaving Duplicate view
      $canvas.find(".sbr-dup-chk, .sbr-dup-select-all").prop("checked", false);
      sbr_update_dup_sel_count($canvas);
    }
  });

  // Select-All checkbox
  $canvas.off("change", ".sbr-dup-select-all");
  $canvas.on("change", ".sbr-dup-select-all", function () {
    var checked = $(this).prop("checked");
    $canvas.find(".sbr-dup-chk:visible").prop("checked", checked);
    sbr_update_dup_sel_count($canvas);
  });

  // Individual checkbox change
  $canvas.off("change", ".sbr-dup-chk");
  $canvas.on("change", ".sbr-dup-chk", function () {
    var total = $canvas.find(".sbr-dup-chk:visible").length;
    var checked = $canvas.find(".sbr-dup-chk:visible:checked").length;
    $canvas.find(".sbr-dup-select-all").prop("indeterminate", checked > 0 && checked < total);
    $canvas.find(".sbr-dup-select-all").prop("checked", checked === total && total > 0);
    sbr_update_dup_sel_count($canvas);
  });

  // Delete Selected button
  $canvas.off("click", ".sbr-dup-del-selected");
  $canvas.on("click", ".sbr-dup-del-selected", function () {
    var selected = $canvas.find(".sbr-dup-chk:checked").map(function () {
      return $(this).data("txn");
    }).get();
    if (!selected.length) return;

    frappe.confirm(
      __("Delete <b>{0}</b> duplicate transaction(s)?<br><br>" +
         "They will be permanently removed from ERPNext. " +
         "Remaining records will be re-evaluated by AI.", [selected.length]),
      function () {
        frappe.call({
          method: "smart_bank_reconciliation.reconciliation.api.bulk_delete_duplicate_transactions",
          args: { bank_transactions: JSON.stringify(selected) },
          freeze: true,
          freeze_message: __("Deleting {0} duplicate(s)…", [selected.length]),
          callback: function (r) {
            if (r.exc) return;
            var res = r.message || {};
            res.deleted.forEach(function (txn) {
              $canvas.find('.sbr-card[data-txn="' + txn + '"]').fadeOut(150, function () {
                $(this).remove();
              });
            });
            var msg = res.count + " duplicate(s) deleted.";
            if ((res.skipped || []).length) {
              msg += " " + res.skipped.length + " skipped (not in Duplicate queue).";
            }
            frappe.show_alert({ message: msg + " Re-running AI match…", indicator: "green" });
            setTimeout(function () { sbr_load_transactions(frm); }, 600);
          },
        });
      }
    );
  });

  // High-value approval
  $canvas.off("click", ".sbr-btn-hv");
  $canvas.on("click", ".sbr-btn-hv", function () {
    var txn = $(this).data("txn");
    frappe.prompt(
      [{ label: "Approver Note", fieldname: "note", fieldtype: "Data" }],
      function (vals) {
        frappe.call({
          method: "smart_bank_reconciliation.reconciliation.api.approve_high_value",
          args: { bank_transaction: txn, approver_note: vals.note },
          callback: function (r) {
            if (!r.exc) frappe.msgprint(r.message.message);
          },
        });
      },
      __("High-Value Approval"), __("Submit Approval")
    );
  });

  // Escalate to AR
  $canvas.off("click", ".sbr-btn-escalate");
  $canvas.on("click", ".sbr-btn-escalate", function () {
    var txn = $(this).data("txn");
    frappe.call({
      method: "smart_bank_reconciliation.reconciliation.api.escalate_to_ar",
      args: { bank_transaction: txn },
      callback: function () {
        $canvas.find('.sbr-card[data-txn="' + txn + '"]')
          .find(".sbr-card-actions")
          .html('<p class="sbr-empty">Escalated to AR/AP team.</p>');
      },
    });
  });

  // Update Bank Transaction — reuses ERPNext V13 native update_bank_transaction backend
  $canvas.off("click", ".sbr-btn-update");
  $canvas.on("click", ".sbr-btn-update", function () {
    sbr_open_update_transaction_dialog($(this).data("txn"));
  });

  // Re-run AI on Selected (toolbar button, visible when ≥1 row checked)
  $canvas.off("click", ".sbr-toolbar-rerun-sel");
  $canvas.on("click", ".sbr-toolbar-rerun-sel", function () {
    sbr_rerun_selected(frm);
  });

  // Consolidate Selected (toolbar button, visible when ≥2 rows checked)
  // Directly consolidates the already-checked rows without reopening the dialog.
  $canvas.off("click", ".sbr-toolbar-consolidate-sel");
  $canvas.on("click", ".sbr-toolbar-consolidate-sel", function () {
    var names = [];
    $canvas.find(".sbr-row-check:checked").each(function () {
      names.push($(this).data("txn"));
    });
    if (names.length < 2) {
      frappe.msgprint(__("Select at least 2 transactions to consolidate."));
      return;
    }
    frappe.confirm(
      __("Consolidate {0} selected transaction(s) into one combined Bank Transaction?", [names.length]),
      function () {
        frappe.call({
          method: "smart_bank_reconciliation.reconciliation.api.consolidate_transactions",
          args: {
            transaction_names: JSON.stringify(names),
            company: frm.doc.company || "",
          },
          freeze: true,
          freeze_message: __("Consolidating Transactions…"),
          callback: function (r) {
            if (r.exc) return;
            var data = r.message;
            $canvas.find(".sbr-row-check, .sbr-select-all").prop("checked", false);
            $canvas.find(".sbr-toolbar-rerun-sel, .sbr-toolbar-consolidate-sel").hide();
            frappe.show_alert({
              message: data.count + __(" transactions consolidated → ") +
                '<a href="/app/bank-transaction/' + encodeURIComponent(data.bank_transaction) +
                '" target="_blank">' + data.bank_transaction + "</a>",
              indicator: "green",
            }, 10);
            setTimeout(function () { sbr_load_transactions(frm); }, 400);
          },
        });
      }
    );
  });

  // Actions button → Reconcile modal
  $canvas.off("click", ".sbr-row-action-btn");
  $canvas.on("click", ".sbr-row-action-btn", function () {
    var txnName = $(this).data("txn");
    $canvas.find(".sbr-row").removeClass("sbr-row-active");
    $(this).closest(".sbr-row").addClass("sbr-row-active");
    ReconUI.renderReconcileModal($canvas, txnName, function (result, $modal) {
      sbr_handle_modal_confirm(frm, $canvas, txnName, result, $modal);
    });
  });

  // Unreconcile button on reconciled rows
  $canvas.off("click", ".sbr-btn-unreconcile");
  $canvas.on("click", ".sbr-btn-unreconcile", function (e) {
    e.stopPropagation();
    sbr_open_unreconcile_dialog(frm, $canvas, $(this).data("txn"));
  });

  // Create draft PE / JE
  $canvas.on("click", ".sbr-btn-draft", function () {
    var txn   = $(this).data("txn");
    var etype = $(this).data("etype") || "JE";
    var draft = $(this).data("draft");
    if (typeof draft === "string") {
      try { draft = JSON.parse(draft); } catch (e) { draft = {}; }
    }
    frappe.call({
      method: "smart_bank_reconciliation.reconciliation.api.create_draft_entry",
      args: { bank_transaction: txn, entry_type: etype, prefill: draft },
      callback: function (r) {
        if (!r.exc) {
          var url = "/app/" + r.message.doctype.toLowerCase().replace(/ /g, "-") +
                    "/" + encodeURIComponent(r.message.name);
          window.open(url, "_blank");
        }
      },
    });
  });

  // View Details button on pair cards → open Reconcile Modal
  $canvas.on("click", ".sbr-pair-detail-btn", function (e) {
    e.stopPropagation();
    var txnName = $(this).data("txn");
    ReconUI.renderReconcileModal($canvas, txnName, function (result, $modal) {
      sbr_handle_modal_confirm(frm, $canvas, txnName, result, $modal);
    });
  });

  // ── Inline upload zone (shown in Bank Transactions tab when 0 transactions) ──
  $canvas.off("click", ".sbr-inline-choose");
  $canvas.on("click", ".sbr-inline-choose", function () {
    $canvas.find("#sbr-inline-file").trigger("click");
  });

  $canvas.on("change", "#sbr-inline-file", function () {
    var file = this.files && this.files[0];
    if (!file) return;
    if (!frm.doc.bank_account) {
      frappe.msgprint(__("Please select a Bank Account before importing."));
      return;
    }
    var $cv = $canvas;
    sbr_load_file(file, function (parsed) { sbr_show_inline_preview($cv, parsed); });
  });

  $canvas.off("click", ".sbr-inline-download");
  $canvas.on("click", ".sbr-inline-download", function () {
    var blob = new Blob([SBR_DEMO_CSV], { type: "text/csv" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = "sample_bank_statement.csv"; a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });

  $canvas.on("dragover dragenter", ".sbr-inline-drop-zone", function (e) {
    e.preventDefault(); e.stopPropagation();
    $(this).addClass("sbr-drop-hover");
  });
  $canvas.on("dragleave", ".sbr-inline-drop-zone", function () {
    $(this).removeClass("sbr-drop-hover");
  });
  $canvas.on("drop", ".sbr-inline-drop-zone", function (e) {
    e.preventDefault(); e.stopPropagation();
    $(this).removeClass("sbr-drop-hover");
    var file = e.originalEvent.dataTransfer.files && e.originalEvent.dataTransfer.files[0];
    if (!file) return;
    if (!frm.doc.bank_account) {
      frappe.msgprint(__("Please select a Bank Account before importing."));
      return;
    }
    var $cv = $canvas;
    sbr_load_file(file, function (parsed) { sbr_show_inline_preview($cv, parsed); });
  });

  $canvas.off("click", ".sbr-inline-reset-btn");
  $canvas.on("click", ".sbr-inline-reset-btn", function () {
    var $up = $canvas.find(".sbr-inline-upload");
    $up.find(".sbr-inline-preview, .sbr-inline-import-row").hide();
    $up.find(".sbr-inline-drop-zone, .sbr-inline-btns").show();
    $up.find("#sbr-inline-file").val("");
    $up.removeData("parsed");
  });

  $canvas.off("click", ".sbr-inline-import");
  $canvas.on("click", ".sbr-inline-import", function () {
    var parsed = $canvas.find(".sbr-inline-upload").data("parsed");
    if (!parsed || !parsed.rows || !parsed.rows.length) return;
    if (!frm.doc.bank_account) {
      frappe.msgprint(__("Please select a Bank Account before importing."));
      return;
    }
    sbr_do_import(frm, $canvas, parsed);
  });
}

/* ── Shared CSV helpers (used by both inline zone and modal) ── */
var SBR_DEMO_CSV = [
  "Date,Description,Debit,Credit,Reference",
  "2025-02-01,/CHARGE/FT/GTB/TRANSFER PYMT DANGOTE CEMENT PLC,0,15000000,FT/GTB/2025020001",
  "2025-02-01,STAMPDUTY 01-02-2025 ON AMT 15000000,50,0,STAMPDUTY/020101",
  "2025-02-03,/CHARGE/FT/GTB/PAYMENT FOR PRODUCTS RENDERED,0,3500000,FT/GTB/2025020002",
  "2025-02-05,/CHARGE/FT/GTB/SUPPLY CHAIN POD LOGISTICS LTD,0,2800000,FT/GTB/2025020003",
  "2025-02-07,/CHARGE/FT/GTB/TRANSFER PYMT FLOUR MILLS OF NIGERIA,0,9000000,FT/GTB/2025020004",
  "2025-02-10,COT CHARGE FEB 2025,5000,0,COT/FEB25",
  "2025-02-12,/CHARGE/FT/GTB/PAYMENT CADBURY NIGERIA PLC,0,4200000,FT/GTB/2025020005",
  "2025-02-14,BANK INTEREST CREDIT FEB 2025,0,125000,INT/FEB25",
  "2025-02-18,/CHARGE/FT/GTB/TRANSFER PYMT AIRTEL NETWORKS NIGERIA,0,1800000,FT/GTB/2025020006",
  "2025-02-25,/CHARGE/FT/GTB/PAYMENT FOR PRODUCTS RECOVERED,4185580,0,FT/GTB/2025020007",
].join("\n");

function sbr_update_dup_sel_count($canvas) {
  var n = $canvas.find(".sbr-dup-chk:checked").length;
  $canvas.find(".sbr-dup-sel-count").text(n);
  var $btn = $canvas.find(".sbr-dup-del-selected");
  $btn.prop("disabled", n === 0).css("opacity", n === 0 ? "0.5" : "1");
}

function sbr_parse_csv(text) {
  var lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  var headers = lines[0].split(",").map(function (h) { return h.trim().replace(/^"|"$/g, ""); });
  var rows = [];
  for (var i = 1; i < lines.length; i++) {
    var vals = lines[i].split(",").map(function (v) { return v.trim().replace(/^"|"$/g, ""); });
    if (vals.every(function (v) { return !v; })) continue;
    var row = {};
    headers.forEach(function (h, idx) { row[h] = vals[idx] || ""; });
    rows.push(row);
  }
  return { headers: headers, rows: rows };
}

/* ── Multi-format file loader (CSV/TXT: client-side; XLSX/MT940: server-side) ── */
function sbr_load_file(file, onParsed) {
  var name = (file.name || "").toLowerCase();
  var isBinary = /\.(xlsx|xls|mt940|sta|940|mt9)$/.test(name);

  if (!isBinary) {
    // CSV/TXT — read as text and parse locally
    var reader = new FileReader();
    reader.onload = function (e) { onParsed(sbr_parse_csv(e.target.result)); };
    reader.readAsText(file);
    return;
  }

  // Binary formats — send base64 to server for parsing
  var reader = new FileReader();
  reader.onload = function (e) {
    var dataUrl = e.target.result;
    // dataUrl is "data:<mime>;base64,<payload>" — strip the prefix
    var b64 = dataUrl.split(",")[1] || dataUrl;
    frappe.call({
      method: "smart_bank_reconciliation.reconciliation.api.parse_statement_file",
      args: { file_b64: b64, filename: file.name },
      callback: function (r) {
        if (r.exc || !r.message) {
          frappe.msgprint(__("Could not parse the file. Check the format and try again."));
          return;
        }
        onParsed({ headers: r.message.headers, rows: r.message.rows });
      },
    });
  };
  reader.readAsDataURL(file);
}

function sbr_norm_date(s) {
  if (!s) return "";
  var str = String(s).trim();
  // "2022-12-31 00:00:00" → "2022-12-31"
  var iso = str.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  // Bank statements use dd-mm-yyyy (or dd/mm/yyyy) — always day-first, never mm-dd-yyyy.
  var dmy = str.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  if (dmy) {
    var dd = dmy[1].length < 2 ? "0" + dmy[1] : dmy[1];
    var mm = dmy[2].length < 2 ? "0" + dmy[2] : dmy[2];
    return dmy[3] + "-" + mm + "-" + dd;
  }
  return str;
}

function sbr_detect_col(headers, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    for (var j = 0; j < headers.length; j++) {
      if (headers[j].toLowerCase() === candidates[i].toLowerCase()) return headers[j];
    }
  }
  return headers[0] || "";
}

/* ── Shared import + AI run (called by demo button and import button) ── */
function sbr_do_import(frm, $canvas, parsed) {
  if (!parsed || !parsed.rows || !parsed.rows.length) return;
  var h = parsed.headers;
  var dateCol  = sbr_detect_col(h, ["date", "Date", "VALUE DATE", "Value Date", "Trans Date", "Tran Date", "Transaction Date"]);
  var descCol  = sbr_detect_col(h, ["description", "Description", "narration", "Narration", "Particulars", "Transaction Details", "Details", "Remarks"]);
  var debitCol = sbr_detect_col(h, ["debit", "Debit", "DEBIT", "withdrawal", "Withdrawals"]);
  var credCol  = sbr_detect_col(h, ["credit", "Credit", "CREDIT", "deposit", "Deposits"]);
  var refCol   = sbr_detect_col(h, ["reference", "Reference", "REF", "Cheque No", "Transaction ID"]);
  var rows = parsed.rows.map(function (r) {
    return {
      date:        sbr_norm_date(r[dateCol])  || "",
      description: r[descCol]  || "",
      debit:       parseFloat(r[debitCol]  || 0) || 0,
      credit:      parseFloat(r[credCol]   || 0) || 0,
      reference:   r[refCol]   || "",
    };
  });

  // Derive date range from the imported rows and update form fields.
  // Only trust strictly valid ISO dates here — a stray unparseable value (blank cell,
  // footer/summary row, unrecognized format) would otherwise sort to position 0 or
  // the last slot and get fed straight into the date field, which Frappe's Date
  // control then rejects with a confusing "Invalid date must be in format..." popup.
  var csvDates = rows.map(function (r) { return r.date; })
    .filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); })
    .sort();
  var fromDate = csvDates.length ? csvDates[0] : frm.doc.bank_statement_from_date;
  var toDate   = csvDates.length ? csvDates[csvDates.length - 1] : frm.doc.bank_statement_to_date;
  frm.doc.bank_statement_from_date = sbr_norm_date(fromDate);
  frm.doc.bank_statement_to_date   = sbr_norm_date(toDate);
  frm.refresh_field("bank_statement_from_date");
  frm.refresh_field("bank_statement_to_date");

  // Show spinner while importing + analyzing
  var $wrap = $canvas.find('.sbr-tab-content[data-tab="bank"] .sbr-table-wrap');
  $wrap.html(
    '<div style="padding:64px 32px;text-align:center;color:#64748b">' +
    '<div class="sbr-spinner" style="margin:0 auto 14px"></div>' +
    '<div style="font-size:13px">Importing ' + parsed.rows.length + ' transactions &amp; running AI…</div>' +
    '</div>'
  );

  frm.page.set_indicator(__("Running..."), "orange");

  frappe.call({
    method: "smart_bank_reconciliation.reconciliation.api.import_and_analyze",
    args: {
      bank_account: frm.doc.bank_account,
      rows:         JSON.stringify(rows),
      company:      frm.doc.company || "",
      from_date:    fromDate,
      to_date:      toDate,
    },
    callback: function (r) {
      if (r.exc) {
        sbr_render_inline_upload(frm, $canvas);
        frm.page.set_indicator(__("Error"), "red");
        return;
      }
      var data = r.message;
      var imp = data.import || {};
      // import count toast suppressed intentionally

      ReconUI.renderTransactionTable($canvas, data.transactions);
      ReconUI.updateTabBadge($canvas, "bank", data.transactions.length);
      ReconUI.renderSummaryTiles($canvas, data.queue_counts);
      sbr_inject_unmatched_suggestions(data);
      ReconUI.renderSuggestionsPanel($canvas, data.suggestions);
      ReconUI.renderAIBanner($canvas, data.queue_counts);
      ReconUI.filterByQueue($canvas, null);
      ReconUI.switchTab($canvas, "bank");

      frm._sbr_ai_done = true;
      frm._sbr_auto_count = (data.queue_counts || {}).auto || 0;
      frm._sbr_review_count = (data.queue_counts || {}).review || 0;
      sbr_build_toolbar(frm);
      frm.page.set_indicator(__("Done"), "green");

      // Surface aging ERP entries after import + AI run
      frappe.call({
        method: "smart_bank_reconciliation.reconciliation.api.get_aging_erp_entries",
        args: {
          bank_account: frm.doc.bank_account,
          from_date:    frm.doc.bank_statement_from_date,
          to_date:      frm.doc.bank_statement_to_date,
          company:      frm.doc.company || "",
        },
        callback: function (ar) {
          if (!ar.exc && ar.message && (ar.message.entries || []).length) {
            ReconUI.renderAgingErpAlerts($canvas, ar.message.entries, ar.message.aging_days);
          }
        },
      });

      // Refresh ERP tab with the same date range
      frm._sbr_erp_default_loaded = false;
      sbr_schedule_erp_default_load(frm);
    },
  });
}

/* ── Inline upload zone (rendered inside Bank Transactions tab when 0 rows) ── */
function sbr_render_inline_upload(frm, $canvas) {
  var $wrap = $canvas.find('.sbr-tab-content[data-tab="bank"] .sbr-table-wrap');
  $wrap.html(
    '<div class="sbr-inline-upload">' +
      '<div class="sbr-inline-drop-zone" id="sbr-inline-drop">' +
        '<div class="sbr-inline-drop-icon"></div>' +
        '<div class="sbr-inline-drop-title">Drop your bank statement here, or click to upload</div>' +
        '<div class="sbr-inline-drop-sub">Supports CSV, Excel (.xlsx), and MT940/STA &middot; columns: Date, Description, Reference, Debit, Credit</div>' +
      '</div>' +
      '<input type="file" id="sbr-inline-file" accept=".csv,.txt,.xlsx,.xls,.mt940,.sta,.940" style="display:none">' +
      '<div class="sbr-inline-btns">' +
        '<button class="sbr-inline-btn-primary sbr-inline-choose" type="button">Choose File</button>' +
        '<button class="sbr-inline-btn-outline sbr-inline-download" type="button">&#8595; Download Sample CSV</button>' +
      '</div>' +
      '<div class="sbr-inline-preview" style="display:none"></div>' +
      '<div class="sbr-inline-import-row" style="display:none">' +
        '<button class="sbr-inline-reset-btn" type="button">&#8629; Change file</button>' +
        '<button class="sbr-inline-btn-primary sbr-inline-import" type="button">Import &amp; Run AI</button>' +
      '</div>' +
    '</div>'
  );
}

function sbr_show_inline_preview($canvas, data) {
  var $up = $canvas.find(".sbr-inline-upload");
  if (!data || !data.rows || !data.rows.length) return;
  $up.data("parsed", data);
  var h = data.headers;
  var dateCol  = sbr_detect_col(h, ["date", "Date", "VALUE DATE", "Trans Date", "Transaction Date"]);
  var descCol  = sbr_detect_col(h, ["description", "Description", "narration", "Narration", "Particulars"]);
  var debitCol = sbr_detect_col(h, ["debit", "Debit", "DEBIT", "withdrawal", "Withdrawals"]);
  var credCol  = sbr_detect_col(h, ["credit", "Credit", "CREDIT", "deposit", "Deposits"]);
  var refCol   = sbr_detect_col(h, ["reference", "Reference", "REF", "Cheque No", "Transaction ID"]);
  function fmtN(n) { var v = parseFloat(n) || 0; return v > 0 ? ReconUI.fmtCurrency(v) : ""; }
  var previewRows = data.rows.slice(0, 5).map(function (r) {
    return "<tr>" +
      "<td style='white-space:nowrap'>" + (r[dateCol] || "") + "</td>" +
      "<td style='max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'>" + (r[descCol] || "") + "</td>" +
      '<td style="color:#dc2626;font-variant-numeric:tabular-nums">' + fmtN(r[debitCol]) + "</td>" +
      '<td style="color:#16a34a;font-variant-numeric:tabular-nums">' + fmtN(r[credCol]) + "</td>" +
      "<td style='font-family:ui-monospace,monospace;font-size:11px;color:#64748b'>" + (r[refCol] || "") + "</td>" +
      "</tr>";
  }).join("");
  var extra = data.rows.length > 5
    ? '<p style="font-size:12px;color:#94a3b8;margin:6px 0 0">+ ' + (data.rows.length - 5) + " more rows</p>" : "";
  $up.find(".sbr-inline-drop-zone, .sbr-inline-btns").hide();
  $up.find(".sbr-inline-preview").html(
    '<div style="font-weight:600;font-size:13px;color:#0f172a;margin-bottom:8px">' +
      data.rows.length + " rows ready to import" +
    '</div>' +
    '<div style="overflow-x:auto"><table class="sbr-table" style="margin:0"><thead><tr>' +
      "<th>Date</th><th>Description</th><th>Debit (" + ReconUI.currencySymbol() + ")</th><th>Credit (" + ReconUI.currencySymbol() + ")</th><th>Reference</th>" +
    "</tr></thead><tbody>" + previewRows + "</tbody></table></div>" + extra
  ).show();
  $up.find(".sbr-inline-import-row").show();
  $up.find(".sbr-inline-import").prop("disabled", false);
}

/* ── Upload Bank Statement modal ── */
function sbr_open_upload_modal(frm, $canvas) {
  $(".sbr-upload-overlay").remove();

  /* Sample Nigerian bank statement CSV */
  var DEMO_CSV = [
    "Date,Description,Debit,Credit,Reference",
    "2026-07-01,/CHARGE/FT/GTB/TRANSFER PYMT DANGOTE CEMENT PLC,0,15000000,FT/GTB/2026070001",
    "2026-07-01,/CHARGE/FT/GTB/PAYMENT FOR PRODUCTS RENDERED,0,3500000,FT/GTB/2026070002",
    "2026-07-02,STAMPDUTY 02-07-2026 ON AMT 5000000,50,0,STAMPDUTY/070202",
    "2026-07-02,/CHARGE/FT/GTB/SUPPLY CHAIN POD LOGISTICS,0,2800000,FT/GTB/2026070003",
    "2026-07-03,/CHARGE/FT/GTB/TRANSFER PYMT FLOUR MILLS OF NIGERIA,0,9000000,FT/GTB/2026070004",
    "2026-07-03,COT CHARGE JULY 2026,5000,0,COT/JUL26",
    "2026-07-04,/CHARGE/FT/GTB/PAYMENT CADBURY NIGERIA PLC,0,4200000,FT/GTB/2026070005",
    "2026-07-05,BANK INTEREST CREDIT JULY 2026,0,125000,INT/JUL26",
    "2026-07-05,/CHARGE/FT/GTB/TRANSFER PYMT AIRTEL NETWORKS NIGERIA,0,1800000,FT/GTB/2026070006",
    "2026-07-07,/CHARGE/FT/GTB/PAYMENT FOR PRODUCTS RECOVERED,4185580,0,FT/GTB/2026070007",
  ].join("\n");

  /* Simple CSV parser — handles quoted fields */
  function parseCsv(text) {
    var lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return null;
    var headers = lines[0].split(",").map(function (h) { return h.trim().replace(/^"|"$/g, ""); });
    var rows = [];
    for (var i = 1; i < lines.length; i++) {
      var vals = lines[i].split(",").map(function (v) { return v.trim().replace(/^"|"$/g, ""); });
      if (vals.every(function (v) { return !v; })) continue;
      var row = {};
      headers.forEach(function (h, idx) { row[h] = vals[idx] || ""; });
      rows.push(row);
    }
    return { headers: headers, rows: rows };
  }

  /* Auto-detect which header maps to each semantic column */
  function detectCol(headers, candidates) {
    for (var i = 0; i < candidates.length; i++) {
      for (var j = 0; j < headers.length; j++) {
        if (headers[j].toLowerCase() === candidates[i].toLowerCase()) return headers[j];
      }
    }
    return headers[0] || "";
  }

  var overlayHtml =
    '<div class="sbr-upload-overlay" role="dialog" aria-modal="true">' +
      '<div class="sbr-upload-modal">' +
        '<div class="sbr-modal-header">' +
          '<div>' +
            '<div class="sbr-modal-title">Upload Bank Statement</div>' +
            '<div class="sbr-modal-subtitle">Import CSV, Excel, or MT940 · auto-detect columns · run AI matching</div>' +
          '</div>' +
          '<button class="sbr-modal-close sbr-upload-close" type="button" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="sbr-upload-body">' +
          '<div class="sbr-upload-zone" id="sbr-drop-zone">' +
            '<div class="sbr-upload-icon">↑</div>' +
            '<div class="sbr-upload-zone-title">Drop a bank statement file here</div>' +
            '<div class="sbr-upload-zone-sub">or <label class="sbr-upload-browse" for="sbr-file-input">browse your computer</label></div>' +
            '<input type="file" id="sbr-file-input" accept=".csv,.txt,.xlsx,.xls,.mt940,.sta,.940" style="display:none">' +
            '<div class="sbr-upload-zone-hint">CSV · Excel (.xlsx/.xls) · MT940/STA &nbsp;|&nbsp; Columns: Date · Description · Debit · Credit · Reference</div>' +
          '</div>' +
          '<div class="sbr-upload-preview" style="display:none"></div>' +
        '</div>' +
        '<div class="sbr-modal-footer">' +
          '<div style="flex:1"></div>' +
          '<button class="sbr-btn sbr-upload-cancel" type="button">Cancel</button>' +
          '<button class="sbr-btn sbr-btn-accept sbr-upload-import" type="button" disabled>Import & Run AI</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  var $overlay = $(overlayHtml);
  $("body").append($overlay);
  var parsedData = null;

  function fmt(n) {
    var v = parseFloat(n) || 0;
    return v > 0 ? ReconUI.fmtCurrency(v) : "";
  }

  function showPreview(data) {
    parsedData = data;
    if (!data || !data.rows || !data.rows.length) {
      $overlay.find(".sbr-upload-zone").show();
      $overlay.find(".sbr-upload-preview").hide();
      $overlay.find(".sbr-upload-import").prop("disabled", true);
      return;
    }

    var h = data.headers;
    var dateCol  = detectCol(h, ["date", "Date", "VALUE DATE", "Value Date", "Trans Date", "Tran Date", "Transaction Date"]);
    var descCol  = detectCol(h, ["description", "Description", "narration", "Narration", "Particulars", "Transaction Details", "Details", "Remarks"]);
    var debitCol = detectCol(h, ["debit", "Debit", "DEBIT", "withdrawal", "Withdrawals"]);
    var credCol  = detectCol(h, ["credit", "Credit", "CREDIT", "deposit", "Deposits"]);
    var refCol   = detectCol(h, ["reference", "Reference", "REF", "Cheque No", "Transaction ID"]);

    $overlay.data("col-map", { date: dateCol, description: descCol, debit: debitCol, credit: credCol, reference: refCol });

    var previewRows = data.rows.slice(0, 5).map(function (r) {
      return "<tr>" +
        "<td style='white-space:nowrap'>" + (r[dateCol] || "") + "</td>" +
        "<td style='max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'>" + (r[descCol] || "") + "</td>" +
        '<td style="color:#dc2626;font-variant-numeric:tabular-nums">' + fmt(r[debitCol]) + "</td>" +
        '<td style="color:#16a34a;font-variant-numeric:tabular-nums">' + fmt(r[credCol]) + "</td>" +
        "<td style='font-family:ui-monospace,monospace;font-size:11px;color:#64748b'>" + (r[refCol] || "") + "</td>" +
        "</tr>";
    }).join("");

    var extraNote = data.rows.length > 5
      ? '<p style="font-size:12px;color:#94a3b8;margin:6px 0 0">+ ' + (data.rows.length - 5) + " more rows</p>"
      : "";

    $overlay.find(".sbr-upload-zone").hide();
    $overlay.find(".sbr-upload-preview").html(
      '<div class="sbr-upload-preview-header">' +
        '<span style="font-weight:600;font-size:13px;color:#0f172a">' + data.rows.length + " rows ready to import</span>" +
        '<button class="sbr-btn sbr-upload-reset" type="button" style="padding:3px 10px;font-size:11px">↩ Change file</button>' +
      "</div>" +
      '<div style="overflow-x:auto;margin-top:10px">' +
      '<table class="sbr-table" style="margin:0"><thead><tr>' +
        "<th>Date</th><th>Description</th><th>Debit (" + ReconUI.currencySymbol() + ")</th><th>Credit (" + ReconUI.currencySymbol() + ")</th><th>Reference</th>" +
      "</tr></thead><tbody>" + previewRows + "</tbody></table></div>" +
      extraNote
    ).show();

    $overlay.find(".sbr-upload-import").prop("disabled", false);
  }

  /* File input */
  $overlay.on("change", "#sbr-file-input", function () {
    var file = this.files && this.files[0];
    if (!file) return;
    sbr_load_file(file, showPreview);
  });

  /* Drag-and-drop */
  var $zone = $overlay.find("#sbr-drop-zone");
  $zone.on("dragover dragenter", function (e) {
    e.preventDefault(); e.stopPropagation();
    $zone.addClass("sbr-drop-hover");
  });
  $zone.on("dragleave drop", function () { $zone.removeClass("sbr-drop-hover"); });
  $zone.on("drop", function (e) {
    e.preventDefault(); e.stopPropagation();
    var file = e.originalEvent.dataTransfer.files && e.originalEvent.dataTransfer.files[0];
    if (!file) return;
    sbr_load_file(file, showPreview);
  });


  /* Reset to drop zone */
  $overlay.on("click", ".sbr-upload-reset", function () {
    parsedData = null;
    $overlay.find(".sbr-upload-preview").hide();
    $overlay.find(".sbr-upload-zone").show();
    $overlay.find(".sbr-upload-import").prop("disabled", true);
    $overlay.find("#sbr-file-input").val("");
  });

  /* Close */
  function closeModal() { $overlay.remove(); $(document).off("keydown.sbrupload"); }
  $overlay.on("click", ".sbr-upload-close, .sbr-upload-cancel", closeModal);
  $overlay.on("click", function (e) { if ($(e.target).hasClass("sbr-upload-overlay")) closeModal(); });
  $(document).on("keydown.sbrupload", function (e) { if (e.key === "Escape") closeModal(); });

  /* Import */
  $overlay.on("click", ".sbr-upload-import", function () {
    if (!parsedData || !parsedData.rows || !parsedData.rows.length) return;

    var colMap = $overlay.data("col-map") || {};
    var rows = parsedData.rows.map(function (r) {
      return {
        date:        sbr_norm_date(r[colMap.date]        || r["date"]        || r["Date"]        || ""),
        description: r[colMap.description] || r["description"] || r["Description"] || "",
        debit:       parseFloat(r[colMap.debit]  || r["debit"]  || r["Debit"]  || 0) || 0,
        credit:      parseFloat(r[colMap.credit] || r["credit"] || r["Credit"] || 0) || 0,
        reference:   r[colMap.reference]   || r["reference"]   || r["Reference"]   || "",
      };
    });

    var $btn = $(this).text("Importing…").prop("disabled", true);

    frappe.call({
      method: "smart_bank_reconciliation.reconciliation.api.import_bank_statement",
      args: {
        bank_account: frm.doc.bank_account,
        rows:         JSON.stringify(rows),
        company:      frm.doc.company || "",
      },
      callback: function (r) {
        if (r.exc) { $btn.text("Import & Run AI").prop("disabled", false); return; }
        var d = r.message;
        closeModal();
        var msg = d.created + " transaction" + (d.created !== 1 ? "s" : "") + " imported.";
        if (d.skipped) msg += " (" + d.skipped + " skipped)";
        msg += " Running AI matching…";
        frappe.show_alert({ message: msg, indicator: "blue" }, 6);
        sbr_run_suggestions(frm);
      },
    });
  });
}

