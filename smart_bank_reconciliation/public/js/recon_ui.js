/* recon_ui.js — Rendering helpers for Bank Reconciliation panel (Phase 2) */

window.ReconUI = (function () {

  /* ── Inject V15 Sticky Fix ── */
  if (!document.getElementById("sbr-v15-sticky-fix")) {
    var style = document.createElement("style");
    style.id = "sbr-v15-sticky-fix";
    style.innerHTML = `
      .sbr-table-wrap { overflow: auto !important; max-height: 65vh !important; }
      .sbr-table thead th { position: sticky !important; top: 0 !important; z-index: 10 !important; background: #f8fafc !important; }
      .sbr-txn-table .sbr-idx-col, .sbr-txn-table .sbr-date-col { position: sticky !important; z-index: 11 !important; background: #fff !important; }
      .sbr-txn-table .sbr-idx-col { left: 36px !important; }
      .sbr-txn-table .sbr-date-col { left: 76px !important; }
      .sbr-table td.sbr-check-col, .sbr-table th.sbr-check-col { position: sticky !important; left: 0 !important; z-index: 11 !important; background: #fff !important; }
      .sbr-table thead th.sbr-check-col, .sbr-txn-table thead th.sbr-idx-col, .sbr-txn-table thead th.sbr-date-col { z-index: 15 !important; background: #f8fafc !important; }
    `;
    document.head.appendChild(style);
  }


  /* ── Constants ── */

  var QUEUE_COLOR = {
    "Auto":       { bg: "#DCFCE7", text: "#16A34A", border: "#16A34A" },
    "Review":     { bg: "#FEF3C7", text: "#D97706", border: "#D97706" },
    "Unmatched":  { bg: "#FEE2E2", text: "#DC2626", border: "#DC2626" },
    "High-Val":   { bg: "#EDE9FE", text: "#7C3AED", border: "#7C3AED" },
    "Duplicate":  { bg: "#FEE2E2", text: "#B91C1C", border: "#B91C1C" },
    "Aging":      { bg: "#FFEDD5", text: "#EA580C", border: "#EA580C" },
    "Reconciled": { bg: "#F1F5F9", text: "#64748B", border: "#CBD5E1" },
  };

  var SIGNAL_LABEL = {
    amount: "amount", reference: "reference", date: "date",
    party: "party", side: "side", history: "history",
  };

  // position: sticky silently stops working if any ancestor between the
  // sticky element and its scrolling container (.sbr-table-wrap) has a
  // transform/filter/perspective/contain — properties some Frappe/ERPNext
  // versions or other installed apps set on desk chrome wrappers for
  // unrelated reasons. Neutralize any such ancestor found above each
  // table-wrap so sticky headers/columns keep working regardless of what
  // the surrounding page does.
  var STICKY_BREAKER_PROPS = ["transform", "filter", "perspective", "contain", "willChange"];
  var STICKY_BREAKER_DEFAULTS = { transform: "none", filter: "none", perspective: "none", contain: "none", willChange: "auto" };
  function _neutralizeStickyBreakers($scope) {
    $scope.find(".sbr-table-wrap").each(function () {
      // Pass 1: ancestors above the wrap must not create a new containing
      // block (transform/filter/perspective/contain/will-change), or every
      // sticky descendant inside the wrap silently stops sticking.
      var el = this.parentElement;
      var hops = 0;
      while (el && el !== document.body && hops < 15) {
        var cs = window.getComputedStyle(el);
        STICKY_BREAKER_PROPS.forEach(function (prop) {
          var val = cs[prop];
          if (val && val !== STICKY_BREAKER_DEFAULTS[prop]) {
            el.style.setProperty(
              prop.replace(/[A-Z]/g, function (c) { return "-" + c.toLowerCase(); }),
              STICKY_BREAKER_DEFAULTS[prop],
              "important"
            );
          }
        });
        el = el.parentElement;
        hops++;
      }

      // Pass 2: .sbr-table-wrap only becomes its own scroll container (and
      // therefore a meaningful sticky boundary) if its max-height is
      // actually honored. Flex/grid items default to min-height:auto,
      // which lets them grow past a declared max-height instead of
      // scrolling internally — so if the wrap (or any ancestor up to the
      // nearest sized box) sits inside a flex/grid layout, force
      // min-height:0 the whole way up so the height constraint reaches it
      // and the wrap actually scrolls in place instead of the whole page
      // scrolling with it.
      var node = this;
      hops = 0;
      while (node && node !== document.body && hops < 40) {
        var parent = node.parentElement;
        if (parent) {
          var parentDisplay = window.getComputedStyle(parent).display;
          if (parentDisplay === "flex" || parentDisplay === "inline-flex" ||
              parentDisplay === "grid" || parentDisplay === "inline-grid") {
            if (window.getComputedStyle(node).minHeight !== "0px") {
              node.style.setProperty("min-height", "0", "important");
            }
          }
        }
        node = parent;
        hops++;
      }
    });
  }

  function _guessEntryRoute(name) {
    var n = (name || "").toUpperCase();
    if (n.indexOf("-JV-")    !== -1) return "journal-entry";
    if (n.indexOf("-PINV-")  !== -1) return "purchase-invoice";
    if (n.indexOf("-SI-")    !== -1) return "sales-invoice";
    if (n.indexOf("-PI-")    !== -1) return "purchase-invoice";
    if (n.indexOf("SINV-")   !== -1) return "sales-invoice";
    if (/^INV-/.test(n))             return "sales-invoice";
    if (/^PINV-/.test(n))            return "purchase-invoice";
    return "payment-entry";
  }

  function _entryRoute(entryType, name) {
    if (entryType === "Payment Entry")    return "payment-entry";
    if (entryType === "Journal Entry")    return "journal-entry";
    if (entryType === "Sales Invoice")    return "sales-invoice";
    if (entryType === "Purchase Invoice") return "purchase-invoice";
    return _guessEntryRoute(name);
  }

  function _entryTypeShort(entryType) {
    if (entryType === "Payment Entry")    return "PE";
    if (entryType === "Journal Entry")    return "JE";
    if (entryType === "Sales Invoice")    return "SI";
    if (entryType === "Purchase Invoice") return "PI";
    return "ERP";
  }

  var TILE_TO_QUEUE = {
    "AUTO": "Auto", "REVIEW": "Review", "UNMATCHED": "Unmatched",
    "HIGH-VAL": "High-Val", "DUPES": "Duplicate", "AGING": "Aging", "RECONCILED": "Reconciled",
  };

  /* ── Currency (resolved per bank account — NOT hardcoded to Naira) ── */
  // Set once recon_form_extension.js resolves the selected bank account's
  // currency (Bank Account -> Account -> account_currency). Falls back to
  // the system default currency (via frappe's own format_currency/
  // get_currency_symbol) until then, so behavior is unchanged for sites
  // that never call setCurrency.
  var _currencyCode = null;

  function setCurrency(code) {
    _currencyCode = code || null;
  }

  function currencySymbol() {
    if (typeof get_currency_symbol === "function") {
      return get_currency_symbol(_currencyCode) || "";
    }
    return "₦"; // pre-fix fallback, only hit if core helper is unavailable
  }

  function fmtCurrency(val) {
    var v = parseFloat(val) || 0;
    if (typeof format_currency === "function") {
      return format_currency(v, _currencyCode, 2);
    }
    return "₦" + v.toLocaleString("en-NG", {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }

  /* ── Simple helpers ── */

  function queueBadge(queue) {
    var c = QUEUE_COLOR[queue] || { bg: "#F1F5F9", text: "#64748B", border: "#CBD5E1" };
    return '<span class="sbr-badge" style="background:' + c.bg +
           ';color:' + c.text + ';border-color:' + c.border + '">' +
           (queue || "—") + "</span>";
  }

  function _agingBucketMatch(days, bucket) {
    if (!bucket) return true;
    if (days < 0) return false; // unknown date — exclude from a specific range, not "All"
    switch (bucket) {
      case "0-30":   return days >= 0   && days <= 30;
      case "31-60":  return days >= 31  && days <= 60;
      case "61-90":  return days >= 61  && days <= 90;
      case "91-120": return days >= 91  && days <= 120;
      case "120+":   return days > 120;
      default:       return true;
    }
  }

  function _confBucketMatch(pct, bucket) {
    if (!bucket) return true;
    switch (bucket) {
      case "0-10":  return pct >= 0  && pct <= 10;
      case "11-50": return pct >= 11 && pct <= 50;
      case "51-79": return pct >= 51 && pct <= 79;
      case "80+":   return pct >= 80;
      default:      return true;
    }
  }

  function formatAmount(val) {
    if (!val) return "—";
    return fmtCurrency(val);
  }

  function confidenceBar(pct) {
    // Defensive clamp — older records saved before the backend confidence
    // clamp could carry an out-of-range value; never render a bar/label
    // outside 0-100%.
    pct = Math.max(0, Math.min(100, pct || 0));
    var color = pct >= 90 ? "#16A34A" : pct >= 50 ? "#D97706" : "#DC2626";
    return '<div class="sbr-conf-bar-wrap">' +
      '<div class="sbr-conf-bar-fill" style="width:' + pct + '%;background:' + color + '"></div>' +
      '</div><span class="sbr-conf-pct" style="color:' + color + '">' + pct.toFixed(1) + "%</span>";
  }

  function signalBadges(signals) {
    if (!signals) return "";
    var html = '<div class="sbr-signal-row">';
    Object.keys(signals).forEach(function (k) {
      var v = Math.max(0, Math.min(100, Math.round(signals[k])));
      var ok = v >= 80 ? "#16A34A" : v >= 50 ? "#D97706" : "#DC2626";
      html += '<span class="sbr-signal-chip" style="color:' + ok + ';border-color:' + ok + '">' +
              (SIGNAL_LABEL[k] || k) + " " + v + "%</span>";
    });
    return html + "</div>";
  }

  // Confidence badge for Match column (Phase 2 — replaces queue badge)
  function confidenceBadge(pct, queue) {
    if (queue === "Reconciled") {
      return '<span class="sbr-conf-badge sbr-conf-reconciled">✓ Reconciled</span>';
    }
    if (!pct || pct <= 0) {
      return '<span style="color:#cbd5e1;font-size:12px">—</span>';
    }
    pct = Math.min(100, pct);
    var level, cls;
    if (pct >= 90)      { level = "HIGH"; cls = "sbr-conf-high"; }
    else if (pct >= 60) { level = "MED";  cls = "sbr-conf-med";  }
    else                { level = "LOW";  cls = "sbr-conf-low";  }
    return '<span class="sbr-conf-badge ' + cls + '">▲ ' + Math.round(pct) + "% " + level + "</span>";
  }

  /* ── Tab shell ── */

  function renderTabShell($container, bankCount) {
    if ($container.find(".sbr-tab-bar").length) return; // already built

    var $inner = $container.find(".sbr-panel-inner");

    // Balance bar — populated later by renderBalanceSummary
    $inner.append(
      '<div class="sbr-balance-bar">' +
        '<span class="sbr-balance-placeholder">Balance summary loading…</span>' +
      '</div>'
    );

    // AI analysis banner — hidden until AI runs
    $inner.append('<div class="sbr-ai-banner" style="display:none"></div>');

    // Tab bar
    $inner.append(
      '<div class="sbr-tab-bar">' +
        '<button class="sbr-tab sbr-tab-active" data-tab="bank">Bank Transactions' +
          ' <span class="sbr-tab-badge">' + (bankCount || 0) + "</span></button>" +
        '<button class="sbr-tab" data-tab="erp">ERP Vouchers' +
          ' <span class="sbr-tab-badge">0</span></button>' +
        '<button class="sbr-tab" data-tab="ai">AI Match Pairs' +
          ' <span class="sbr-tab-badge">0</span></button>' +
        '<button class="sbr-tab" data-tab="audit">Audit Trail' +
          ' <span class="sbr-tab-badge">0</span></button>' +
      "</div>"
    );

    // Tab content areas
    $inner.append(
      '<div class="sbr-tab-content sbr-tab-active" data-tab="bank">' +
        '<div class="sbr-bank-toolbar">' +
          '<select class="sbr-queue-filter">' +
            '<option value="">All Queues</option>' +
            '<option value="Auto">Auto-Match</option>' +
            '<option value="Review">Review</option>' +
            '<option value="Unmatched">Unmatched</option>' +
            '<option value="High-Val">High-Value</option>' +
            '<option value="Duplicate">Duplicate</option>' +
            '<option value="Aging">Aging</option>' +
            '<option value="Reconciled">Reconciled</option>' +
          "</select>" +
          '<select class="sbr-party-type-filter">' +
            '<option value="">All Party Types</option>' +
            '<option value="Customer">Customer</option>' +
            '<option value="Supplier">Supplier</option>' +
            '<option value="Employee">Employee</option>' +
          "</select>" +
          '<select class="sbr-confidence-filter">' +
            '<option value="">All Confidence</option>' +
            '<option value="0-10">0–10%</option>' +
            '<option value="11-50">11–50%</option>' +
            '<option value="51-79">51–79%</option>' +
            '<option value="80+">80%+</option>' +
          "</select>" +
          '<input type="text" class="sbr-search-input" placeholder="Search description, reference, party…" ' +
            'style="flex:1;min-width:180px;max-width:340px;padding:5px 10px;border:1px solid #c7d2fe;border-radius:6px;font-size:12px;color:#374151;background:#fff">' +
          '<span class="sbr-txn-counter"></span>' +
          '<div class="sbr-toolbar-sel-btns">' +
            '<button class="sbr-toolbar-rerun-sel" type="button" style="display:none">↺ Re-run Selected</button>' +
            '<button class="sbr-toolbar-consolidate-sel" type="button" style="display:none">↕ Consolidate Selected</button>' +
            '<button class="sbr-toolbar-sel-btn sbr-toolbar-select-all" type="button">Select All</button>' +
            '<button class="sbr-toolbar-sel-btn sbr-toolbar-clear-sel" type="button">Clear</button>' +
          "</div>" +
        "</div>" +
        '<div class="sbr-table-wrap" style="max-height: 65vh; overflow-y: auto; overflow-x: auto; position: relative; border: 1px solid #e2e8f0; border-radius: 6px; background: #fff;"></div>' +
      "</div>" +
      '<div class="sbr-tab-content" data-tab="erp" style="display:none">' +
        '<p class="sbr-empty" style="padding:24px 0">ERP Vouchers appear here after loading. ' +
        'Load transactions first, then run AI Match All.</p>' +
      "</div>" +
      '<div class="sbr-tab-content" data-tab="ai" style="display:none">' +
        '<div class="sbr-suggestion-panel sbr-suggestion-panel-tab"></div>' +
      "</div>" +
      '<div class="sbr-tab-content sbr-audit-tab" data-tab="audit" style="display:none">' +
        '<p class="sbr-empty sbr-audit-empty" style="padding:32px 16px;color:#94a3b8">No actions recorded yet. ' +
        'Actions appear here after you Approve transactions.</p>' +
      "</div>"
    );

    // Tab click
    $container.on("click", ".sbr-tab", function () {
      switchTab($container, $(this).data("tab"));
    });

    // Queue dropdown change
    $container.on("change", ".sbr-queue-filter", function () {
      filterByQueue($container, $(this).val() || null, true);
    });

    // Party Type dropdown change
    $container.on("change", ".sbr-party-type-filter", function () {
      $container.data("sbr-party-type-filter", $(this).val() || null);
      applyFilters($container);
    });

    // Confidence dropdown change (Bank Transactions table)
    $container.on("change", ".sbr-confidence-filter", function () {
      $container.data("sbr-confidence-filter", $(this).val() || null);
      applyFilters($container);
    });

    // Aging / Confidence sub-filter dropdowns (AI Match Pairs cards)
    $container.on("change", ".sbr-aging-range-filter", function () {
      $container.data("sbr-aging-range-filter", $(this).val() || null);
      applyFilters($container);
    });
    $container.on("change", ".sbr-conf-range-filter", function () {
      $container.data("sbr-conf-range-filter", $(this).val() || null);
      applyFilters($container);
    });

    // Text search — combines with active queue filter and party type filter
    $container.on("input", ".sbr-search-input", function () {
      $container.data("sbr-text-filter", $(this).val() || "");
      applyFilters($container);
    });

    // Helper: show/hide selection-context buttons based on checked count
    function updateConsolidateBtn() {
      var n = $container.find(".sbr-row-check:checked").length;
      var $consBtn  = $container.find(".sbr-toolbar-consolidate-sel");
      var $rerunBtn = $container.find(".sbr-toolbar-rerun-sel");
      if (n >= 2) {
        $consBtn.text("↕ Consolidate Selected (" + n + ")").show();
      } else {
        $consBtn.hide();
      }
      if (n >= 1) {
        $rerunBtn.text("↺ Re-run Selected (" + n + ")").show();
      } else {
        $rerunBtn.hide();
      }
    }

    // Select All button — checks only visible (filtered) rows
    $container.on("click", ".sbr-toolbar-select-all", function () {
      $container.find(".sbr-row:visible .sbr-row-check").prop("checked", true);
      $container.find(".sbr-select-all").prop("checked", true);
      updateConsolidateBtn();
    });

    // Clear button — unchecks everything
    $container.on("click", ".sbr-toolbar-clear-sel", function () {
      $container.find(".sbr-row-check, .sbr-select-all").prop("checked", false);
      updateConsolidateBtn();
    });

    // Individual / header checkboxes — keep Consolidate button in sync
    $container.on("change", ".sbr-row-check, .sbr-select-all", function () {
      setTimeout(updateConsolidateBtn, 0);
    });

  }

  function switchTab($container, tabName) {
    $container.find(".sbr-tab").removeClass("sbr-tab-active");
    $container.find('.sbr-tab[data-tab="' + tabName + '"]').addClass("sbr-tab-active");
    $container.find(".sbr-tab-content").hide().removeClass("sbr-tab-active");
    $container.find('.sbr-tab-content[data-tab="' + tabName + '"]').show().addClass("sbr-tab-active");
  }

  function updateTabBadge($container, tabName, count) {
    $container.find('.sbr-tab[data-tab="' + tabName + '"] .sbr-tab-badge').text(count);
  }

  /* ── Summary tiles ── */

  function renderSummaryTiles($container, counts) {
    var tiles = [
      { key: "total",      label: "TOTAL",      color: "#1D4ED8" },
      { key: "auto",       label: "AUTO",       color: "#16A34A" },
      { key: "review",     label: "REVIEW",     color: "#D97706" },
      { key: "unmatched",  label: "UNMATCHED",  color: "#DC2626" },
      { key: "high_val",   label: "HIGH-VAL",   color: "#7C3AED" },
      { key: "duplicate",  label: "DUPES",      color: "#B91C1C" },
      { key: "aging",      label: "AGING",      color: "#EA580C" },
      { key: "reconciled", label: "RECONCILED", color: "#64748B" },
    ];
    var html = '<div class="sbr-tiles">';
    tiles.forEach(function (t) {
      var n = counts[t.key] || 0;
      html += '<div class="sbr-tile" data-queue="' + t.label +
              '" style="border-top:3px solid ' + t.color + '">' +
              '<div class="sbr-tile-num" style="color:' + t.color + '">' + n + "</div>" +
              '<div class="sbr-tile-label">' + t.label + "</div>" +
              "</div>";
    });
    html += "</div>";

    var $tiles = $container.find(".sbr-tiles");
    if ($tiles.length) {
      $tiles.replaceWith(html);
    } else {
      $container.find(".sbr-panel-inner").prepend(html);
    }

    $container.find(".sbr-tile").on("click", function () {
      var tileLabel = $(this).data("queue");
      var queueName = tileLabel === "TOTAL" ? null : (TILE_TO_QUEUE[tileLabel] || null);
      filterByQueue($container, queueName);
      // Queues with AI suggestion cards (Auto/Review/Unmatched/High-Val/Duplicate/
      // Aging) live on the AI Match Pairs tab. Total and Reconciled have no cards
      // there — they're plain rows on the Bank Transactions tab, so route there
      // instead of leaving the user stuck on whatever tab was already open.
      if (queueName && tileLabel !== "RECONCILED" && $container.find(".sbr-card").length) {
        switchTab($container, "ai");
      } else {
        switchTab($container, "bank");
      }
    });
  }

  /* ── Balance summary bar ── */

  function renderBalanceSummary($container, balance) {
    if (!balance) return;
    var bankClosing = parseFloat(balance.bank_closing || 0);
    var erpClosing  = parseFloat(balance.erp_closing  || 0);
    var diff        = bankClosing - erpClosing;
    var diffStyle   = Math.abs(diff) < 0.01 ? "color:#16a34a" : "color:#dc2626";
    var diffSign    = diff < 0 ? "−" : diff > 0 ? "+" : "";

    $container.find(".sbr-balance-bar").html(
      '<div class="sbr-balance-item">' +
        '<div class="sbr-balance-label">Closing Balance as per Bank Statement</div>' +
        '<div class="sbr-balance-val">' + (bankClosing ? formatAmount(bankClosing) : '<span style="color:#94a3b8;font-size:12px">Not entered</span>') + "</div>" +
      "</div>" +
      '<div class="sbr-balance-sep"></div>' +
      '<div class="sbr-balance-item">' +
        '<div class="sbr-balance-label">Closing Balance as per ERP</div>' +
        '<div class="sbr-balance-val">' + formatAmount(erpClosing) + "</div>" +
      "</div>" +
      '<div class="sbr-balance-sep"></div>' +
      '<div class="sbr-balance-item">' +
        '<div class="sbr-balance-label">Difference</div>' +
        '<div class="sbr-balance-val" style="' + diffStyle + '">' +
          (Math.abs(diff) < 0.01 ? fmtCurrency(0) : diffSign + formatAmount(Math.abs(diff))) +
        "</div>" +
      "</div>"
    );
  }

  /* ── AI Analysis banner ── */

  function renderAIBanner($container, counts) {
    var total     = counts.total     || 0;
    var auto      = counts.auto      || 0;
    var review    = counts.review    || 0;
    var unmatched = counts.unmatched || 0;
    var rate      = total > 0 ? Math.round((auto / total) * 100) : 0;

    $container.find(".sbr-ai-banner").html(
      '<span class="sbr-ai-banner-icon">✦</span>' +
      '<span class="sbr-ai-banner-title">AI Analysis Complete</span>' +
      '<span class="sbr-ai-banner-sep">|</span>' +
      '<span class="sbr-ai-stat"><span class="sbr-ai-dot" style="color:#1d4ed8">●</span> ' + auto + " Auto-matched</span>" +
      '<span class="sbr-ai-stat"><span class="sbr-ai-dot" style="color:#d97706">●</span> ' + review + " Review</span>" +
      '<span class="sbr-ai-stat"><span class="sbr-ai-dot" style="color:#dc2626">●</span> ' + unmatched + " Unmatched</span>" +
      '<span class="sbr-ai-stat"><span class="sbr-ai-dot" style="color:#7c3aed">●</span> ' + (counts.draft || 0) + " Draft entry</span>" +
      '<span class="sbr-ai-stat sbr-ai-stat-rate">' + rate + "% Automation Rate</span>" +
      '<div class="sbr-ai-banner-actions">' +
        '<button class="sbr-btn sbr-btn-accept sbr-banner-approve-btn">' +
          "✓ Approve All Auto (" + auto + ")</button>" +
      "</div>"
    );
    // Only relevant while looking at the Auto queue — don't leave it showing
    // (and the approve-all action available) on every other tile/tab.
    var activeQueue = $container.data("sbr-queue-filter") || null;
    $container.find(".sbr-ai-banner").css("display", activeQueue === "Auto" ? "flex" : "none");
  }

  /* ── Filter by queue ── */

  function applyFilters($container) {
    var queueName  = $container.data("sbr-queue-filter") || null;
    var partyType  = $container.data("sbr-party-type-filter") || null;
    var txt = ($container.data("sbr-text-filter") || "").toLowerCase().trim();
    var confRangeTable = $container.data("sbr-confidence-filter") || null;
    var agingRange = queueName === "Aging" ? ($container.data("sbr-aging-range-filter") || null) : null;
    var confRange  = (queueName === "Review" || queueName === "Aging")
      ? ($container.data("sbr-conf-range-filter") || null) : null;

    var total = 0, visible = 0;
    $container.find(".sbr-row").each(function () {
      total++;
      var $row = $(this);
      var rowQueue = $row.attr("data-queue") || "";
      var queueOk  = !queueName || rowQueue === queueName ||
                     (queueName === "Unmatched" && rowQueue === "");
      var ptOk     = !partyType  || $row.data("party-type")  === partyType;
      var textOk   = !txt || ($row.data("search-text") || "").indexOf(txt) !== -1;
      var confOk   = _confBucketMatch(parseFloat($row.data("confidence")) || 0, confRangeTable);
      if (queueOk && ptOk && textOk && confOk) { $row.show(); visible++; }
      else                                      { $row.hide(); }
    });
    if (total > 0) {
      $container.find(".sbr-txn-counter").text(
        (queueName || txt || partyType || confRangeTable)
          ? "Showing " + visible + " of " + total + " transactions"
          : total + " transactions"
      );
    }

    var visibleCardTxns = [];
    $container.find(".sbr-card").each(function () {
      var $card = $(this);
      var cardQueue = $card.data("queue") || "";
      var cardOk = !queueName
        || cardQueue === queueName
        || (queueName === "Unmatched" && cardQueue === "");
      var agingOk = _agingBucketMatch(parseInt($card.data("aging-days"), 10), agingRange);
      var confOk  = _confBucketMatch(parseFloat($card.data("confidence")) || 0, confRange);
      if (cardOk && agingOk && confOk) {
        $card.show();
        if (queueName === "Review" || queueName === "Aging") visibleCardTxns.push($card.data("txn"));
      } else {
        $card.hide();
      }
    });

    // Show/hide the Aging / Confidence sub-filter bars alongside their queue tab.
    // Confidence filtering is also offered on Aging (not just Review) — aging
    // cards already carry a real data-confidence score, so the same bucket
    // logic applies unchanged; both filters can be used together on Aging.
    $container.find(".sbr-aging-filter-bar").css("display", queueName === "Aging" ? "inline-flex" : "none");
    $container.find(".sbr-conf-filter-bar").css("display",
      (queueName === "Review" || queueName === "Aging") ? "inline-flex" : "none");

    // "Approve All Auto" only makes sense while looking at the Auto queue —
    // it was previously left visible on every tile/tab once AI Match ran.
    $container.find(".sbr-ai-banner").css("display", queueName === "Auto" ? "flex" : "none");

    // Bulk-approve-filtered — Review/Aging only, count/enable tracks
    // whatever is currently visible under the active filters.
    var $bulkBar = $container.find(".sbr-bulk-approve-bar");
    if (queueName === "Review" || queueName === "Aging") {
      $bulkBar.css("display", "flex");
      $bulkBar.find(".sbr-bulk-approve-count").text(visibleCardTxns.length);
      $bulkBar.data("sbr-visible-txns", visibleCardTxns);
      $bulkBar.find(".sbr-bulk-approve-filtered-btn")
        .prop("disabled", !visibleCardTxns.length)
        .css("opacity", visibleCardTxns.length ? "1" : "0.5");
    } else {
      $bulkBar.hide();
    }

    // Show/hide duplicate bulk-action toolbar whenever filter changes
    var $dupBar = $container.find(".sbr-dup-bulk-bar");
    if (queueName === "Duplicate") {
      $dupBar.css("display", "flex");
    } else {
      if ($dupBar.is(":visible")) {
        $container.find(".sbr-dup-chk, .sbr-dup-select-all").prop("checked", false);
        $dupBar.find(".sbr-dup-sel-count").text("0");
        $dupBar.find(".sbr-dup-del-selected").prop("disabled", true).css("opacity", "0.5");
      }
      $dupBar.hide();
    }

    var $panel = $container.find(".sbr-suggestion-panel");
    $panel.find(".sbr-sp-queue-tab").removeClass("sbr-sp-queue-tab-active").css("background", "#fff");
    var $activeTab = $panel.find('.sbr-sp-queue-tab[data-filter="' + (queueName || "all") + '"]');
    if ($activeTab.length) {
      $activeTab.addClass("sbr-sp-queue-tab-active");
      var c = queueName ? (QUEUE_COLOR[queueName] || {}) : {};
      $activeTab.css("background", queueName ? (c.bg || "#f8fafc") : "#EFF6FF");
    }
  }

  function filterByQueue($container, queueName, fromDropdown) {
    // Highlight matching tile
    $container.find(".sbr-tile").removeClass("sbr-tile-active");
    if (!queueName) {
      $container.find('.sbr-tile[data-queue="TOTAL"]').addClass("sbr-tile-active");
    } else {
      var tileLabel = null;
      Object.keys(TILE_TO_QUEUE).forEach(function (k) {
        if (TILE_TO_QUEUE[k] === queueName) tileLabel = k;
      });
      if (tileLabel) {
        $container.find('.sbr-tile[data-queue="' + tileLabel + '"]').addClass("sbr-tile-active");
      }
    }

    // Sync dropdown (unless change came from dropdown itself)
    if (!fromDropdown) {
      $container.find(".sbr-queue-filter").val(queueName || "");
    }

    $container.data("sbr-queue-filter", queueName || null);

    // The Review queue can never contain an 80%+ match — matching_engine
    // caps confidence below the Auto threshold for anything force-routed to
    // Review (reversal, WHT deduction, duplicate-voucher risk, etc.) — so
    // offering "80%+" as a filter there is misleading (it can only ever
    // return zero rows). Hide it, and if it was already selected when the
    // user switches into Review, fall back to "All Confidence".
    var $eightyOpt = $container.find('.sbr-confidence-filter option[value="80+"]');
    if (queueName === "Review") {
      $eightyOpt.hide().prop("disabled", true);
      if ($container.find(".sbr-confidence-filter").val() === "80+") {
        $container.find(".sbr-confidence-filter").val("");
        $container.data("sbr-confidence-filter", null);
      }
    } else {
      $eightyOpt.show().prop("disabled", false);
    }

    applyFilters($container);
  }

  /* ── Transaction table ── */

  function _matchedEntryHtml(t) {
    var rawEntries = t.recon_matched_entries;
    if (!rawEntries) return "—";
    try {
      var entryNames = typeof rawEntries === "string" ? JSON.parse(rawEntries) : rawEntries;
      if (entryNames && entryNames.length) {
        return entryNames.map(function (en) {
          var route = _guessEntryRoute(en);
          var href = route ? "/app/" + route + "/" + encodeURIComponent(en) : "/app/bank-transaction";
          return '<a class="sbr-link" data-erp-entry="' + encodeURIComponent(en) + '" href="' + href +
                 '" target="_blank" onclick="event.stopPropagation()">' + en + "</a>";
        }).join("<br>");
      }
    } catch (e) {}
    return "—";
  }

  var _entryRouteCache = {};
  function _resolveEntryLinks($scope) {
    var names = [];
    $scope.find(".sbr-link[data-erp-entry]").each(function () {
      var n = decodeURIComponent($(this).attr("data-erp-entry"));
      if (!(n in _entryRouteCache) && names.indexOf(n) === -1) names.push(n);
    });
    function applyCache() {
      $scope.find(".sbr-link[data-erp-entry]").each(function () {
        var n = decodeURIComponent($(this).attr("data-erp-entry"));
        var route = _entryRouteCache[n];
        if (route) $(this).attr("href", "/app/" + route + "/" + encodeURIComponent(n));
      });
    }
    if (!names.length) {
      applyCache();
      return;
    }
    frappe.call({
      method: "smart_bank_reconciliation.reconciliation.api.resolve_entry_doctypes",
      args: { names: names },
      callback: function (r) {
        var map = (r && r.message) || {};
        Object.keys(map).forEach(function (n) { _entryRouteCache[n] = map[n]; });
        applyCache();
      },
    });
  }

  /* Column header for Date/Deposit/Withdrawal/AI Match — click toggles
     ascending/descending, reordering the already-rendered rows in place
     (see _sortTable) rather than re-fetching or rebuilding the table. */
  function _sortableHeader(extraClass, field, label) {
    // white-space:nowrap keeps the arrow glued to the end of the label on
    // the same line — without it, the header's normal wrap/break-word rule
    // (needed elsewhere for long labels in narrow columns) can push just the
    // arrow span onto its own line underneath, misaligning the header row.
    // overflow/ellipsis is a safety net if a label is ever too long to fit.
    return '<th class="sbr-sortable ' + extraClass + '" data-sort-field="' + field +
      '" style="cursor:pointer;user-select:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="Click to sort">' +
      label + ' <span class="sbr-sort-arrow" data-sort-field="' + field + '" style="color:#4f46e5;display:inline-block;width:10px;vertical-align:baseline;line-height:1"></span></th>';
  }

  /* Reorder the rendered .sbr-row elements by a data-* attribute already on
     each row (data-date / data-deposit / data-withdrawal / data-confidence)
     — no re-render, no server round-trip, and filter visibility (a separate
     show/hide toggle on the same rows) is untouched. */
  function _sortTable($container, field, dir) {
    var $tbody = $container.find(".sbr-txn-table tbody");
    // jQuery collections have no native .sort() (they're array-like, not
    // real Arrays) — pull plain DOM elements out with .get() to sort them.
    var rows = $tbody.find(".sbr-row").detach().get();
    var isNumeric = field !== "date";
    rows.sort(function (a, b) {
      var av = a.getAttribute("data-" + field) || "";
      var bv = b.getAttribute("data-" + field) || "";
      if (isNumeric) {
        av = parseFloat(av) || 0;
        bv = parseFloat(bv) || 0;
        return dir === "asc" ? av - bv : bv - av;
      }
      if (av === bv) return 0;
      var cmp = av < bv ? -1 : 1;
      return dir === "asc" ? cmp : -cmp;
    });
    $tbody.append(rows);
    // Renumber the "#" column to match the new visual order.
    rows.forEach(function (row, i) {
      $(row).find(".sbr-idx-col").text(i + 1);
    });

    $container.find(".sbr-sort-arrow").text("");
    $container.find('.sbr-sort-arrow[data-sort-field="' + field + '"]').text(dir === "asc" ? "▲" : "▼");
  }

  function renderTransactionTable($container, transactions) {
    if (!transactions || !transactions.length) {
      $container.find(".sbr-table-wrap").html(
        '<p class="sbr-empty" style="padding:16px">No transactions found for this period.</p>'
      );
      $container.find(".sbr-txn-counter").text("0 transactions");
      return { totalDeposit: 0, totalWithdrawal: 0, netBalance: parseFloat($container.data("sbr-opening-balance")) || 0 };
    }

    // Running balance follows true chronological order over every individual
    // real bank statement line — computed BEFORE any consolidation grouping
    // collapses rows, so a merged group's display date (its latest member)
    // never distorts the balance of transactions that fall between its
    // members' actual dates.
    var openingBalance = parseFloat($container.data("sbr-opening-balance")) || 0;
    var chronological = transactions.slice().sort(function (a, b) {
      return new Date(a.date) - new Date(b.date);
    });
    var runningBalance = {};
    var runningBal = openingBalance;
    chronological.forEach(function (t) {
      runningBal += (parseFloat(t.deposit) || 0) - (parseFloat(t.withdrawal) || 0);
      runningBalance[t.name] = runningBal;
    });

    // Consolidated groups collapse into a single display row — WITHOUT any
    // new field: recon_run_id ("Last Run ID") is a pre-existing custom field
    // that nothing else in this app reads or writes, repurposed purely as
    // the Consolidate group key (set identically on every member by
    // _consolidate_via_existing_match in api.py, whether or not a match was
    // found — that's what lets an UNMATCHED group collapse into one row too,
    // not just a matched one).
    var byName = {};
    transactions.forEach(function (t) { byName[t.name] = t; });
    var groups = {};       // group key -> [txn names]
    var groupOf = {};      // txn name -> group key
    transactions.forEach(function (t) {
      if (t.recon_match_type !== "Consolidated" || !t.recon_run_id) return;
      var key = t.recon_run_id;
      (groups[key] = groups[key] || []).push(t.name);
      groupOf[t.name] = key;
    });
    // A "group" of exactly one isn't a group — leave it as a normal row.
    Object.keys(groups).forEach(function (key) {
      if (groups[key].length < 2) {
        groups[key].forEach(function (n) { delete groupOf[n]; });
        delete groups[key];
      }
    });
    $container.data("sbr-groups", groups);

    var displayTransactions = [];
    var addedGroup = {};
    transactions.forEach(function (t) {
      var key = groupOf[t.name];
      if (!key) { displayTransactions.push(t); return; }
      if (addedGroup[key]) return;
      addedGroup[key] = true;
      var members = groups[key].map(function (n) { return byName[n]; }).filter(Boolean);
      var rep = members.slice().sort(function (a, b) { return a.name < b.name ? -1 : 1; })[0];
      var totalDep = 0, totalWit = 0, totalUnalloc = 0, latest = members[0];
      members.forEach(function (m) {
        totalDep     += parseFloat(m.deposit) || 0;
        totalWit     += parseFloat(m.withdrawal) || 0;
        totalUnalloc += parseFloat(m.unallocated_amount) || 0;
        if (new Date(m.date) > new Date(latest.date)) latest = m;
      });
      displayTransactions.push($.extend({}, rep, {
        deposit: totalDep,
        withdrawal: totalWit,
        unallocated_amount: totalUnalloc,
        date: latest.date,
        description: "Consolidated (" + members.length + " txns): " +
          members.map(function (m) { return m.name; }).join(", "),
        _consolidatedBalanceKey: latest.name,
      }));
    });
    transactions = displayTransactions;

    // Consolidated entries (grouped or individually-unmatched) surface at
    // the top of the Bank Transactions list so it's immediately obvious
    // which rows were consolidated and what they matched against —
    // everything else keeps its original order.
    transactions = transactions.slice().sort(function (a, b) {
      var aC = a.recon_match_type === "Consolidated" ? 0 : 1;
      var bC = b.recon_match_type === "Consolidated" ? 0 : 1;
      return aC - bC;
    });

    // Store for modal and consolidate access — the collapsed/display list,
    // since every current reader only needs correct per-row totals and
    // name-based lookup, both of which the collapsed rows still satisfy.
    $container.data("transactions", transactions);

    var totalDeposit = 0, totalWithdrawal = 0;
    transactions.forEach(function (t) {
      totalDeposit    += parseFloat(t.deposit)    || 0;
      totalWithdrawal += parseFloat(t.withdrawal) || 0;
    });
    var netBalance = openingBalance + totalDeposit - totalWithdrawal;

    var html = '<table class="sbr-table sbr-txn-table" style="border-collapse: separate; border-spacing: 0;"><colgroup>' +
      '<col style="width:36px"><col style="width:40px"><col style="width:108px">' +
      '<col style="width:220px"><col style="width:130px"><col style="width:130px">' +
      '<col style="width:130px"><col style="width:150px"><col style="width:180px">' +
      '<col style="width:110px"><col style="width:140px"><col style="width:100px">' +
      '</colgroup><thead><tr>' +
      '<th class="sbr-check-col"><input type="checkbox" class="sbr-select-all" title="Select all visible"></th>' +
      '<th class="sbr-idx-col">#</th>' +
      _sortableHeader("sbr-date-col", "date", "Date") +
      "<th>Description / Narration</th>" +
      _sortableHeader("", "deposit", "Deposit (" + currencySymbol() + ")") +
      _sortableHeader("", "withdrawal", "Withdrawal (" + currencySymbol() + ")") +
      "<th>Unallocated (" + currencySymbol() + ")</th>" +
      "<th>Balance (" + currencySymbol() + ")</th>" +
      "<th>Reference No.</th>" +
      _sortableHeader("", "confidence", "AI Match") +
      "<th>Matched ERP Entry</th>" +
      "<th>Actions</th>" +
      "</tr></thead><tbody>";

    transactions.forEach(function (t, idx) {
      var queue = t.recon_queue || "";
      var pct   = parseFloat(t.recon_confidence) || 0;
      var matchCell = confidenceBadge(pct, queue);
      var isReconciled = queue === "Reconciled";

      var matchedEntryHtml = _matchedEntryHtml(t);

      var searchText = [t.description, t.reference_number, t.party]
        .filter(Boolean).join(" ").toLowerCase().replace(/"/g, "");
      html += '<tr class="sbr-row' + (isReconciled ? " sbr-row-done" : "") + '"' +
              ' data-txn="' + t.name + '" data-queue="' + queue + '"' +
              ' data-party-type="' + (t.party_type || "") + '"' +
              ' data-confidence="' + Math.round(pct) + '"' +
              ' data-date="' + (t.date || "") + '"' +
              ' data-deposit="' + (parseFloat(t.deposit) || 0) + '"' +
              ' data-withdrawal="' + (parseFloat(t.withdrawal) || 0) + '"' +
              ' data-search-text="' + searchText + '">' +
              '<td class="sbr-check-col">' +
                (isReconciled ? "" :
                  '<input type="checkbox" class="sbr-row-check" data-txn="' + t.name + '">') +
              "</td>" +
              '<td class="sbr-idx-col" style="color:#94a3b8;font-size:11px;font-variant-numeric:tabular-nums">' + (idx + 1) + "</td>" +
              "<td class='sbr-date-col' style='white-space:nowrap'>" + (t.date || "") + "</td>" +
              "<td class='sbr-desc' title=\"" + (t.description || t.party || "").replace(/"/g, "&quot;") + "\">" +
                (t.description || t.party || "—") + "</td>" +
              '<td class="sbr-amt-cell" style="color:#16a34a;font-weight:600;font-variant-numeric:tabular-nums">' +
                (t.deposit && parseFloat(t.deposit) > 0 ? formatAmount(t.deposit) : "") + "</td>" +
              '<td class="sbr-amt-cell" style="color:#dc2626;font-weight:600;font-variant-numeric:tabular-nums">' +
                (t.withdrawal && parseFloat(t.withdrawal) > 0 ? formatAmount(t.withdrawal) : "") + "</td>" +
              '<td class="sbr-amt-cell" style="color:#64748b;font-variant-numeric:tabular-nums">' +
                (t.unallocated_amount && parseFloat(t.unallocated_amount) > 0
                  ? formatAmount(t.unallocated_amount) : "—") + "</td>" +
              '<td class="sbr-amt-cell" style="color:#0f172a;font-weight:600;font-variant-numeric:tabular-nums">' +
                formatAmount((function () {
                  var key = t._consolidatedBalanceKey || t.name;
                  return runningBalance[key] != null ? runningBalance[key] : 0;
                })()) + "</td>" +
              "<td class='sbr-ref' title=\"" + (t.reference_number || "").replace(/"/g, "&quot;") + "\">" +
                (t.reference_number || "—") + "</td>" +
              '<td class="sbr-match-cell">' + matchCell + "</td>" +
              '<td class="sbr-ref sbr-matched-entry-cell">' + matchedEntryHtml + "</td>" +
              "<td>" + (isReconciled
                ? '<span style="font-size:11px;color:#16a34a;font-weight:500">&#10003; Reconciled</span>' +
                  ' <button class="sbr-btn sbr-btn-unreconcile" data-txn="' + t.name +
                  '" title="Remove this reconciliation">&#8617; Unreconcile</button>'
                : '<button class="sbr-btn sbr-row-action-btn sbr-btn-action-blue"' +
                  ' data-txn="' + t.name + '">Actions</button>'
              ) + "</td>" +
              "</tr>";
    });
    html += "</tbody>" +
      '<tfoot><tr class="sbr-table-footer" style="background:#f8fafc;font-weight:700;' +
        'border-top:2px solid #cbd5e1">' +
        '<td class="sbr-check-col"></td>' +
        '<td class="sbr-idx-col"></td>' +
        '<td class="sbr-date-col"></td>' +
        '<td style="padding:8px 12px;color:#374151">Totals</td>' +
        '<td class="sbr-amt-cell" style="padding:8px 12px;color:#16a34a;font-variant-numeric:tabular-nums">' + formatAmount(totalDeposit) + "</td>" +
        '<td class="sbr-amt-cell" style="padding:8px 12px;color:#dc2626;font-variant-numeric:tabular-nums">' + formatAmount(totalWithdrawal) + "</td>" +
        "<td></td>" +
        '<td class="sbr-amt-cell" style="padding:8px 12px;color:#0f172a;font-variant-numeric:tabular-nums">' + formatAmount(netBalance) + "</td>" +
        '<td colspan="4"></td>' +
      "</tr></tfoot></table>";

    $container.find(".sbr-table-wrap").html(html);
    $container.find(".sbr-txn-counter").text(transactions.length + " transactions");
    _resolveEntryLinks($container);
    _neutralizeStickyBreakers($container);

    // Select-all: only affects visible rows
    $container.find(".sbr-select-all").on("change", function () {
      var checked = $(this).prop("checked");
      $container.find(".sbr-row:visible .sbr-row-check").prop("checked", checked);
    });

    // Sortable column headers: Date, Deposit, Withdrawal, AI Match — click
    // toggles ascending/descending; clicking a different column resets to
    // ascending on that column.
    $container.find(".sbr-sortable").on("click", function () {
      var field = $(this).data("sort-field");
      var prevField = $container.data("sbr-sort-field");
      var prevDir   = $container.data("sbr-sort-dir");
      var dir = (field === prevField && prevDir === "asc") ? "desc" : "asc";
      $container.data("sbr-sort-field", field);
      $container.data("sbr-sort-dir", dir);
      _sortTable($container, field, dir);
    });

    // Row click → switch to AI tab (Actions button handled by sbr_bind_card_actions)
    $container.find(".sbr-row").on("click", function (e) {
      if ($(e.target).is("button, a, input")) return;
      var txnName = $(this).data("txn");
      $container.find(".sbr-row").removeClass("sbr-row-active");
      $(this).addClass("sbr-row-active");
      showSuggestionCard($container, txnName);
    });

    return { totalDeposit: totalDeposit, totalWithdrawal: totalWithdrawal, netBalance: netBalance };
  }

  function updateMatchBadges($container, transactions) {
    if (!transactions) return;
    transactions.forEach(function (t) {
      var $row = $container.find('.sbr-row[data-txn="' + t.name + '"]');
      if (!$row.length) return;
      var queue = t.recon_queue || "";
      var pct   = parseFloat(t.recon_confidence) || 0;
      $row.attr("data-queue", queue);
      $row.attr("data-confidence", Math.round(pct));
      if (queue === "Reconciled") $row.addClass("sbr-row-done");
      $row.find(".sbr-match-cell").html(confidenceBadge(pct, queue));
      $row.find(".sbr-matched-entry-cell").html(_matchedEntryHtml(t));
      if (queue === "Reconciled") {
        $row.find(".sbr-row-action-btn").replaceWith(
          '<span style="font-size:11px;color:#16a34a;font-weight:500">&#10003; Reconciled</span>' +
          ' <button class="sbr-btn sbr-btn-unreconcile" data-txn="' + t.name +
          '" title="Remove this reconciliation">&#8617; Unreconcile</button>'
        );
      }
    });
    _resolveEntryLinks($container);
  }

  /* ── Reconcile Modal ── */

  function renderReconcileModal($container, txnName, onConfirm) {
    var transactions = $container.data("transactions") || [];
    var suggestions  = $container.data("suggestions")  || [];

    var txn = null;
    for (var i = 0; i < transactions.length; i++) {
      if (transactions[i].name === txnName) { txn = transactions[i]; break; }
    }
    // If not in the transactions cache, reconstruct from suggestion data so the
    // modal still opens when the Bank Transactions tab hasn't been loaded.
    if (!txn) {
      var sug0 = null;
      for (var k = 0; k < suggestions.length; k++) {
        if (suggestions[k].bank_txn === txnName) { sug0 = suggestions[k]; break; }
      }
      if (sug0) {
        txn = {
          name:             txnName,
          deposit:          sug0.deposit      || 0,
          withdrawal:       sug0.withdrawal   || 0,
          description:      sug0.description  || "",
          reference_number: sug0.reference_number || "",
          date:             sug0.date         || "",
          party:            sug0.party        || "",
        };
      } else {
        return;
      }
    }

    var suggestion = null;
    for (var j = 0; j < suggestions.length; j++) {
      if (suggestions[j].bank_txn === txnName) { suggestion = suggestions[j]; break; }
    }

    $(".sbr-modal-overlay").remove();

    var txnAmount = parseFloat(txn.deposit || 0) || parseFloat(txn.withdrawal || 0) || 0;
    var isDeposit = parseFloat(txn.deposit || 0) > 0;
    var txnType   = isDeposit ? "Deposit" : "Withdrawal";
    var amtStr    = txnAmount > 0 ? txnType + " " + formatAmount(txnAmount) : "—";
    var rname     = txnName.replace(/\W/g, "");

    // Detect 1:Many group match
    var isMany = !!(suggestion && suggestion.matched &&
                   suggestion.matched.match_type === "1:Many" &&
                   suggestion.matched.entries && suggestion.matched.entries.length > 1);
    var matchedEntries = isMany ? (suggestion.matched.entries || []) : [];
    var matchedEntryNames = matchedEntries.map(function (e) { return e.name; });

    var preselectedName = (!isMany && suggestion && suggestion.matched)
        ? (suggestion.matched.name || "") : "";
    var aiConf = parseFloat((suggestion || {}).confidence || 0);

    // ── AI suggestion card ──
    var aiCardHtml = "";
    if (suggestion && suggestion.matched && suggestion.matched.name) {
      var m = suggestion.matched;
      var confLevel = aiConf >= 90 ? "HIGH" : aiConf >= 60 ? "MED" : "LOW";
      var cc = aiConf >= 90 ? "#16a34a" : aiConf >= 60 ? "#d97706" : "#dc2626";
      var cbg = aiConf >= 90 ? "#dcfce7" : aiConf >= 60 ? "#fef3c7" : "#fee2e2";

      var sigs = {};
      try { sigs = typeof m.signals === "string" ? JSON.parse(m.signals || "{}") : (m.signals || {}); }
      catch (e) { sigs = {}; }

      var sigHtml = "";
      if (Object.keys(sigs).length) {
        sigHtml = '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:10px">';
        Object.keys(sigs).forEach(function (k) {
          var v  = Math.round(sigs[k]);
          var sc = v >= 80 ? "#16a34a" : v >= 50 ? "#d97706" : "#dc2626";
          sigHtml += '<span style="font-size:11px;border:1px solid ' + sc + ';border-radius:99px;' +
                     'padding:1px 9px;color:' + sc + '">' +
                     k.charAt(0).toUpperCase() + k.slice(1) + " " + v + "%</span>";
        });
        sigHtml += "</div>";
      }

      var barWidth = Math.min(100, aiConf).toFixed(0);
      var confHeader =
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
          '<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;' +
          'background:' + cc + ';color:#fff">' + confLevel + '</span>' +
          '<span style="font-weight:700;font-size:13px;color:#0f172a;flex:1">' +
            m.name + ' – ' + (m.entry_type || m.voucher_type || "Entry") + '</span>' +
          '<span style="font-size:12px;color:' + cc + ';font-weight:700">' +
            'Confidence: ' + aiConf.toFixed(1) + '%</span>' +
        '</div>' +
        '<div style="width:100%;height:4px;background:#e2e8f0;border-radius:99px;margin-bottom:12px">' +
          '<div style="width:' + barWidth + '%;height:100%;background:' + cc + ';border-radius:99px"></div>' +
        '</div>';

      var cardBody;
      if (isMany) {
        var totalMatched = matchedEntries.reduce(function (s, e) { return s + parseFloat(e.amount || 0); }, 0);
        var entryRows = matchedEntries.map(function (e) {
          return '<tr style="background:#f5f3ff">' +
            '<td style="font-family:ui-monospace,monospace;font-size:11px;color:#6d28d9;font-weight:600">' +
              '<a class="sbr-link" href="/app/payment-entry/' + encodeURIComponent(e.name) +
              '" target="_blank" onclick="event.stopPropagation()">' + e.name + '</a></td>' +
            '<td style="font-size:12px;white-space:nowrap">' + (e.posting_date || e.cheque_date || "—") + '</td>' +
            '<td style="font-weight:700;font-variant-numeric:tabular-nums;font-size:12px;color:#6d28d9">' +
              formatAmount(e.amount || 0) + '</td>' +
            '<td style="font-size:12px;color:#64748b">' + (e.party || "—") + '</td>' +
            '</tr>';
        }).join("");
        cardBody =
          '<div style="font-size:11px;font-weight:700;color:#6d28d9;text-transform:uppercase;' +
            'letter-spacing:.06em;margin-bottom:8px">' +
            'AI-Proposed Group — ' + matchedEntries.length + ' Payment Entries</div>' +
          '<div style="overflow-x:auto;border:1px solid #ddd6fe;border-radius:6px">' +
            '<table class="sbr-table" style="margin:0"><thead><tr>' +
              '<th>Voucher</th><th>Date</th><th>Amount</th><th>Party</th>' +
            '</tr></thead><tbody>' + entryRows +
            '<tr style="background:#ede9fe;border-top:2px solid #c4b5fd">' +
              '<td colspan="2" style="font-weight:700;font-size:12px;color:#6d28d9">TOTAL</td>' +
              '<td style="font-weight:800;font-size:13px;color:#6d28d9;font-variant-numeric:tabular-nums">' +
                formatAmount(totalMatched) + '</td>' +
              '<td style="font-size:11px;color:#16a34a;font-weight:700">✓ Matches Bank Amount</td>' +
            '</tr>' +
            '</tbody></table>' +
          '</div>';
      } else {
        var mAmount = formatAmount(m.amount || m.paid_amount || m.received_amount || 0);
        var mDate   = m.posting_date || "";
        var mRef    = m.reference_no || m.cheque_no || "—";
        var mType   = m.entry_type || m.voucher_type || "Entry";
        var mParty  = m.party || "—";
        cardBody =
          '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px 20px;font-size:12px">' +
            '<div><div style="color:#94a3b8;margin-bottom:2px">Matched To</div><strong>' + m.name + '</strong></div>' +
            '<div><div style="color:#94a3b8;margin-bottom:2px">Type</div>' + mType + '</div>' +
            '<div><div style="color:#94a3b8;margin-bottom:2px">Party</div>' + mParty + '</div>' +
            '<div><div style="color:#94a3b8;margin-bottom:2px">Amount</div><strong>' + mAmount + '</strong></div>' +
            '<div><div style="color:#94a3b8;margin-bottom:2px">Date</div>' + (mDate || "—") + '</div>' +
            '<div><div style="color:#94a3b8;margin-bottom:2px">Reference</div>' + mRef + '</div>' +
          '</div>';
      }

      aiCardHtml =
        '<div style="border:1px solid ' + cc + ';border-radius:8px;padding:14px 16px;' +
        'margin-bottom:14px;background:' + cbg + '20;overflow:hidden">' +
          confHeader + cardBody + sigHtml +
        '</div>';
    }

    var modalHtml =
      '<div class="sbr-modal-overlay" role="dialog" aria-modal="true">' +
        '<div class="sbr-modal" style="max-width:740px;width:96%;max-height:90vh;display:flex;flex-direction:column">' +
          // Header
          '<div class="sbr-modal-header">' +
            '<div>' +
              '<div class="sbr-modal-title">Reconcile the Bank Transaction</div>' +
              '<div class="sbr-modal-subtitle">' + txnName +
                ' &middot; ' + (txn.date || "") + ' &middot; ' + amtStr + '</div>' +
            '</div>' +
            '<button class="sbr-modal-close" type="button" aria-label="Close">&times;</button>' +
          '</div>' +
          // Body
          '<div class="sbr-modal-body" style="overflow-y:auto;flex:1;padding:16px 20px 8px">' +
            // Action dropdown
            '<div style="margin-bottom:14px">' +
              '<div style="font-size:11px;font-weight:600;color:#64748b;letter-spacing:.04em;' +
              'text-transform:uppercase;margin-bottom:5px">Action</div>' +
              '<select class="sbr-recon-action-sel" style="width:260px;padding:7px 10px;' +
              'border:1px solid #cbd5e1;border-radius:6px;font-size:13px;color:#0f172a;' +
              'background:#fff;cursor:pointer">' +
                '<option value="match">Match Against Voucher</option>' +
                '<option value="createVoucher">Create Voucher</option>' +
                '<option value="updateTransaction">Update Bank Transaction</option>' +
                '<option value="reconcile">Mark as Reconciled</option>' +
              '</select>' +
            '</div>' +
            // AI card — always visible above all panes
            aiCardHtml +
            // Match pane
            '<div class="sbr-recon-pane" data-pane="match">' +
              // Filters
              '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;' +
              'margin-bottom:10px;font-size:12px">' +
                '<span style="font-weight:600;color:#0f172a">Filters</span>' +
                '<label style="display:flex;align-items:center;gap:4px;cursor:pointer">' +
                  '<input type="checkbox" class="sbr-type-filter" value="Payment Entry" checked> Payment Entry</label>' +
                '<label style="display:flex;align-items:center;gap:4px;cursor:pointer">' +
                  '<input type="checkbox" class="sbr-type-filter" value="Sales Invoice" checked> Sales Invoice</label>' +
                '<label style="display:flex;align-items:center;gap:4px;cursor:pointer">' +
                  '<input type="checkbox" class="sbr-type-filter" value="Purchase Invoice" checked> Purchase Invoice</label>' +
                '<label style="display:flex;align-items:center;gap:4px;cursor:pointer">' +
                  '<input type="checkbox" class="sbr-type-filter" value="Journal Entry" checked> Journal Entry</label>' +
                '<label style="display:flex;align-items:center;gap:4px;cursor:pointer">' +
                  '<input type="checkbox" class="sbr-type-filter" value="Loan" checked> Loan</label>' +
                '<label style="display:flex;align-items:center;gap:4px;cursor:pointer">' +
                  '<input type="checkbox" class="sbr-exact-filter"> Show Exact Amount Only</label>' +
              '</div>' +
              '<div style="font-size:12px;font-weight:600;color:#64748b;margin-bottom:6px">' +
                'Select Voucher to Match</div>' +
              '<div class="sbr-modal-voucher-list">' +
                '<div class="sbr-loading"><div class="sbr-spinner"></div>' +
                '<span>Searching vouchers…</span></div>' +
              '</div>' +
            '</div>' +
            // Create Voucher pane — just a brief note; real form opens in a Frappe dialog
            '<div class="sbr-recon-pane" data-pane="createVoucher" style="display:none;padding:20px 0">' +
              '<p class="sbr-modal-info">Click <strong>Submit</strong> to open the voucher creation form ' +
              'where you can choose Payment Entry or Journal Entry and fill in the details.</p>' +
            '</div>' +
            // Mark as Reconciled pane
            '<div class="sbr-recon-pane" data-pane="reconcile" style="display:none;padding:20px 0">' +
              '<p class="sbr-modal-info">This will mark the bank transaction as Reconciled ' +
              'without linking any ERP voucher.</p>' +
            '</div>' +
            // Update Bank Transaction pane
            '<div class="sbr-recon-pane" data-pane="updateTransaction" style="display:none;padding:20px 0">' +
              '<p class="sbr-modal-info">Click <strong>Submit</strong> to open the Update Bank Transaction ' +
              'form where you can edit the Reference Number, Party Type, and Party.</p>' +
            '</div>' +
          '</div>' +
          // Footer
          '<div class="sbr-modal-footer">' +
            '<span style="font-size:12px;color:#64748b;flex:1">' +
              'Review the AI suggestion, then click Submit.</span>' +
            '<button class="sbr-modal-cancel sbr-btn" type="button">Cancel</button>' +
            '<button class="sbr-modal-confirm sbr-btn sbr-btn-accept" type="button">Submit</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    var $modal = $(modalHtml);
    $("body").append($modal);

    // Escape key
    $(document).on("keydown.sbrmodal", function (e) {
      if (e.key === "Escape") { $modal.remove(); $(document).off("keydown.sbrmodal"); }
    });

    // Close / cancel
    $modal.on("click", ".sbr-modal-close, .sbr-modal-cancel", function () {
      $modal.remove(); $(document).off("keydown.sbrmodal");
    });
    $modal.on("click", function (e) {
      if ($(e.target).hasClass("sbr-modal-overlay")) {
        $modal.remove(); $(document).off("keydown.sbrmodal");
      }
    });

    // Action dropdown — switch pane
    $modal.on("change", ".sbr-recon-action-sel", function () {
      var val = $(this).val();
      $modal.find(".sbr-recon-pane").hide();
      $modal.find('.sbr-recon-pane[data-pane="' + val + '"]').show();
      // Create Voucher / Update Bank Transaction: skip Submit, open the form dialog immediately
      if (val === "createVoucher" || val === "updateTransaction") {
        if (typeof onConfirm === "function") {
          onConfirm({ pane: val, selectedVoucher: null, note: "" }, $modal);
        }
      }
    });

    // Voucher list state
    var allVouchers = [];

    function _manyTotal() {
      var total = 0;
      $modal.find(".sbr-voucher-check:checked").each(function () {
        var nm = $(this).val();
        for (var k = 0; k < allVouchers.length; k++) {
          if (allVouchers[k].name === nm) { total += parseFloat(allVouchers[k].amount || 0); break; }
        }
      });
      $modal.find(".sbr-many-total-amt").text(formatAmount(total));
      var ok = Math.abs(total - txnAmount) < 0.01;
      $modal.find(".sbr-many-total-match")
        .css("color", ok ? "#16a34a" : "#dc2626")
        .text(ok ? "= Bank Amount ✓" : "≠ Bank Amount");
    }

    function buildVoucherRows(list) {
      if (!list.length) {
        $modal.find(".sbr-modal-voucher-list").html(
          '<p class="sbr-empty" style="padding:12px 0">No matching ERP vouchers found.</p>'
        );
        return;
      }
      var rows = list.map(function (v, idx) {
        var isSel = isMany
            ? (matchedEntryNames.indexOf(v.name) !== -1)
            : (preselectedName && preselectedName === v.name);
        var aiBadge = "";
        if (isSel && aiConf > 0) {
          var bc = isMany ? "#6d28d9" : (aiConf >= 90 ? "#16a34a" : aiConf >= 60 ? "#d97706" : "#dc2626");
          aiBadge = '<span style="font-size:10px;border:1px solid ' + bc +
                    ';border-radius:99px;padding:1px 7px;color:' + bc +
                    ';font-weight:700">' + (isMany ? "AI Match" : "&#9650;" + Math.round(aiConf) + "%") +
                    '</span>';
        }
        var rowBg = isSel ? (isMany ? "background:#f5f3ff" : "background:#eff6ff") : "";
        var inputCell = isMany
          ? '<td style="width:30px;text-align:center"><input type="checkbox" class="sbr-voucher-check" ' +
              'value="' + v.name + '"' + (isSel ? " checked" : "") + '></td>'
          : '<td style="width:30px;text-align:center"><input type="radio" class="sbr-voucher-radio" ' +
              'name="sbr-v-' + rname + '" value="' + v.name + '"' + (isSel ? " checked" : "") + '></td>';
        return '<tr class="sbr-voucher-row' + (isSel ? " sbr-voucher-row-selected" : "") +
               '" style="cursor:pointer;' + rowBg + '">' +
               inputCell +
               '<td style="font-size:11px;color:#94a3b8;font-weight:600;width:28px">' + (idx + 1) + '</td>' +
               '<td style="font-size:12px;white-space:nowrap">' + v.type + '</td>' +
               '<td class="sbr-ref"><a class="sbr-link" href="/app/' +
                 v.type.toLowerCase().replace(/ /g, "-") + "/" + encodeURIComponent(v.name) +
                 '" target="_blank" onclick="event.stopPropagation()">' + v.name + "</a></td>" +
               '<td style="white-space:nowrap;font-size:12px">' + (v.date || "") + '</td>' +
               '<td style="font-weight:700;font-variant-numeric:tabular-nums;font-size:12px">' +
                 formatAmount(v.amount) + '</td>' +
               '<td style="font-size:12px;max-width:140px;overflow:hidden;text-overflow:ellipsis;' +
                 'white-space:nowrap">' + (v.party || "—") + '</td>' +
               '<td>' + aiBadge + '</td>' +
               '</tr>';
      }).join("");

      // Running total footer for 1:Many
      var initialTotal = 0;
      if (isMany) {
        list.forEach(function (v) {
          if (matchedEntryNames.indexOf(v.name) !== -1) initialTotal += parseFloat(v.amount || 0);
        });
      }
      var totalFooter = isMany
        ? '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;' +
            'background:#f8f7ff;border:1px solid #ddd6fe;border-top:none;' +
            'border-radius:0 0 6px 6px;font-size:12px">' +
            '<span style="color:#6d28d9;font-weight:600">Selected total:</span>' +
            '<span class="sbr-many-total-amt" style="font-weight:700;font-variant-numeric:tabular-nums">' +
              formatAmount(initialTotal) + '</span>' +
            '<span class="sbr-many-total-match" style="font-weight:600;color:' +
              (Math.abs(initialTotal - txnAmount) < 0.01 ? "#16a34a" : "#dc2626") + '">' +
              (Math.abs(initialTotal - txnAmount) < 0.01 ? "= Bank Amount ✓" : "≠ Bank Amount") +
            '</span>' +
            '<span style="color:#94a3b8;font-size:11px;margin-left:auto">' +
              'Check/uncheck to adjust the group</span>' +
          '</div>'
        : '';

      $modal.find(".sbr-modal-voucher-list").html(
        '<div style="overflow-x:auto;border:1px solid ' + (isMany ? '#ddd6fe' : '#e2e8f0') +
        ';border-radius:' + (isMany ? '6px 6px 0 0' : '6px') +
        ';max-height:240px;overflow-y:auto">' +
        '<table class="sbr-table" style="margin:0"><thead><tr>' +
          '<th style="width:30px"></th>' +
          '<th style="width:28px;color:#94a3b8">#</th>' +
          '<th>TYPE</th><th>DOCUMENT NAME</th><th>DATE</th>' +
          '<th>AMOUNT</th><th>PARTY</th><th>AI</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>' + totalFooter
      );

      if (isMany) {
        // Checkbox: clicking the row toggles the checkbox
        $modal.find(".sbr-voucher-row").on("click", function (e) {
          if ($(e.target).is("a, input")) return;
          var $cb = $(this).find(".sbr-voucher-check");
          $cb.prop("checked", !$cb.prop("checked"));
          $(this).toggleClass("sbr-voucher-row-selected", $cb.prop("checked"));
          $(this).css("background", $cb.prop("checked") ? "#f5f3ff" : "");
          _manyTotal();
        });
        $modal.find(".sbr-modal-voucher-list").on("change", ".sbr-voucher-check", function () {
          var $row = $(this).closest("tr");
          var checked = $(this).prop("checked");
          $row.toggleClass("sbr-voucher-row-selected", checked);
          $row.css("background", checked ? "#f5f3ff" : "");
          _manyTotal();
        });
      } else {
        // Radio: row click selects
        $modal.find(".sbr-voucher-row").on("click", function (e) {
          if ($(e.target).is("a")) return;
          $modal.find(".sbr-voucher-row").removeClass("sbr-voucher-row-selected").css("background", "");
          $(this).addClass("sbr-voucher-row-selected").css("background", "#eff6ff");
          $(this).find(".sbr-voucher-radio").prop("checked", true);
        });
      }
    }

    function applyFilters() {
      var checkedTypes = [];
      $modal.find(".sbr-type-filter:checked").each(function () {
        checkedTypes.push($(this).val());
      });
      var exactOnly = $modal.find(".sbr-exact-filter").prop("checked");

      var filtered = allVouchers.filter(function (v) {
        if (checkedTypes.indexOf(v.type) === -1) return false;
        if (exactOnly && Math.abs(parseFloat(v.amount || 0) - txnAmount) > 0.01) return false;
        return true;
      });
      // AI-matched entries always first
      filtered.sort(function (a, b) {
        var aMatch = isMany ? (matchedEntryNames.indexOf(a.name) !== -1) : (a.name === preselectedName);
        var bMatch = isMany ? (matchedEntryNames.indexOf(b.name) !== -1) : (b.name === preselectedName);
        if (aMatch && !bMatch) return -1;
        if (!aMatch && bMatch) return 1;
        return 0;
      });
      buildVoucherRows(filtered);
    }

    $modal.on("change", ".sbr-type-filter, .sbr-exact-filter", applyFilters);

    // Confirm
    $modal.on("click", ".sbr-modal-confirm", function () {
      var action = $modal.find(".sbr-recon-action-sel").val();

      // 1:Many — collect all checked entries with their individual amounts
      if (action === "match" && isMany) {
        var selectedVouchers = [];
        $modal.find(".sbr-voucher-check:checked").each(function () {
          var nm = $(this).val();
          for (var k = 0; k < allVouchers.length; k++) {
            if (allVouchers[k].name === nm) {
              selectedVouchers.push({ name: nm, amount: allVouchers[k].amount || 0 });
              break;
            }
          }
        });
        if (!selectedVouchers.length) {
          frappe.msgprint(__("Please select at least one voucher."));
          return;
        }
        if (typeof onConfirm === "function") {
          onConfirm({ pane: "match", selectedVouchers: selectedVouchers, selectedVoucher: null, note: "" }, $modal);
        }
        return;
      }

      var selectedVoucher = $modal.find(".sbr-voucher-radio:checked").val() || null;
      if (action === "match" && !selectedVoucher) {
        frappe.msgprint(__("Please select a voucher to reconcile against."));
        return;
      }

      // Block direct reconciliation against invoices — bank transactions must be
      // linked to a Payment Entry or Journal Entry, not to an invoice directly.
      if (action === "match" && selectedVoucher) {
        var selType = "";
        for (var k = 0; k < allVouchers.length; k++) {
          if (allVouchers[k].name === selectedVoucher) { selType = allVouchers[k].type; break; }
        }
        if (selType === "Sales Invoice" || selType === "Purchase Invoice") {
          frappe.msgprint({
            title: __("Cannot Reconcile Against Invoice"),
            indicator: "orange",
            message: __(
              "<b>{0}</b> is a {1}. Bank transactions must be reconciled against a " +
              "<b>Payment Entry</b> or <b>Journal Entry</b>.<br><br>" +
              "Use the <b>Create PE</b> button on this transaction to create a Payment Entry " +
              "for the invoice, then reconcile against that Payment Entry.",
              [selectedVoucher, selType]
            ),
          });
          return;
        }
      }

      if (typeof onConfirm === "function") {
        onConfirm({ pane: action, selectedVoucher: selectedVoucher, note: "" }, $modal);
      }
    });

    // Fetch ERP vouchers — pass preselectedName so the API always includes the AI pick
    frappe.call({
      method: "smart_bank_reconciliation.reconciliation.api.get_erp_vouchers_for_match",
      args: { bank_transaction: txnName, preselected_entry: preselectedName || null },
      callback: function (r) {
        if (r.exc || !r.message || !r.message.length) {
          $modal.find(".sbr-modal-voucher-list").html(
            '<p class="sbr-empty" style="padding:12px 0">' +
            'No matching ERP vouchers found in the ±30-day window.</p>'
          );
          return;
        }
        allVouchers = r.message;
        // If AI matched an invoice but backend resolved it to a submitted PE (returned at position 0),
        // promote that PE to preselectedName so its radio gets pre-checked.
        var aiMatchedInvoice = suggestion && suggestion.matched &&
            (suggestion.matched.entry_type === "Sales Invoice" ||
             suggestion.matched.entry_type === "Purchase Invoice");
        if (aiMatchedInvoice && allVouchers.length > 0 && allVouchers[0].type === "Payment Entry") {
          preselectedName = allVouchers[0].name;
        }
        applyFilters();
      },
    });

    return $modal;
  }

  /* ── Get currently-checked transaction objects ── */

  function getSelectedTxns($container) {
    var transactions = $container.data("transactions") || [];
    var selected = [];
    $container.find(".sbr-row-check:checked").each(function () {
      var name = $(this).data("txn");
      for (var i = 0; i < transactions.length; i++) {
        if (transactions[i].name === name) { selected.push(transactions[i]); break; }
      }
    });
    return selected;
  }

  /* ── AI Suggestion Panel (AI Match Pairs tab) ── */

  /* Reorders suggestions so a detected duplicate pair renders back-to-back,
     instead of wherever plain chronological order happens to place each side.
     Stable: everything else keeps its original relative order. */
  function _groupDuplicatePairs(suggestions) {
    var byTxn = {};
    suggestions.forEach(function (s) { if (s.bank_txn) byTxn[s.bank_txn] = s; });
    var placed = {};
    var out = [];
    suggestions.forEach(function (s) {
      if (placed[s.bank_txn]) return; // already emitted alongside an earlier pair
      out.push(s);
      placed[s.bank_txn] = true;
      (s.duplicate_of || []).forEach(function (name) {
        var partner = byTxn[name];
        if (partner && !placed[name]) {
          out.push(partner);
          placed[name] = true;
        }
      });
    });
    return out;
  }

  function renderSuggestionsPanel($container, suggestions) {
    $container.data("suggestions", suggestions || []);

    var $panel = $container.find(".sbr-suggestion-panel");
    if (!suggestions || !suggestions.length) {
      $panel.html(
        '<p class="sbr-empty" style="text-align:center;padding:24px 8px">No suggestions found.</p>'
      );
      updateTabBadge($container, "ai", 0);
      return;
    }

    var queueCounts = {};
    suggestions.forEach(function (s) {
      var q = s.queue || "Unmatched";
      queueCounts[q] = (queueCounts[q] || 0) + 1;
    });

    var signalCount = suggestions.filter(function (s) {
      return s.queue === "Auto" || s.queue === "Review" || s.queue === "High-Val";
    }).length;
    var autoCount = queueCounts["Auto"] || 0;

    var html = '<div class="sbr-sp-header">' +
      '<span style="font-weight:700;font-size:14px;color:#0f172a">AI Match Pairs</span>' +
      '<div style="display:flex;align-items:center;gap:8px">' +
        '<button class="sbr-btn sbr-sp-export-btn" style="padding:4px 10px;font-size:11px" ' +
          'title="Export the currently visible/filtered cards">&#8595; Export CSV</button>' +
        '<button class="sbr-sp-scroll-btn sbr-scroll-bot-btn" title="Scroll to bottom">&#8681;</button>' +
        '<span class="sbr-sp-badge">' + signalCount + " SIGNALS</span>" +
      '</div>' +
      "</div>";

    // Queue filter tabs
    var QUEUE_ORDER = ["Auto", "Review", "Unmatched", "High-Val", "Duplicate", "Aging"];
    var QUEUE_LABEL = {
      "Auto": "AUTO", "Review": "REVIEW", "Unmatched": "UNMATCHED",
      "High-Val": "HIGH-VAL", "Duplicate": "DUPES", "Aging": "AGING",
    };
    html += '<div class="sbr-sp-queue-tabs">';
    html += '<span class="sbr-sp-queue-tab sbr-sp-queue-tab-active" data-filter="all"' +
            ' style="color:#1D4ED8;border-color:#1D4ED8;background:#EFF6FF">' +
            '<span class="sbr-sp-qtab-num">' + suggestions.length + "</span>" +
            '<span class="sbr-sp-qtab-lbl">ALL</span></span>';
    QUEUE_ORDER.forEach(function (q) {
      var cnt = queueCounts[q] || 0;
      var c = QUEUE_COLOR[q] || { bg: "#F1F5F9", text: "#64748B", border: "#CBD5E1" };
      html += '<span class="sbr-sp-queue-tab" data-filter="' + q + '"' +
              ' style="color:' + c.text + ';border-color:' + c.border + ";background:#fff" +
              (cnt === 0 ? ";opacity:0.4" : "") + '">' +
              '<span class="sbr-sp-qtab-num">' + cnt + "</span>" +
              '<span class="sbr-sp-qtab-lbl">' + (QUEUE_LABEL[q] || q.toUpperCase()) + "</span></span>";
    });
    html += "</div>";

    if (autoCount > 0) {
      html += '<div class="sbr-sp-summary">' + autoCount + " auto-match" +
              (autoCount > 1 ? "es" : "") + " ready</div>";
    }

    // Aging / Confidence sub-filters share one row so they sit side by side
    // instead of stacking as separate full-width bars.
    html += '<div class="sbr-subfilter-row" style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:10px;">';

    // Aging sub-filter — shown only when the Aging queue filter is active
    html +=
      '<div class="sbr-aging-filter-bar" style="display:none;align-items:center;gap:8px;' +
        'padding:8px 12px;background:#fff7ed;border:1px solid #fed7aa;' +
        'border-radius:6px;font-size:12px;color:#9a3412">' +
        '<span style="font-weight:600">Aging (days unreconciled):</span>' +
        '<select class="sbr-aging-range-filter" style="padding:4px 8px;border:1px solid #fed7aa;' +
          'border-radius:5px;font-size:12px;color:#9a3412;background:#fff">' +
          '<option value="">All</option>' +
          '<option value="0-30">0–30</option>' +
          '<option value="31-60">31–60</option>' +
          '<option value="61-90">61–90</option>' +
          '<option value="91-120">91–120</option>' +
          '<option value="120+">120+</option>' +
        '</select>' +
      '</div>';

    // Confidence sub-filter — shown only when the Review queue filter is active
    html +=
      '<div class="sbr-conf-filter-bar" style="display:none;align-items:center;gap:8px;' +
        'padding:8px 12px;background:#fffbeb;border:1px solid #fde68a;' +
        'border-radius:6px;font-size:12px;color:#92400e">' +
        '<span style="font-weight:600">Confidence score:</span>' +
        '<select class="sbr-conf-range-filter" style="padding:4px 8px;border:1px solid #fde68a;' +
          'border-radius:5px;font-size:12px;color:#92400e;background:#fff">' +
          '<option value="">All</option>' +
          '<option value="0-10">0–10%</option>' +
          '<option value="11-50">11–50%</option>' +
          '<option value="51-79">51–79%</option>' +
        '</select>' +
      '</div>';

    html += '</div>';

    // Bulk-approve-filtered bar — shown on Review/Aging; approves whatever
    // is currently visible under the active filters (queue + confidence +
    // aging + search + party), not a fixed hardcoded set.
    html +=
      '<div class="sbr-bulk-approve-bar" style="display:none;align-items:center;gap:10px;' +
        'padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;' +
        'border-radius:6px;margin-bottom:10px;font-size:12px;color:#166534">' +
        '<span style="font-weight:600"><span class="sbr-bulk-approve-count">0</span> matching this filter</span>' +
        '<span style="flex:1"></span>' +
        '<button class="sbr-btn sbr-bulk-approve-filtered-btn" disabled ' +
          'style="opacity:0.5;background:#16a34a;color:#fff;border-color:#16a34a">' +
          '&#10003; Bulk Approve Filtered' +
        '</button>' +
      '</div>';

    // Duplicate bulk-action toolbar — shown only when Duplicate queue filter is active
    html +=
      '<div class="sbr-dup-bulk-bar" style="display:none;align-items:center;gap:10px;' +
        'padding:8px 12px;background:#fef2f2;border:1px solid #fecaca;' +
        'border-radius:6px;margin-bottom:10px">' +
        '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;font-weight:600;color:#7f1d1d">' +
          '<input type="checkbox" class="sbr-dup-select-all"> Select All' +
        '</label>' +
        '<span style="flex:1"></span>' +
        '<button class="sbr-btn sbr-dup-del-selected" disabled ' +
          'style="background:#dc2626;color:#fff;border-color:#b91c1c;opacity:0.5">' +
          '&#128465; Delete Selected (<span class="sbr-dup-sel-count">0</span>)' +
        '</button>' +
      '</div>';

    _groupDuplicatePairs(suggestions).forEach(function (s) { html += buildCard(s); });

    // Sticky-bottom ↑ FAB — positioned after all cards, no position:fixed needed
    html += '<div class="sbr-scroll-fab-wrap">' +
      '<button class="sbr-sp-scroll-btn sbr-scroll-top-btn" title="Back to top">&#8679;</button>' +
      '</div>';

    $panel.html(html);
    updateTabBadge($container, "ai", suggestions.length);

    // Queue tab clicks stay in sync with tiles + dropdown
    $panel.find(".sbr-sp-queue-tab").on("click", function () {
      var filter = $(this).data("filter");
      filterByQueue($container, filter === "all" ? null : filter);
    });

    // Export whatever cards are currently visible under the active
    // queue/confidence/aging/search filters — not a fixed export of everything.
    $panel.find(".sbr-sp-export-btn").on("click", function () {
      var visibleNames = {};
      $panel.find(".sbr-card:visible").each(function () {
        visibleNames[$(this).data("txn")] = true;
      });
      var rows = ($container.data("suggestions") || []).filter(function (s) {
        return visibleNames[s.bank_txn];
      });
      if (!rows.length) {
        frappe.msgprint(__("No cards to export under the current filter."));
        return;
      }
      var header = ["Bank TXN","Date","Description","Reference","Deposit","Withdrawal",
                     "Queue","Match Type","Confidence %","Matched Entry","Reasoning"];
      function esc(v) {
        var s = String(v === null || v === undefined ? "" : v).replace(/"/g, '""');
        return '"' + s + '"';
      }
      var csvRows = [header.map(esc).join(",")];
      rows.forEach(function (s) {
        var m = s.matched || {};
        csvRows.push([
          s.bank_txn, s.date, s.description || "", s.reference_number || "",
          s.deposit || "", s.withdrawal || "",
          s.queue || "", s.match_type || "",
          s.confidence || "", m.name || "", s.reasoning || "",
        ].map(esc).join(","));
      });
      var blob = new Blob([csvRows.join("\n")], { type: "text/csv" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      var queueLabel = ($container.data("sbr-queue-filter") || "all").toLowerCase();
      a.href = url; a.download = "sbr_" + queueLabel + "_export.csv"; a.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });

    // ↓ button — scroll to last visible card
    $panel.find(".sbr-scroll-bot-btn").on("click", function () {
      var $cards = $panel.find(".sbr-pair-card:visible");
      var $target = $cards.last().length ? $cards.last() : $($panel[0]);
      if ($target.length) {
        var cardBottom = $target.offset().top + $target.outerHeight();
        window.scrollTo({ top: cardBottom - window.innerHeight + 20, behavior: "smooth" });
      }
    });

    // ↑ FAB — scroll back to panel header
    $panel.find(".sbr-scroll-top-btn").on("click", function () {
      var target = (_panelOffsetTop && _panelOffsetTop > 80) ? _panelOffsetTop - 80 : 0;
      window.scrollTo({ top: target, behavior: "smooth" });
    });

    // Toggle ↓ (in header) and ↑ FAB based on scroll position
    var _panelOffsetTop = null;
    function _updateScrollFab() {
      if (!$panel[0] || !document.body.contains($panel[0])) {
        $(window).off("scroll.sbr-fab");
        return;
      }
      if (!_panelOffsetTop || _panelOffsetTop < 10) {
        var off = $panel.offset();
        _panelOffsetTop = off ? off.top : 0;
      }
      var scrollY = window.scrollY || document.documentElement.scrollTop;
      var scrolledPast = scrollY > _panelOffsetTop + 200;
      $panel.find(".sbr-scroll-bot-btn").toggle(!scrolledPast);
      $panel.find(".sbr-scroll-fab-wrap").toggleClass("sbr-fab-visible", scrolledPast);
    }
    $(window).off("scroll.sbr-fab").on("scroll.sbr-fab", _updateScrollFab);
    setTimeout(_updateScrollFab, 120);
  }

  /* ── ERP Vouchers tab ── */

  var ERP_TYPE_COLOR = {
    "PE": { bg: "#EFF6FF", text: "#1D4ED8", border: "#1D4ED8" },
    "JE": { bg: "#EDE9FE", text: "#7C3AED", border: "#7C3AED" },
    "SI": { bg: "#DCFCE7", text: "#16A34A", border: "#16A34A" },
    "PI": { bg: "#FFEDD5", text: "#EA580C", border: "#EA580C" },
  };

  function renderERPVouchersTab($container, vouchers) {
    var $tab = $container.find('.sbr-tab-content[data-tab="erp"]');
    var count = (vouchers || []).length;
    updateTabBadge($container, "erp", count);

    if (!count) {
      $tab.html('<p class="sbr-empty" style="padding:24px 16px">No ERP vouchers found for this period.</p>');
      return;
    }

    function buildRows(list) {
      if (!list.length) {
        return '<tr><td colspan="7" class="sbr-empty" style="padding:20px;text-align:center">No vouchers match this filter.</td></tr>';
      }
      return list.map(function (v) {
        var tc = ERP_TYPE_COLOR[v.type_short] || ERP_TYPE_COLOR["JE"];
        var badge = '<span class="sbr-badge" style="background:' + tc.bg + ";color:" + tc.text +
                    ";border-color:" + tc.border + '">' + (v.type_short || "?") + "</span>";
        var doctype = encodeURIComponent(v.type);
        var link = '<a class="sbr-link" href="/app/' + v.type.toLowerCase().replace(/ /g, "-") +
                   "/" + encodeURIComponent(v.name) + '" target="_blank">' + v.name + "</a>";
        var statusHtml = v.status === "Cleared"
          ? '<span style="color:#16a34a;font-size:11px;font-weight:600">✓ Cleared</span>'
          : '<span style="color:#dc2626;font-size:11px;font-weight:600">Unreconciled</span>';
        var amtColor = v.payment_type === "Pay" || v.payment_type === "Payment" ? "#dc2626" : "#16a34a";
        var party = (v.party || "—").substring(0, 40);
        return "<tr>" +
          "<td>" + badge + "</td>" +
          '<td class="sbr-ref">' + link + "</td>" +
          "<td style='white-space:nowrap'>" + (v.date || "") + "</td>" +
          "<td style='max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' title='" + (v.party || "") + "'>" + party + "</td>" +
          '<td style="font-weight:600;font-variant-numeric:tabular-nums;color:' + amtColor + '">' + formatAmount(v.amount) + "</td>" +
          '<td style="font-family:ui-monospace,monospace;font-size:11px;color:#64748b">' + (v.reference || "—") + "</td>" +
          "<td>" + statusHtml + "</td>" +
          "</tr>";
      }).join("");
    }

    var toolbarHtml =
      '<div class="sbr-erp-toolbar">' +
        '<input class="sbr-erp-search" type="text" placeholder="Search voucher or party…">' +
        '<select class="sbr-erp-type-filter">' +
          '<option value="">All Types</option>' +
          '<option value="Payment Entry">Payment Entry</option>' +
          '<option value="Journal Entry">Journal Entry</option>' +
        '</select>' +
        '<span class="sbr-txn-counter sbr-erp-counter">' + count + " vouchers</span>" +
      "</div>";

    var tableHtml =
      '<div class="sbr-table-wrap" style="max-height: 65vh; overflow-y: auto; overflow-x: auto; position: relative; border: 1px solid #e2e8f0; border-radius: 6px; background: #fff;">' +
      '<table class="sbr-table" style="border-collapse: separate; border-spacing: 0;"><thead><tr>' +
        '<th style="width:44px">Type</th><th>Voucher</th><th>Date</th>' +
        '<th>Party / Remark</th><th>Amount (' + currencySymbol() + ')</th><th>Reference</th><th>Status</th>' +
      "</tr></thead><tbody>" + buildRows(vouchers) + "</tbody></table></div>";

    $tab.html(toolbarHtml + tableHtml);
    _neutralizeStickyBreakers($tab);

    // Client-side search + type filter (no API round-trip)
    function applyFilter() {
      var search = ($tab.find(".sbr-erp-search").val() || "").toLowerCase();
      var typeVal = $tab.find(".sbr-erp-type-filter").val();
      var filtered = vouchers.filter(function (v) {
        var ok = (!typeVal || v.type === typeVal);
        if (ok && search) {
          ok = v.name.toLowerCase().indexOf(search) !== -1 ||
               (v.party || "").toLowerCase().indexOf(search) !== -1 ||
               (v.reference || "").toLowerCase().indexOf(search) !== -1;
        }
        return ok;
      });
      $tab.find(".sbr-table tbody").html(buildRows(filtered));
      $tab.find(".sbr-erp-counter").text(
        (filtered.length < count ? filtered.length + " of " : "") + count + " vouchers"
      );
    }

    $tab.off("input", ".sbr-erp-search").on("input", ".sbr-erp-search", applyFilter);
    $tab.off("change", ".sbr-erp-type-filter").on("change", ".sbr-erp-type-filter", applyFilter);
  }

  /* ── Card builder — P2.4 side-by-side pair layout ── */

  function buildCard(s) {
    var matchedEntry = s.matched || {};
    var signals = matchedEntry.signals || null;
    var pct = parseFloat(s.confidence) || 0;
    var confColor = pct >= 90 ? "#16a34a" : pct >= 50 ? "#d97706" : "#dc2626";
    var queue = s.queue || "Unmatched";
    var hasMatch = !!(matchedEntry.name);

    var qc = QUEUE_COLOR[queue] || { bg: "#F1F5F9", text: "#64748B", border: "#CBD5E1" };

    var bankAmtStr = (s.deposit && parseFloat(s.deposit) > 0)
      ? '<span style="color:#16a34a;font-weight:700">' + formatAmount(s.deposit) + " CR</span>"
      : (s.withdrawal && parseFloat(s.withdrawal) > 0
          ? '<span style="color:#dc2626;font-weight:700">' + formatAmount(s.withdrawal) + " DR</span>"
          : '<span style="color:#94a3b8">—</span>');

    // Days unreconciled — computed regardless of queue so it's available as a
    // filter attribute even when the visual badge below only shows it for Aging.
    var daysOld = -1;
    if (s.date) {
      daysOld = Math.floor((Date.now() - new Date(s.date).getTime()) / 86400000);
    }

    var html = '<div class="sbr-card sbr-pair-card" data-txn="' + (s.bank_txn || "") +
               '" data-queue="' + queue + '" data-confidence="' + Math.round(pct) +
               '" data-aging-days="' + daysOld + '">';

    // ── Header: queue badge + match type + confidence bar ──
    var mtypePill = (hasMatch && matchedEntry.match_type)
      ? '<span class="sbr-pair-mtype">' + matchedEntry.match_type + "</span>"
      : "";
    var confHtml = "";
    if (pct > 0) {
      var barW = Math.min(100, pct).toFixed(0);
      confHtml =
        '<div class="sbr-pair-conf-wrap">' +
          '<div class="sbr-pair-conf-track">' +
            '<div class="sbr-pair-conf-fill" style="width:' + barW + "%;background:" + confColor + '"></div>' +
          "</div>" +
          '<span class="sbr-pair-conf-pct" style="color:' + confColor + '">' + pct.toFixed(1) + "%</span>" +
        "</div>";
    }

    // Aging days badge — how long this transaction has been unreconciled
    var agingDaysBadge = "";
    if (queue === "Aging" && daysOld > 0) {
      var agBg    = daysOld > 30 ? "#fee2e2" : "#ffedd5";
      var agColor = daysOld > 30 ? "#dc2626" : "#ea580c";
      agingDaysBadge =
        '<span style="background:' + agBg + ';color:' + agColor + ';border:1px solid ' + agColor + ';' +
          'padding:2px 7px;border-radius:99px;font-size:10px;font-weight:700;white-space:nowrap">' +
          daysOld + 'd unreconciled' +
        '</span>';
    }

    var dupChk = queue === "Duplicate"
      ? '<input type="checkbox" class="sbr-dup-chk" data-txn="' + (s.bank_txn || "") +
        '" style="width:15px;height:15px;cursor:pointer;flex-shrink:0" title="Select for bulk delete">'
      : "";
    html +=
      '<div class="sbr-pair-header">' +
        (dupChk ? '<div style="display:flex;align-items:center;gap:8px;flex:1">' + dupChk + '<div class="sbr-pair-meta">' : '<div class="sbr-pair-meta">') +
          '<span class="sbr-badge" style="background:' + qc.bg + ";color:" + qc.text + ";border-color:" + qc.border + '">' +
            (queue || "—") +
          "</span>" +
          mtypePill +
          agingDaysBadge +
        (dupChk ? "</div></div>" : "</div>") +
        confHtml +
      "</div>";

    // ── Pair body ──
    if (hasMatch) {
      var mType  = matchedEntry.entry_type || matchedEntry.voucher_type || "Entry";
      var mDate  = matchedEntry.posting_date || "";
      var mRef   = matchedEntry.reference_no || matchedEntry.cheque_no || "";
      var mParty = matchedEntry.party || "";
      var mAmt   = formatAmount(matchedEntry.amount || 0);
      var isMany = matchedEntry.match_type === "1:Many" &&
                   matchedEntry.entries && matchedEntry.entries.length > 1;

      var erpIdHtml = isMany
        ? '<div class="sbr-pair-id" style="color:#7c3aed">Group of ' + matchedEntry.entries.length + " vouchers</div>"
        : '<div class="sbr-pair-id"><a class="sbr-link" href="/app/' +
            mType.toLowerCase().replace(/ /g, "-") + "/" + encodeURIComponent(matchedEntry.name) +
            '" target="_blank" onclick="event.stopPropagation()">' + matchedEntry.name + "</a></div>";

      html +=
        '<div class="sbr-pair-cols">' +
          // Bank side
          '<div class="sbr-pair-side">' +
            '<div class="sbr-pair-side-label">Bank Statement</div>' +
            '<div class="sbr-pair-id">' + (s.bank_txn || "—") + "</div>" +
            '<div class="sbr-pair-amt">' + bankAmtStr + "</div>" +
            (s.date ? '<div class="sbr-pair-field">' + s.date + "</div>" : "") +
            (s.reference_number
              ? '<div class="sbr-pair-field sbr-pair-mono">' + s.reference_number + "</div>"
              : "") +
            ((s.party || s.description)
              ? '<div class="sbr-pair-field">' + (s.party || (s.description || "").substring(0, 35)) + "</div>"
              : "") +
          "</div>" +
          // Connector
          '<div class="sbr-pair-conn">&#8596;</div>' +
          // ERP side
          '<div class="sbr-pair-side">' +
            '<div class="sbr-pair-side-label">ERP ' + mType + "</div>" +
            erpIdHtml +
            '<div class="sbr-pair-amt">' + mAmt + "</div>" +
            (mDate ? '<div class="sbr-pair-field">' + mDate + "</div>" : "") +
            (mRef  ? '<div class="sbr-pair-field sbr-pair-mono">' + mRef + "</div>" : "") +
            (mParty ? '<div class="sbr-pair-field">' + mParty + "</div>" : "") +
          "</div>" +
        "</div>";  // .sbr-pair-cols

    } else {
      // No ERP match — compact single-column
      html +=
        '<div class="sbr-pair-no-match">' +
          '<div class="sbr-pair-side-label">Bank Statement</div>' +
          '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
            '<div class="sbr-pair-id">' + (s.bank_txn || "—") + "</div>" +
            '<div class="sbr-pair-amt">' + bankAmtStr + "</div>" +
            (s.date ? '<span class="sbr-pair-field">' + s.date + "</span>" : "") +
          "</div>" +
          (s.reference_number
            ? '<div class="sbr-pair-field sbr-pair-mono" style="margin-top:3px">' + s.reference_number + "</div>"
            : "") +
          ((s.party || s.description)
            ? '<div class="sbr-pair-field" style="margin-top:2px">' +
                (s.party || (s.description || "").substring(0, 60)) + "</div>"
            : "") +
        "</div>";
    }

    // ── Signal chips ──
    if (signals && Object.keys(signals).length) {
      html += '<div class="sbr-signal-row">';
      Object.keys(signals).forEach(function (k) {
        var v  = Math.round(signals[k]);
        var sc = v >= 80 ? "#16a34a" : v >= 50 ? "#d97706" : "#dc2626";
        html += '<span class="sbr-signal-chip" style="color:' + sc + ";border-color:" + sc + '">' +
                (SIGNAL_LABEL[k] || k) + " " + v + "%</span>";
      });
      html += "</div>";
    }

    // ── Reasoning callout ──
    // Skipped for Duplicate queue: matchedEntry.reasoning and s.reasoning are the
    // same string there (the dup warning is prepended to the match reasoning in
    // matching_engine.py), and the Duplicate block below already shows it — with
    // more appropriate ⚠ styling right above the destructive Delete action.
    if (matchedEntry.reasoning && queue !== "Duplicate") {
      html += '<div class="sbr-pair-reasoning">' + matchedEntry.reasoning + "</div>";
    }

    // ── WHT box ──
    if (matchedEntry.wht_amount) {
      html += '<div class="sbr-wht-box">WHT: ' + formatAmount(matchedEntry.wht_amount) +
              " — post to WHT Receivable via JE</div>";
    }

    // ── Actions ──
    html += '<div class="sbr-card-actions">';

    if (queue === "Auto" || queue === "Review") {
      var entryList = matchedEntry.entries
        ? matchedEntry.entries.map(function (e) { return { name: e.name, amount: e.amount || 0 }; })
        : (matchedEntry.name ? [{ name: matchedEntry.name, amount: matchedEntry.amount || 0 }] : []);
      html +=
        '<button class="sbr-btn sbr-btn-accept" data-txn="' + s.bank_txn +
        '" data-entries=\'' + JSON.stringify(entryList) +
        "' data-type=\"" + (matchedEntry.match_type || "") + '">&#10003; Approve Match</button>' +
        '<button class="sbr-btn sbr-pair-view-btn sbr-pair-detail-btn" data-txn="' + s.bank_txn + '">View Details &#8250;</button>' +
        '<button class="sbr-btn sbr-btn-update" data-txn="' + s.bank_txn + '">&#9998; Update</button>';
    }
    if (queue === "High-Val") {
      html +=
        '<button class="sbr-btn sbr-btn-hv" data-txn="' + s.bank_txn + '">Approve (Sign)</button>' +
        '<button class="sbr-btn sbr-pair-view-btn sbr-pair-detail-btn" data-txn="' + s.bank_txn + '">View Details &#8250;</button>' +
        '<button class="sbr-btn sbr-btn-update" data-txn="' + s.bank_txn + '">&#9998; Update</button>';
    }
    if (queue === "Duplicate") {
      if (s.reasoning) {
        html += '<div style="font-size:12px;color:#7f1d1d;background:#fef2f2;' +
                'border:1px solid #fecaca;border-radius:5px;padding:7px 10px;' +
                'margin-bottom:8px;line-height:1.5">&#9888; ' + s.reasoning + '</div>';
      }
      html +=
        '<button class="sbr-btn sbr-pair-view-btn sbr-pair-detail-btn" data-txn="' + s.bank_txn + '">Match Against Voucher &#8250;</button>' +
        '<button class="sbr-btn sbr-btn-del-dup" data-txn="' + s.bank_txn + '" ' +
          'style="background:#dc2626;color:#fff;border-color:#b91c1c">&#128465; Delete Duplicate</button>' +
        '<button class="sbr-btn sbr-btn-update" data-txn="' + s.bank_txn + '">&#9998; Update</button>';
    }
    if (queue === "Unmatched" || queue === "Aging") {
      if (s.draft_payload) {
        try {
          var draft = typeof s.draft_payload === "string"
            ? JSON.parse(s.draft_payload) : s.draft_payload;
          var etype = draft.entry_type || "JE";
          html += '<button class="sbr-btn sbr-btn-draft" data-txn="' + s.bank_txn +
                  '" data-etype="' + etype + '" data-draft="' + JSON.stringify(draft).replace(/"/g, '&quot;') +
                  '">+ Create ' + etype + '</button>';
        } catch (e) { /* ignore */ }
      }
      html +=
        '<button class="sbr-btn sbr-pair-view-btn sbr-pair-detail-btn" data-txn="' + s.bank_txn + '">View Details &#8250;</button>' +
        '<button class="sbr-btn sbr-btn-update" data-txn="' + s.bank_txn + '">&#9998; Update</button>';
    }

    html += "</div>";  // .sbr-card-actions

    return html + "</div>";  // .sbr-card
  }

  /* ── Show card in AI tab ── */

  function showSuggestionCard($container, txnName) {
    var $card = $container.find('.sbr-card[data-txn="' + txnName + '"]');
    if (!$card.length) return;

    switchTab($container, "ai");
    $container.find(".sbr-card").removeClass("sbr-card-active");
    $card.addClass("sbr-card-active");

    setTimeout(function () {
      $card[0].scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 60);
  }

  /* ── P2.5: Report Modal ── */

  function renderReportModal(frm) {
    var bank_account = frm.doc.bank_account;
    var from_date    = frm.doc.bank_statement_from_date;
    var to_date      = frm.doc.bank_statement_to_date;
    var company      = frm.doc.company || "";

    if (!bank_account || !from_date || !to_date) {
      frappe.msgprint(__("Please set Bank Account and date range first."));
      return;
    }

    // Format "Feb 2025" from date string
    function _monthLabel(dateStr) {
      var MO = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      var d  = new Date(dateStr);
      return isNaN(d) ? dateStr : MO[d.getMonth()] + " " + d.getFullYear();
    }

    var $modal = $(
      '<div class="sbr-modal-overlay" role="dialog" aria-modal="true">' +
        '<div class="sbr-modal" style="max-width:960px;width:96%;max-height:92vh;display:flex;flex-direction:column">' +
          '<div class="sbr-modal-header">' +
            '<div>' +
              '<div class="sbr-modal-title">&#128202; Reconciliation Report</div>' +
              '<div class="sbr-modal-subtitle sbr-report-subtitle">' +
                (company ? company.toUpperCase() + " &middot; " : "") +
                bank_account + ' &middot; ' + _monthLabel(from_date) +
              '</div>' +
            '</div>' +
            '<button class="sbr-modal-close" type="button" aria-label="Close">&times;</button>' +
          '</div>' +
          '<div class="sbr-modal-body" style="overflow-y:auto;flex:1;padding:16px 20px 8px">' +
            '<div style="text-align:center;padding:40px 0;color:#64748b">Loading report&hellip;</div>' +
          '</div>' +
          '<div class="sbr-modal-footer">' +
            '<button class="sbr-report-export sbr-btn" type="button" ' +
              'style="background:#0f172a;color:#fff;border-color:#0f172a" disabled>' +
              '&#8595; Export Excel</button>' +
            '<span style="flex:1"></span>' +
            '<span class="sbr-report-ts" style="font-size:11px;color:#94a3b8"></span>' +
            '<button class="sbr-modal-cancel sbr-btn" type="button">Close</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
    $("body").append($modal);

    function closeReport() {
      $modal.remove();
      $(document).off("keydown.sbrreport");
    }
    $modal.on("click", ".sbr-modal-close, .sbr-modal-cancel", closeReport);
    $modal.on("click", function (e) {
      if ($(e.target).hasClass("sbr-modal-overlay")) closeReport();
    });
    $(document).on("keydown.sbrreport", function (e) {
      if (e.key === "Escape") closeReport();
    });

    // ── Tab switching ──
    $modal.on("click", ".sbr-report-tab", function () {
      var id = $(this).data("tab");
      $modal.find(".sbr-report-tab").each(function () {
        var active = $(this).data("tab") === id;
        $(this).css({
          "font-weight":   active ? "700" : "500",
          "color":         active ? "#1d4ed8" : "#64748b",
          "border-bottom": active ? "2px solid #1d4ed8" : "2px solid transparent",
        });
      });
      $modal.find(".sbr-report-panel").hide();
      $modal.find('.sbr-report-panel[data-panel="' + id + '"]').show();
    });

    // ── Helper: build a scrollable table ──
    function _table(cols, rows, emptyMsg) {
      if (!rows || rows.length === 0) {
        return '<div style="text-align:center;color:#94a3b8;padding:24px 0;font-size:13px">' +
          (emptyMsg || "No items") + "</div>";
      }
      var h = '<div style="overflow-x:auto;border:1px solid #e2e8f0;border-radius:6px;max-height:300px;overflow-y:auto">' +
        '<table class="sbr-table" style="margin:0"><thead><tr>';
      cols.forEach(function (c) {
        h += '<th' + (c.right ? ' style="text-align:right"' : "") + ">" + c.label + "</th>";
      });
      h += "</tr></thead><tbody>";
      rows.forEach(function (cells) {
        h += "<tr>";
        cells.forEach(function (cell, i) {
          h += '<td' + (cols[i] && cols[i].right ? ' style="text-align:right"' : "") + ">" + (cell === null || cell === undefined ? "—" : cell) + "</td>";
        });
        h += "</tr>";
      });
      h += "</tbody></table></div>";
      return h;
    }

    // ── Helper: confidence badge ──
    // hasMatch = true means transaction is reconciled but was matched manually (no AI score)
    function _confBadge(pct, hasMatch) {
      if (!pct) {
        if (hasMatch) {
          return '<span style="background:#f1f5f9;color:#475569;padding:1px 7px;' +
            'border-radius:99px;font-size:11px;font-weight:700">Manual</span>';
        }
        return "—";
      }
      var bg = pct >= 70 ? "#dcfce7" : pct >= 50 ? "#fef3c7" : "#fee2e2";
      var cl = pct >= 70 ? "#16a34a" : pct >= 50 ? "#d97706" : "#dc2626";
      return '<span style="background:' + bg + ";color:" + cl +
        ';padding:1px 7px;border-radius:99px;font-size:11px;font-weight:700">' +
        Math.round(pct) + "%</span>";
    }

    // ── Helper: monospaced blue link-style name ──
    function _entry(name) {
      if (!name) return "—";
      return '<span style="font-family:ui-monospace,monospace;font-size:11px;color:#1d4ed8">' + name + "</span>";
    }

    // ── Helper: truncated description ──
    function _desc(txt) {
      var s = (txt || "").trim();
      if (!s) return "—";
      return '<span title="' + s.replace(/"/g, "&quot;") + '" style="font-size:12px">' +
        (s.length > 45 ? s.slice(0, 42) + "…" : s) + "</span>";
    }

    frappe.call({
      method: "smart_bank_reconciliation.reconciliation.api.get_reconciliation_report",
      args: { bank_account: bank_account, from_date: from_date, to_date: to_date, company: company },
      callback: function (r) {
        if (r.exc || !r.message) {
          $modal.find(".sbr-modal-body").html(
            '<p style="color:#dc2626;padding:20px">Failed to load report.</p>'
          );
          return;
        }
        var d = r.message;
        var s = d.summary;
        var erp_um = d.erp_unmatched || [];

        // Update subtitle with resolved company + bank label
        if (d.period.company || d.period.bank_label) {
          var sub = "";
          if (d.period.company) sub += d.period.company.toUpperCase() + " &middot; ";
          sub += (d.period.bank_label || bank_account) + " &middot; " + _monthLabel(from_date);
          $modal.find(".sbr-report-subtitle").html(sub);
        }

        // ── Stat cards — mirror the main screen's own tiles exactly (same
        // 8 categories, same counts, same colors) so this report can never
        // show a different number than what the user already sees on the
        // main screen for the same period. ERP Unmatched has no equivalent
        // tile on the main screen (it's PE/JE-sourced, not Bank Transaction-
        // sourced) so it's kept as a separate, clearly-additional tab below
        // rather than a 9th "main" card.
        var autoColor = s.automation_rate >= 70 ? "#16a34a" : s.automation_rate >= 40 ? "#d97706" : "#dc2626";
        var cards = [
          { label: "TOTAL",      val: s.total,      color: "#1d4ed8", border: "#bfdbfe" },
          { label: "AUTO",       val: s.auto,       color: QUEUE_COLOR.Auto.text,       border: QUEUE_COLOR.Auto.bg },
          { label: "REVIEW",     val: s.review,     color: QUEUE_COLOR.Review.text,     border: QUEUE_COLOR.Review.bg },
          { label: "UNMATCHED",  val: s.unmatched,  color: QUEUE_COLOR.Unmatched.text,  border: QUEUE_COLOR.Unmatched.bg },
          { label: "HIGH-VAL",   val: s.high_val,   color: QUEUE_COLOR["High-Val"].text, border: QUEUE_COLOR["High-Val"].bg },
          { label: "DUPES",      val: s.dupes,      color: QUEUE_COLOR.Duplicate.text,  border: QUEUE_COLOR.Duplicate.bg },
          { label: "AGING",      val: s.aging,      color: QUEUE_COLOR.Aging.text,      border: QUEUE_COLOR.Aging.bg },
          { label: "RECONCILED", val: s.reconciled, color: QUEUE_COLOR.Reconciled.text, border: "#cbd5e1" },
        ];
        var cardsHtml = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:18px">';
        cards.forEach(function (c) {
          cardsHtml +=
            '<div style="border:1.5px solid ' + c.border + ';border-radius:8px;' +
              'padding:14px 8px 12px;text-align:center">' +
              '<div style="font-size:28px;font-weight:800;color:' + c.color +
                ';font-variant-numeric:tabular-nums;line-height:1">' + c.val + '</div>' +
              '<div style="font-size:9px;font-weight:700;color:#94a3b8;' +
                'letter-spacing:.08em;margin-top:6px;text-transform:uppercase">' + c.label + '</div>' +
            '</div>';
        });
        cardsHtml += '</div>';

        // ── Automation + manual rate bar ──
        var manualColor = (s.manual_rate || 0) > 0 ? "#0369a1" : "#94a3b8";
        var rateHtml =
          '<div style="padding-bottom:14px;margin-bottom:14px;border-bottom:1px solid #f1f5f9">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">' +
              '<span style="font-size:13px;font-weight:700;color:#0f172a">Overall Automation Rate</span>' +
              '<div style="display:flex;gap:16px">' +
                '<span style="font-size:13px;font-weight:700;color:' + autoColor + '">' + s.automation_rate + '% auto</span>' +
                '<span style="font-size:13px;font-weight:700;color:' + manualColor + '">' + (s.manual_rate || 0) + '% manual</span>' +
              '</div>' +
            '</div>' +
            '<div style="font-size:12px;color:#94a3b8">' +
              (s.auto_reconciled || 0) + ' auto-approved &middot; ' +
              (s.manual_reconciled || 0) + ' manually approved &middot; ' +
              (s.reconciled || 0) + ' total reconciled' +
            '</div>' +
          '</div>';

        // ── Tabs — one per main-screen tile, same grouping, plus ERP
        // Unmatched appended as an extra (non-tile) tab ──
        var autoTxns       = d.transactions.filter(function (t) { return t.queue === "Auto"; });
        var reviewTxns     = d.transactions.filter(function (t) { return t.queue === "Review"; });
        var unmatchedTxns  = d.transactions.filter(function (t) { return t.queue === "Unmatched"; });
        var highValTxns    = d.transactions.filter(function (t) { return t.queue === "High-Val"; });
        var dupTxns        = d.transactions.filter(function (t) { return t.queue === "Duplicate"; });
        var agingTxns      = d.transactions.filter(function (t) { return t.queue === "Aging"; });
        var reconciledTxns = d.transactions.filter(function (t) { return t.queue === "Reconciled"; });

        var tabs = [
          { id: "auto",       icon: "✅ ", label: "Auto",       count: autoTxns.length       },
          { id: "review",     icon: "⚠ ",  label: "Review",     count: reviewTxns.length     },
          { id: "unmatched",  icon: "",     label: "Unmatched",  count: unmatchedTxns.length  },
          { id: "high-val",   icon: "",     label: "High-Val",   count: highValTxns.length    },
          { id: "duplicate",  icon: "",     label: "Duplicate",  count: dupTxns.length        },
          { id: "aging",      icon: "",     label: "Aging",      count: agingTxns.length      },
          { id: "reconciled", icon: "✓ ",  label: "Reconciled", count: reconciledTxns.length },
          { id: "erp-um",     icon: "",     label: "ERP Unmatched (extra)", count: erp_um.length },
        ];

        var tabBarHtml = '<div style="display:flex;border-bottom:2px solid #e2e8f0;margin-bottom:12px;overflow-x:auto">';
        tabs.forEach(function (tab, i) {
          var active = i === 0;
          tabBarHtml +=
            '<button class="sbr-report-tab" data-tab="' + tab.id + '" style="' +
              'padding:8px 16px;border:none;background:none;cursor:pointer;white-space:nowrap;' +
              'font-size:12px;font-weight:' + (active ? "700" : "500") + ";" +
              'color:' + (active ? "#1d4ed8" : "#64748b") + ";" +
              'border-bottom:' + (active ? "2px solid #1d4ed8" : "2px solid transparent") + ";" +
              'margin-bottom:-2px">' +
              tab.icon + tab.label + " (" + tab.count + ")" +
            '</button>';
        });
        tabBarHtml += '</div>';

        // ── Panel builders — shared row shapes reused across the 7 tile-matching tabs ──
        var matchedCols = [{ label: "BANK TXN" }, { label: "DATE" }, { label: "DESCRIPTION" }, { label: "AMOUNT", right: true }, { label: "ERP ENTRY" }, { label: "CONFIDENCE", right: true }];
        function _matchRow(t) {
          var amt = t.deposit > 0 ? t.deposit : t.withdrawal;
          return [
            _entry(t.name),
            '<span style="white-space:nowrap;font-size:12px">' + t.date + "</span>",
            _desc(t.description),
            '<span style="color:' + (t.deposit > 0 ? "#16a34a" : "#dc2626") + ';font-variant-numeric:tabular-nums">' + formatAmount(amt) + "</span>",
            _entry(t.suggested_match),
            _confBadge(t.confidence, !!t.suggested_match),
          ];
        }
        var plainCols = [{ label: "BANK TXN" }, { label: "DATE" }, { label: "DESCRIPTION" }, { label: "AMOUNT", right: true }, { label: "PARTY" }];
        function _plainRow(t) {
          var amt = t.deposit > 0 ? t.deposit : t.withdrawal;
          return [
            _entry(t.name),
            '<span style="white-space:nowrap;font-size:12px">' + t.date + "</span>",
            _desc(t.description),
            '<span style="font-variant-numeric:tabular-nums">' + formatAmount(amt) + "</span>",
            t.party || "—",
          ];
        }

        var panelAuto =
          '<div class="sbr-report-panel" data-panel="auto">' +
            '<div style="font-size:11px;color:#94a3b8;margin-bottom:8px">Transactions auto-approved by the reconciliation engine</div>' +
            _table(matchedCols, autoTxns.map(_matchRow), "No auto-matched transactions yet") +
          '</div>';

        var panelReview =
          '<div class="sbr-report-panel" data-panel="review" style="display:none">' +
            '<div style="font-size:11px;color:#94a3b8;margin-bottom:8px">Transactions in the review queue — require human decision</div>' +
            _table(
              [{ label: "BANK TXN" }, { label: "DATE" }, { label: "DESCRIPTION" }, { label: "AMOUNT", right: true }, { label: "SUGGESTED MATCH" }, { label: "CONFIDENCE", right: true }],
              reviewTxns.map(_matchRow),
              "No transactions in review"
            ) +
          '</div>';

        var panelUnmatched =
          '<div class="sbr-report-panel" data-panel="unmatched" style="display:none">' +
            '<div style="font-size:11px;color:#94a3b8;margin-bottom:8px">No matching ERP entry found — action required</div>' +
            _table(plainCols, unmatchedTxns.map(_plainRow), "No unmatched transactions") +
          '</div>';

        var panelHighVal =
          '<div class="sbr-report-panel" data-panel="high-val" style="display:none">' +
            '<div style="font-size:11px;color:#94a3b8;margin-bottom:8px">Above the high-value threshold — held for review regardless of confidence</div>' +
            _table(matchedCols, highValTxns.map(_matchRow), "No high-value transactions") +
          '</div>';

        var panelDuplicate =
          '<div class="sbr-report-panel" data-panel="duplicate" style="display:none">' +
            '<div style="font-size:11px;color:#94a3b8;margin-bottom:8px">Flagged as a possible duplicate of another transaction</div>' +
            _table(plainCols, dupTxns.map(_plainRow), "No duplicate transactions") +
          '</div>';

        var panelAging =
          '<div class="sbr-report-panel" data-panel="aging" style="display:none">' +
            '<div style="font-size:11px;color:#94a3b8;margin-bottom:8px">Unreconciled past the aging threshold</div>' +
            _table(plainCols, agingTxns.map(_plainRow), "No aging transactions") +
          '</div>';

        var panelReconciled =
          '<div class="sbr-report-panel" data-panel="reconciled" style="display:none">' +
            '<div style="font-size:11px;color:#94a3b8;margin-bottom:8px">Fully reconciled — ' +
              (s.auto_reconciled || 0) + ' auto-approved, ' + (s.manual_reconciled || 0) + ' manually approved</div>' +
            _table(matchedCols, reconciledTxns.map(_matchRow), "No reconciled transactions") +
          '</div>';

        // ── Panel: ERP Unmatched — no main-screen tile equivalent, kept as an extra ──
        var erpUmRows = erp_um.map(function (e) {
          return [
            _entry(e.name),
            '<span style="font-size:11px;color:#475569">' + e.entry_type + "</span>",
            '<span style="white-space:nowrap;font-size:12px">' + e.date + "</span>",
            '<span style="font-variant-numeric:tabular-nums">' + formatAmount(e.amount) + "</span>",
            e.party || "—",
          ];
        });
        var panelErpUm =
          '<div class="sbr-report-panel" data-panel="erp-um" style="display:none">' +
            '<div style="font-size:11px;color:#94a3b8;margin-bottom:8px">ERP vouchers with no bank transaction — may be outstanding or errors</div>' +
            _table(
              [{ label: "ERP VOUCHER" }, { label: "TYPE" }, { label: "DATE" }, { label: "AMOUNT", right: true }, { label: "PARTY" }],
              erpUmRows,
              "No unmatched ERP entries"
            ) +
          '</div>';

        var ts = frappe.datetime.now_datetime ? frappe.datetime.now_datetime() : new Date().toLocaleString();
        $modal.find(".sbr-modal-body").html(
          cardsHtml + rateHtml + tabBarHtml +
          panelAuto + panelReview + panelUnmatched + panelHighVal +
          panelDuplicate + panelAging + panelReconciled + panelErpUm
        );
        $modal.find(".sbr-report-ts").text("Generated " + ts);
        $modal.find(".sbr-report-export").prop("disabled", false).data("reportData", d);
      },
    });

    // ── Export Excel (multi-sheet SpreadsheetML) ──
    $modal.on("click", ".sbr-report-export", function () {
      var d = $(this).data("reportData");
      if (!d) return;

      // Build SpreadsheetML XML for a single sheet
      function xlsSheet(sheetName, headerRow, dataRows) {
        function cell(val) {
          var s = String(val === null || val === undefined ? "" : val);
          var isNum = s !== "" && !isNaN(Number(s));
          var esc = s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
          return '<Cell><Data ss:Type="' + (isNum ? "Number" : "String") + '">' + esc + "</Data></Cell>";
        }
        function row(cells, bold) {
          var style = bold ? ' ss:StyleID="hdr"' : "";
          return "<Row" + style + ">" + cells.map(cell).join("") + "</Row>\n";
        }
        var safeName = sheetName.replace(/[:\\\/\?\*\[\]]/g, "").slice(0, 31);
        var xml = '<Worksheet ss:Name="' + safeName + '"><Table>\n';
        xml += row(headerRow, true);
        dataRows.forEach(function (r) { xml += row(r, false); });
        xml += "</Table></Worksheet>\n";
        return xml;
      }

      // Same 7 groupings as the report's own tabs — one sheet per main-screen tile.
      var autoX       = d.transactions.filter(function (t) { return t.queue === "Auto"; });
      var reviewX     = d.transactions.filter(function (t) { return t.queue === "Review"; });
      var unmatchedX  = d.transactions.filter(function (t) { return t.queue === "Unmatched"; });
      var highValX    = d.transactions.filter(function (t) { return t.queue === "High-Val"; });
      var dupX        = d.transactions.filter(function (t) { return t.queue === "Duplicate"; });
      var agingX      = d.transactions.filter(function (t) { return t.queue === "Aging"; });
      var reconciledX = d.transactions.filter(function (t) { return t.queue === "Reconciled"; });
      var erpUm       = d.erp_unmatched || [];

      var xlsHeader =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<?mso-application progid="Excel.Sheet"?>\n' +
        '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\n' +
        ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n' +
        '<Styles>' +
          '<Style ss:ID="hdr"><Font ss:Bold="1"/></Style>' +
        '</Styles>\n';

      var xlsBody = "";
      function _xlsMatchRow(t) {
        var amt = t.deposit > 0 ? t.deposit : -(t.withdrawal || 0);
        return [t.name, t.date, t.description || "", t.reference_number || "",
          amt.toFixed(2), t.suggested_match || "",
          t.confidence > 0 ? t.confidence.toFixed(1) : "Manual"];
      }
      var _xlsMatchCols = ["Bank TXN","Date","Description","Reference","Amount","ERP Entry","Confidence %"];

      function _xlsPlainRow(t) {
        return [t.name, t.date, t.description || "", t.reference_number || "",
          t.deposit    > 0 ? t.deposit.toFixed(2)    : "",
          t.withdrawal > 0 ? t.withdrawal.toFixed(2) : "",
          t.party || ""];
      }
      var _xlsPlainCols = ["Bank TXN","Date","Description","Reference","Deposit","Withdrawal","Party"];

      // Sheet 1 — Auto
      xlsBody += xlsSheet("Auto (" + autoX.length + ")", _xlsMatchCols, autoX.map(_xlsMatchRow));

      // Sheet 2 — Review
      xlsBody += xlsSheet(
        "Review (" + reviewX.length + ")",
        ["Bank TXN","Date","Description","Reference","Amount","Suggested Match","Confidence %"],
        reviewX.map(function (t) {
          var amt = t.deposit > 0 ? t.deposit : -(t.withdrawal || 0);
          return [t.name, t.date, t.description || "", t.reference_number || "",
            amt.toFixed(2), t.suggested_match || "",
            t.confidence > 0 ? t.confidence.toFixed(1) : ""];
        })
      );

      // Sheet 3 — Unmatched
      xlsBody += xlsSheet("Unmatched (" + unmatchedX.length + ")", _xlsPlainCols, unmatchedX.map(_xlsPlainRow));

      // Sheet 4 — High-Val
      xlsBody += xlsSheet("High-Val (" + highValX.length + ")", _xlsMatchCols, highValX.map(_xlsMatchRow));

      // Sheet 5 — Duplicate
      xlsBody += xlsSheet("Duplicate (" + dupX.length + ")", _xlsPlainCols, dupX.map(_xlsPlainRow));

      // Sheet 6 — Aging
      xlsBody += xlsSheet("Aging (" + agingX.length + ")", _xlsPlainCols, agingX.map(_xlsPlainRow));

      // Sheet 7 — Reconciled
      xlsBody += xlsSheet("Reconciled (" + reconciledX.length + ")", _xlsMatchCols, reconciledX.map(_xlsMatchRow));

      // Sheet 8 — ERP Unmatched
      xlsBody += xlsSheet(
        "ERP Unmatched (" + erpUm.length + ")",
        ["ERP Voucher","Type","Date","Amount","Party"],
        erpUm.map(function (e) {
          return [e.name, e.entry_type || "", e.date || "",
            parseFloat(e.amount || 0).toFixed(2), e.party || ""];
        })
      );

      var xlsFooter = "</Workbook>";
      var xml  = xlsHeader + xlsBody + xlsFooter;
      var blob = new Blob([xml], { type: "application/vnd.ms-excel;charset=utf-8" });
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement("a");
      a.href     = url;
      a.download = "recon_report_" + (d.period.from_date || "").replace(/-/g, "") + ".xls";
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
  }

  /* ── Audit Trail tab ── */

  var ACTION_META = {
    "Accepted":     { color: "#16a34a", bg: "#dcfce7", label: "✓ Accepted" },
    "Rejected":     { color: "#dc2626", bg: "#fee2e2", label: "✗ Rejected" },
    "Escalated":    { color: "#ea580c", bg: "#ffedd5", label: "↑ Escalated" },
    "Investigated": { color: "#7c3aed", bg: "#ede9fe", label: "⚑ Investigated" },
    "Consolidated": { color: "#0891b2", bg: "#cffafe", label: "⇅ Consolidated" },
  };

  function renderAuditTab($container, actions) {
    var $tab = $container.find('.sbr-tab-content[data-tab="audit"]');
    var count = (actions || []).length;
    updateTabBadge($container, "audit", count);

    if (!count) {
      $tab.html(
        '<p class="sbr-empty" style="padding:32px 16px;color:#94a3b8">No actions recorded yet. ' +
        'Actions appear here after you Approve transactions.</p>'
      );
      return;
    }

    var rows = actions.map(function (a, i) {
      var am = ACTION_META[a.recon_user_action] || { color: "#64748b", bg: "#f1f5f9", label: a.recon_user_action };
      var actionBadge = '<span class="sbr-audit-action-badge" style="background:' + am.bg + ';color:' + am.color + '">' + am.label + "</span>";
      var qc = QUEUE_COLOR[a.recon_queue] || { bg: "#f1f5f9", text: "#64748b", border: "#cbd5e1" };
      var queueBadgeHtml = a.recon_queue
        ? '<span class="sbr-badge" style="background:' + qc.bg + ";color:" + qc.text + ";border-color:" + qc.border + '">' + a.recon_queue + "</span>"
        : "—";
      var pct = parseFloat(a.recon_confidence) || 0;
      var confHtml = pct > 0
        ? '<span style="font-family:ui-monospace,monospace;font-size:11px;font-weight:700;color:' +
          (pct >= 90 ? "#16a34a" : pct >= 50 ? "#d97706" : "#dc2626") + '">' + pct.toFixed(1) + "%</span>"
        : '<span style="color:#cbd5e1">—</span>';

      var matchedHtml = "—";
      if (a.recon_matched_entries) {
        try {
          var names = typeof a.recon_matched_entries === "string"
            ? JSON.parse(a.recon_matched_entries) : a.recon_matched_entries;
          if (names && names.length) {
            matchedHtml = names.slice(0, 2).map(function (n) {
              var route = _guessEntryRoute(n);
              var href = route ? "/app/" + route + "/" + encodeURIComponent(n) : "/app/bank-transaction";
              return '<a class="sbr-link" data-erp-entry="' + encodeURIComponent(n) + '" href="' + href +
                     '" target="_blank">' + n + "</a>";
            }).join(", ") + (names.length > 2 ? " +" + (names.length - 2) + " more" : "");
          }
        } catch (e) {}
      }

      var amtStr = (a.deposit && parseFloat(a.deposit) > 0)
        ? '<span style="color:#16a34a;font-weight:600">' + formatAmount(a.deposit) + " CR</span>"
        : (a.withdrawal && parseFloat(a.withdrawal) > 0)
          ? '<span style="color:#dc2626;font-weight:600">' + formatAmount(a.withdrawal) + " DR</span>"
          : "—";

      var modifiedBy = (a.modified_by || "").replace(/@.*/, "");
      var modifiedAt = (a.modified || "").substring(0, 16).replace("T", " ");

      return "<tr>" +
        '<td style="color:#94a3b8;font-size:11px">' + (i + 1) + "</td>" +
        "<td style='white-space:nowrap;font-size:12px'>" + (a.date || "") + "</td>" +
        '<td class="sbr-ref"><a class="sbr-link" href="#Form/Bank Transaction/' +
          encodeURIComponent(a.name) + '" target="_blank">' + a.name + "</a></td>" +
        '<td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px">' +
          (a.description || a.party || "—").substring(0, 50) + "</td>" +
        "<td>" + amtStr + "</td>" +
        "<td>" + actionBadge + "</td>" +
        "<td>" + queueBadgeHtml + "</td>" +
        "<td>" + confHtml + "</td>" +
        '<td style="max-width:180px">' + matchedHtml + "</td>" +
        '<td style="font-size:11px;color:#64748b;white-space:nowrap">' + modifiedBy + "</td>" +
        '<td style="font-size:11px;color:#94a3b8;white-space:nowrap;font-family:ui-monospace,monospace">' + modifiedAt + "</td>" +
        "</tr>";
    }).join("");

    $tab.html(
      '<div class="sbr-audit-toolbar">' +
        '<span style="font-size:12px;color:#64748b;font-weight:500">' + count + " action" + (count !== 1 ? "s" : "") + " recorded</span>" +
        '<button class="sbr-btn sbr-audit-export-btn" style="padding:4px 12px;font-size:11px">↓ Export CSV</button>' +
      "</div>" +
      '<div class="sbr-table-wrap" style="max-height: 65vh; overflow-y: auto; overflow-x: auto; position: relative; border: 1px solid #e2e8f0; border-radius: 6px; background: #fff;">' +
      '<table class="sbr-table" style="border-collapse: separate; border-spacing: 0;">' +
      "<thead><tr>" +
        '<th style="width:28px;color:#94a3b8">#</th>' +
        "<th>Date</th><th>Transaction</th><th>Description</th>" +
        "<th>Amount</th><th>Action</th><th>Queue</th>" +
        "<th>Conf %</th><th>Matched Entry</th><th>User</th><th>Timestamp</th>" +
      "</tr></thead>" +
      "<tbody>" + rows + "</tbody>" +
      "</table></div>"
    );
    _resolveEntryLinks($tab);
    _neutralizeStickyBreakers($tab);

    // Export CSV
    $tab.find(".sbr-audit-export-btn").on("click", function () {
      var headers = ["#","Date","Transaction","Description","Amount","Action","Queue","Confidence","Matched Entry","User","Timestamp"];
      var csvRows = [headers.join(",")];
      actions.forEach(function (a, i) {
        var amt = parseFloat(a.deposit) > 0 ? "+" + a.deposit : parseFloat(a.withdrawal) > 0 ? "-" + a.withdrawal : "";
        var matched = "";
        try {
          var names = typeof a.recon_matched_entries === "string" ? JSON.parse(a.recon_matched_entries) : (a.recon_matched_entries || []);
          matched = names.join("; ");
        } catch (e) {}
        csvRows.push([
          i + 1, a.date, a.name,
          '"' + (a.description || a.party || "").replace(/"/g, '""') + '"',
          amt, a.recon_user_action, a.recon_queue,
          (parseFloat(a.recon_confidence) || 0).toFixed(1) + "%",
          matched,
          (a.modified_by || "").replace(/@.*/, ""),
          (a.modified || "").substring(0, 16),
        ].join(","));
      });
      var blob = new Blob([csvRows.join("\n")], { type: "text/csv" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url; link.download = "audit_trail.csv"; link.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
  }

  /* ── Settings modal ── */

  function openSettingsModal(currentSettings, onSave) {
    var s = currentSettings || {};
    var html =
      '<div class="sbr-settings-grid">' +
        // Row 1
        '<div class="sbr-settings-group">' +
          '<label class="sbr-settings-label">Auto-match threshold</label>' +
          '<div class="sbr-settings-input-row">' +
            '<input class="sbr-settings-input" type="number" min="50" max="100" step="1" ' +
              'id="sbr-s-auto" value="' + (s.auto_threshold || 80) + '">' +
            '<span class="sbr-settings-unit">%</span>' +
          '</div>' +
          '<div class="sbr-settings-hint">Matches at or above this confidence are auto-approved</div>' +
        "</div>" +
        '<div class="sbr-settings-group">' +
          '<label class="sbr-settings-label">Review threshold</label>' +
          '<div class="sbr-settings-input-row">' +
            '<input class="sbr-settings-input" type="number" min="10" max="89" step="1" ' +
              'id="sbr-s-review" value="' + (s.review_threshold || 50) + '">' +
            '<span class="sbr-settings-unit">%</span>' +
          '</div>' +
          '<div class="sbr-settings-hint">Matches between Review and Auto thresholds go to Review queue</div>' +
        "</div>" +
        // Row 2
        '<div class="sbr-settings-group">' +
          '<label class="sbr-settings-label">High-value threshold</label>' +
          '<div class="sbr-settings-input-row">' +
            '<span class="sbr-settings-unit sbr-settings-prefix">' + currencySymbol() + '</span>' +
            '<input class="sbr-settings-input" type="number" min="1000000" step="1000000" ' +
              'id="sbr-s-highval" value="' + (s.high_val_threshold || 50000000) + '">' +
          '</div>' +
          '<div class="sbr-settings-hint">Matched transactions above this amount require dual approval</div>' +
        "</div>" +
        '<div class="sbr-settings-group">' +
          '<label class="sbr-settings-label">Aging alert after</label>' +
          '<div class="sbr-settings-input-row">' +
            '<input class="sbr-settings-input" type="number" min="1" max="90" step="1" ' +
              'id="sbr-s-aging" value="' + (s.aging_days || 10) + '">' +
            '<span class="sbr-settings-unit">days</span>' +
          '</div>' +
          '<div class="sbr-settings-hint">Unmatched ERP entries older than this are flagged as Aging</div>' +
        "</div>" +
        // Row 3
        '<div class="sbr-settings-group">' +
          '<label class="sbr-settings-label">Amount tolerance</label>' +
          '<div class="sbr-settings-input-row">' +
            '<input class="sbr-settings-input" type="number" min="0" max="10" step="0.5" ' +
              'id="sbr-s-amt-tol" value="' + (s.amount_tolerance_pct || 1) + '">' +
            '<span class="sbr-settings-unit">%</span>' +
          '</div>' +
          '<div class="sbr-settings-hint">Bank and ERP amounts within this % are treated as exact matches</div>' +
        "</div>" +
        '<div class="sbr-settings-group">' +
          '<label class="sbr-settings-label">Date window</label>' +
          '<div class="sbr-settings-input-row">' +
            '<span class="sbr-settings-unit sbr-settings-prefix">±</span>' +
            '<input class="sbr-settings-input" type="number" min="0" max="30" step="1" ' +
              'id="sbr-s-date-win" value="' + (s.date_window_days || 5) + '">' +
            '<span class="sbr-settings-unit">days</span>' +
          '</div>' +
          '<div class="sbr-settings-hint">ERP entries within this many days of the bank date are considered</div>' +
        "</div>" +
        // Row 4 — full-width suspense account
        '<div class="sbr-settings-group" style="grid-column:1/-1">' +
          '<label class="sbr-settings-label">Consolidation Suspense Account</label>' +
          '<div class="sbr-settings-input-row">' +
            '<input class="sbr-settings-input" type="text" style="flex:1;min-width:0" ' +
              'id="sbr-s-suspense" placeholder="e.g. Bank Suspense - XYZ" ' +
              'value="' + (s.suspense_account || "") + '">' +
          '</div>' +
          '<div class="sbr-settings-hint">Account used as contra when consolidating bank transactions into a Journal Entry. Leave blank to auto-detect from chart of accounts.</div>' +
        "</div>" +
        // Row 5 — bank charge threshold
        '<div class="sbr-settings-group" style="grid-column:1/-1">' +
          '<label class="sbr-settings-label">Bank Charge Amount Threshold</label>' +
          '<div class="sbr-settings-input-row">' +
            '<span class="sbr-settings-unit sbr-settings-prefix">' + currencySymbol() + '</span>' +
            '<input class="sbr-settings-input" type="number" min="0" step="100" ' +
              'id="sbr-s-chg-threshold" value="' + (s.bank_charge_amount_threshold || 2000) + '">' +
          '</div>' +
          '<div class="sbr-settings-hint">Any unreconciled debit transaction up to this amount is treated as a potential bank charge in Consolidate Bank Charges (default: ' + currencySymbol() + '2,000).</div>' +
        "</div>" +
      "</div>";

    var d = new frappe.ui.Dialog({
      title: "AI Match Settings",
      fields: [{ fieldtype: "HTML", fieldname: "settings_html", options: html }],
      primary_action_label: "Save Settings",
      primary_action: function () {
        var newSettings = {
          auto_threshold:               parseFloat(d.$wrapper.find("#sbr-s-auto").val()) || 80,
          review_threshold:             parseFloat(d.$wrapper.find("#sbr-s-review").val()) || 50,
          high_val_threshold:           parseFloat(d.$wrapper.find("#sbr-s-highval").val()) || 50000000,
          aging_days:                   parseInt(d.$wrapper.find("#sbr-s-aging").val()) || 10,
          amount_tolerance_pct:         parseFloat(d.$wrapper.find("#sbr-s-amt-tol").val()) || 1,
          date_window_days:             parseInt(d.$wrapper.find("#sbr-s-date-win").val()) || 5,
          suspense_account:             (d.$wrapper.find("#sbr-s-suspense").val() || "").trim(),
          bank_charge_amount_threshold: parseFloat(d.$wrapper.find("#sbr-s-chg-threshold").val()) || 2000,
        };
        frappe.call({
          method: "smart_bank_reconciliation.reconciliation.api.save_sbr_settings",
          args: { settings_json: JSON.stringify(newSettings) },
          callback: function (r) {
            if (!r.exc) {
              frappe.show_alert({ message: "Settings saved", indicator: "green" }, 3);
              d.hide();
              if (onSave) onSave(newSettings);
            }
          },
        });
      },
      secondary_action_label: "Reset to Defaults",
      secondary_action: function () {
        d.$wrapper.find("#sbr-s-auto").val(90);
        d.$wrapper.find("#sbr-s-review").val(50);
        d.$wrapper.find("#sbr-s-highval").val(50000000);
        d.$wrapper.find("#sbr-s-aging").val(10);
        d.$wrapper.find("#sbr-s-amt-tol").val(1);
        d.$wrapper.find("#sbr-s-date-win").val(5);
        d.$wrapper.find("#sbr-s-chg-threshold").val(2000);
      },
    });
    d.show();
  }

  /* ── Update individual suggestion cards after a selective re-run ── */

  function updateSuggestionCards($container, suggestions) {
    var $panel = $container.find(".sbr-suggestion-panel");
    suggestions.forEach(function (s) {
      var $existing = $panel.find('.sbr-card[data-txn="' + s.bank_txn + '"]');
      if ($existing.length) {
        $existing.replaceWith($(buildCard(s)));
      }
    });
    // Merge updated suggestions into stored data so the Reconcile modal sees fresh state
    var allSuggestions = $container.data("suggestions") || [];
    suggestions.forEach(function (newSug) {
      var idx = -1;
      for (var i = 0; i < allSuggestions.length; i++) {
        if (allSuggestions[i].bank_txn === newSug.bank_txn) { idx = i; break; }
      }
      if (idx >= 0) { allSuggestions[idx] = newSug; }
      else { allSuggestions.push(newSug); }
    });
    $container.data("suggestions", allSuggestions);
  }

  /* ── Aging ERP alerts section (Gap 4) ── */

  function renderAgingErpAlerts($container, entries, agingDays) {
    return; // section hidden per user preference
    var $panel = $container.find(".sbr-suggestion-panel");
    if (!$panel.length) return;

    // Remove any previous aging section
    $panel.find(".sbr-aging-erp-section").remove();

    var days = agingDays || 10;
    var html =
      '<div class="sbr-aging-erp-section" style="margin-bottom:16px">' +
        '<div class="sbr-aging-erp-header" style="display:flex;align-items:center;gap:8px;padding:10px 14px;' +
          'background:#fff7ed;border:1.5px solid #fed7aa;border-radius:8px;' +
          'cursor:pointer;user-select:none">' +
          '<span style="font-size:16px">⏰</span>' +
          '<span style="font-size:13px;font-weight:700;color:#c2410c">Aging ERP Entries (' +
            entries.length + ')</span>' +
          '<span style="font-size:11px;color:#92400e;margin-left:4px">ERP vouchers waiting >' +
            days + ' days for a matching bank transaction</span>' +
          '<span class="sbr-aging-erp-chevron" style="margin-left:auto;font-size:12px;color:#92400e;' +
            'transition:transform 0.2s;display:inline-block">▼</span>' +
        '</div>' +
        '<div class="sbr-aging-erp-body" style="display:none;border:1.5px solid #fed7aa;border-top:none;' +
          'border-radius:0 0 8px 8px;overflow:hidden">';

    entries.forEach(function (e) {
      var isOverdue = e.days_old > days * 2;
      var badgeColor = isOverdue ? "#dc2626" : "#ea580c";
      var badgeBg    = isOverdue ? "#fee2e2" : "#ffedd5";
      var amt = parseFloat(e.amount || 0);
      var amtStr = formatAmount(amt);
      html +=
        '<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;' +
          'background:#fffbf5;border-top:1px solid #fed7aa;font-size:12px">' +
          '<span style="background:' + badgeBg + ';color:' + badgeColor + ';' +
            'padding:2px 8px;border-radius:99px;font-size:11px;font-weight:700;white-space:nowrap">' +
            e.days_old + 'd overdue</span>' +
          '<span style="font-size:11px;color:#475569;background:#f1f5f9;' +
            'padding:2px 6px;border-radius:4px;font-family:ui-monospace,monospace">' +
            _entryTypeShort(e.entry_type) + '</span>' +
          '<a href="/app/' + _entryRoute(e.entry_type, e.name) + "/" + encodeURIComponent(e.name) + '" target="_blank" ' +
            'style="font-family:ui-monospace,monospace;font-size:11px;color:#1d4ed8;' +
            'text-decoration:none;font-weight:600" onclick="event.stopPropagation()">' +
            e.name + '</a>' +
          (e.party ? '<span style="color:#374151">' + e.party + '</span>' : '') +
          '<span style="font-weight:700;color:#92400e;font-variant-numeric:tabular-nums">' + amtStr + '</span>' +
          '<span style="color:#94a3b8;flex:1">' + (e.reference || '') + '</span>' +
          '<span style="font-size:11px;color:#94a3b8">' + (e.date || '') + '</span>' +
        '</div>';
    });

    html += '</div></div>';

    // Insert at the top of the suggestions panel (before the queue tabs)
    $panel.prepend(html);

    // Wire up toggle — collapsed by default, header click expands/collapses
    $panel.find(".sbr-aging-erp-section").on("click", ".sbr-aging-erp-header", function () {
      var $section = $(this).closest(".sbr-aging-erp-section");
      var $body    = $section.find(".sbr-aging-erp-body");
      var $chevron = $section.find(".sbr-aging-erp-chevron");
      var isOpen   = $body.is(":visible");
      if (isOpen) {
        $body.slideUp(160);
        $chevron.css("transform", "rotate(0deg)");
        $(this).css("border-radius", "8px");
      } else {
        $body.slideDown(160);
        $chevron.css("transform", "rotate(180deg)");
        $(this).css("border-radius", "8px 8px 0 0");
      }
    });
  }

  /* ── Public API ── */

  return {
    setCurrency:            setCurrency,
    currencySymbol:         currencySymbol,
    fmtCurrency:            fmtCurrency,
    queueBadge:             queueBadge,
    formatAmount:           formatAmount,
    confidenceBar:          confidenceBar,
    signalBadges:           signalBadges,
    renderTabShell:         renderTabShell,
    renderSummaryTiles:     renderSummaryTiles,
    updateTabBadge:         updateTabBadge,
    renderBalanceSummary:   renderBalanceSummary,
    renderAIBanner:         renderAIBanner,
    renderTransactionTable: renderTransactionTable,
    updateMatchBadges:      updateMatchBadges,
    renderSuggestionsPanel: renderSuggestionsPanel,
    renderERPVouchersTab:   renderERPVouchersTab,
    showSuggestionCard:     showSuggestionCard,
    filterByQueue:          filterByQueue,
    switchTab:              switchTab,
    renderReconcileModal:   renderReconcileModal,
    getSelectedTxns:        getSelectedTxns,
    renderReportModal:      renderReportModal,
    renderAuditTab:         renderAuditTab,
    openSettingsModal:      openSettingsModal,
    buildCard:              buildCard,
    updateSuggestionCards:  updateSuggestionCards,
    renderAgingErpAlerts:   renderAgingErpAlerts,
  };

}());
