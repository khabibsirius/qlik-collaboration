/*
 * Qlik Collaboration — comments panel extension (MVP)
 *
 * Context detection (the "hard part"):
 *   - app id      : qlik.currApp(this).id
 *   - sheet id    : qlik.navigation.getCurrentSheetId()
 *   - selections  : app.selectionState() + OnData event  -> captured per comment
 *   - objects     : app.getObjectProperties(sheetId) -> properties.cells  -> attach picker
 *
 * Backend: REST API (ASP.NET Core), polled every N seconds. Real-time push
 * (SignalR) is a planned upgrade — the polling layer is isolated in refresh().
 */
define(["qlik", "jquery", "css!./qlik-collaboration.css"], function (qlik, $) {
  "use strict";

  // ---------- helpers ----------

  function esc(text) {
    return String(text)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function fmtTime(iso) {
    var d = new Date(iso);
    var now = new Date();
    var hm = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
    if (d.toDateString() === now.toDateString()) return hm;
    return d.toLocaleDateString() + " " + hm;
  }

  var STATUS_LABELS = {
    "new": "New",
    "in_progress": "In progress",
    "fixed": "Fixed",
    "closed": "Closed"
  };

  // ---------- extension ----------

  return {
    initialProperties: {},

    definition: {
      type: "items",
      component: "accordion",
      items: {
        settings: {
          uses: "settings",
          items: {
            collab: {
              label: "Collaboration",
              type: "items",
              items: {
                apiUrl: {
                  ref: "collab.apiUrl",
                  label: "Backend API URL",
                  type: "string",
                  defaultValue: "http://localhost:5000"
                },
                pollSeconds: {
                  ref: "collab.pollSeconds",
                  label: "Refresh interval (seconds)",
                  type: "number",
                  defaultValue: 3
                }
              }
            }
          }
        }
      }
    },

    support: { snapshot: false, export: false, exportData: false },

    paint: function ($element, layout) {
      var self = this;
      var app = qlik.currApp(this);
      var apiUrl = (layout.collab && layout.collab.apiUrl) || "http://localhost:5000";
      var pollMs = ((layout.collab && layout.collab.pollSeconds) || 3) * 1000;

      // Build the UI once; later paints only update config.
      if (self._built) {
        self._apiUrl = apiUrl;
        return qlik.Promise.resolve();
      }
      self._built = true;
      self._apiUrl = apiUrl;
      self._app = app;
      self._replyTo = null;
      self._lastPayload = "";
      self._attachTarget = ""; // "" = whole sheet

      var sheetInfo = qlik.navigation.getCurrentSheetId();
      self._sheetId = sheetInfo.success ? sheetInfo.sheetId : "unknown-sheet";
      self._appId = app.id;

      // ---------- static skeleton ----------
      $element.html(
        '<div class="qcol-panel">' +
        '  <div class="qcol-header">' +
        '    <span class="qcol-title">Comments <span class="qcol-count"></span></span>' +
        '    <span class="qcol-conn" title="Backend connection">●</span>' +
        '  </div>' +
        '  <div class="qcol-selections" title="Current selections (captured with your comment)"></div>' +
        '  <div class="qcol-list"></div>' +
        '  <div class="qcol-compose">' +
        '    <div class="qcol-replybar" style="display:none">' +
        '      Replying to <b class="qcol-replyname"></b>' +
        '      <a href="#" class="qcol-cancelreply">×</a>' +
        '    </div>' +
        '    <input class="qcol-author" type="text" placeholder="Your name" maxlength="60"/>' +
        '    <div class="qcol-attachrow">' +
        '      <select class="qcol-attach"><option value="">＋ attach chart…</option></select>' +
        '      <button class="qcol-pick" title="Click charts on the sheet to attach the comment to them">🎯</button>' +
        '    </div>' +
        '    <div class="qcol-attachchips"></div>' +
        '    <div class="qcol-pickhint" style="display:none">Click charts to attach/detach… (Esc or 🎯 to finish)</div>' +
        '    <label class="qcol-withsel"><input type="checkbox" class="qcol-selcheck" checked/> attach current selections</label>' +
        '    <textarea class="qcol-input" placeholder="Write a comment…" rows="2"></textarea>' +
        '    <button class="qcol-send">Send</button>' +
        '  </div>' +
        '</div>'
      );

      var $list = $element.find(".qcol-list");
      var $author = $element.find(".qcol-author");
      var $input = $element.find(".qcol-input");
      var $conn = $element.find(".qcol-conn");

      $author.val(localStorage.getItem("qlikCollab.author") || "");

      // ---------- selection tracking (Capability API) ----------
      self._selState = app.selectionState();
      self._currentSelections = [];

      var onSel = function () {
        var sels = (self._selState.selections || []).map(function (s) {
          return {
            field: s.fieldName || s.field,
            values: (s.selectedValues || []).map(function (v) { return v.qName; }),
            total: s.selectedCount
          };
        });
        self._currentSelections = sels;
        var $box = $element.find(".qcol-selections");
        if (!sels.length) { $box.html('<span class="qcol-nosel">No selections</span>'); return; }
        $box.html(sels.map(function (s) {
          var vals = s.values.slice(0, 5).join(", ") + (s.total > s.values.length ? " …" : "");
          return '<span class="qcol-chip">' + esc(s.field) + ": " + esc(vals) + "</span>";
        }).join(" "));
      };
      self._selState.OnData.bind(onSel);
      onSel();

      // ---------- object picker (Etap 5, multi-select) ----------
      // The official object list feeds both the dropdown and click-to-pick.
      // Chosen charts are shown as removable chips; empty = whole sheet.
      self._cellsById = {};
      self._attachTargets = [];

      function objLabel(id) {
        var c = self._cellsById[id];
        return (c ? c.type : "chart") + " (" + id.substring(0, 8) + ")";
      }

      function renderChips() {
        var $box = $element.find(".qcol-attachchips");
        if (!self._attachTargets.length) {
          $box.html('<span class="qcol-chip qcol-chip-sheet">📄 Whole sheet</span>');
          return;
        }
        $box.html(self._attachTargets.map(function (id) {
          return '<span class="qcol-chip qcol-chip-obj">📊 ' + esc(objLabel(id)) +
                 ' <a href="#" class="qcol-chip-x" data-id="' + esc(id) + '">×</a></span>';
        }).join(" "));
      }

      function addTarget(id) {
        if (self._attachTargets.indexOf(id) === -1) self._attachTargets.push(id);
        renderChips();
      }
      function removeTarget(id) {
        self._attachTargets = self._attachTargets.filter(function (t) { return t !== id; });
        renderChips();
      }

      function loadCells() {
        return app.getObjectProperties(self._sheetId).then(function (model) {
          var cells = (model.properties && model.properties.cells) || [];
          var $sel = $element.find(".qcol-attach");
          $sel.find("option:not(:first)").remove();
          self._cellsById = {};
          cells.forEach(function (c) {
            if (c.name === layout.qInfo.qId) return; // don't offer the panel itself
            self._cellsById[c.name] = c;
            $sel.append('<option value="' + esc(c.name) + '">📊 ' + esc(c.type) + " (" + esc(c.name.substring(0, 8)) + ")</option>");
          });
        });
      }
      loadCells().catch(function () { /* edit mode / no sheet — picker stays sheet-only */ });
      renderChips();

      $element.on("change", ".qcol-attach", function () {
        var id = $(this).val();
        if (id) addTarget(id);
        $(this).val(""); // dropdown is an "add" tool; chips hold the state
      });

      $element.on("click", ".qcol-chip-x", function (e) {
        e.preventDefault();
        removeTarget($(this).data("id"));
      });

      // ---------- click-to-pick a chart on the sheet ----------
      // Qlik has no public "clicked another object" event, so in picking mode we
      // listen on the document (capture phase) and walk up from the clicked node
      // until an ancestor carries an attribute containing one of the object ids
      // we KNOW from getObjectProperties. Only known ids are ever accepted, so a
      // Qlik markup change can only disable the shortcut, never mis-attach.
      // The dropdown remains as the fallback.

      function findObjectId(el) {
        var ids = Object.keys(self._cellsById);
        for (var node = el; node && node !== document.body; node = node.parentElement) {
          var attrs = node.attributes;
          if (!attrs) continue;
          for (var i = 0; i < attrs.length; i++) {
            var v = attrs[i].value;
            if (!v) continue;
            for (var j = 0; j < ids.length; j++) {
              if (v === ids[j] || v.indexOf(ids[j]) !== -1) return { id: ids[j], el: node };
            }
          }
        }
        return null;
      }

      function clearHover() {
        if (self._hoverEl) { self._hoverEl.classList.remove("qcol-pick-hover"); self._hoverEl = null; }
      }

      self._pickedEls = {}; // id -> outlined DOM element while picking

      function markPicked(id, el) {
        self._pickedEls[id] = el;
        el.classList.add("qcol-pick-highlight");
      }
      function unmarkPicked(id) {
        if (self._pickedEls[id]) {
          self._pickedEls[id].classList.remove("qcol-pick-highlight");
          delete self._pickedEls[id];
        }
      }

      function stopPicking() {
        self._picking = false;
        document.removeEventListener("click", pickClick, true);
        document.removeEventListener("mouseover", pickHover, true);
        document.removeEventListener("keydown", pickKey, true);
        clearHover();
        Object.keys(self._pickedEls).forEach(unmarkPicked);
        $element.find(".qcol-pickhint").hide();
        $element.find(".qcol-pick").removeClass("qcol-picking");
      }
      self._stopPicking = stopPicking;

      function pickHover(e) {
        if ($element[0].contains(e.target)) { clearHover(); return; }
        var hit = findObjectId(e.target);
        if (self._hoverEl && (!hit || hit.el !== self._hoverEl)) clearHover();
        if (hit && !self._pickedEls[hit.id]) { hit.el.classList.add("qcol-pick-hover"); self._hoverEl = hit.el; }
      }

      function pickKey(e) {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); stopPicking(); }
      }

      function pickClick(e) {
        if ($element[0].contains(e.target)) { stopPicking(); return; } // clicked back in panel = finish
        var hit = findObjectId(e.target);
        if (!hit) return; // clicked empty sheet area — stay in picking mode
        e.preventDefault();
        e.stopPropagation(); // swallow the click so the chart doesn't start a selection
        clearHover();
        if (self._attachTargets.indexOf(hit.id) === -1) {   // toggle on
          addTarget(hit.id);
          markPicked(hit.id, hit.el);
        } else {                                            // toggle off
          removeTarget(hit.id);
          unmarkPicked(hit.id);
        }
      }

      $element.on("click", ".qcol-pick", function (e) {
        e.preventDefault();
        if (self._picking) { stopPicking(); return; }
        loadCells().catch(function () {});   // refresh id list (objects may have changed)
        self._picking = true;
        $(this).addClass("qcol-picking");
        $element.find(".qcol-pickhint").show();
        document.addEventListener("click", pickClick, true);
        document.addEventListener("mouseover", pickHover, true);
        document.addEventListener("keydown", pickKey, true);
      });

      // ---------- rendering ----------
      function render(comments) {
        var byParent = {};
        comments.forEach(function (c) {
          var key = c.parentId || "root";
          (byParent[key] = byParent[key] || []).push(c);
        });
        var roots = byParent["root"] || [];
        $element.find(".qcol-count").text("(" + comments.length + ")");

        var me = $author.val().trim();

        function one(c, isReply) {
          var own = c.author === me;
          var h = '<div class="qcol-item' + (isReply ? " qcol-reply" : "") + '" data-id="' + c.id + '">';
          h += '<div class="qcol-meta"><b>' + esc(c.author) + "</b> <span>" + fmtTime(c.createdAt) + "</span>";
          if (!isReply) {
            h += '<span class="qcol-status qcol-status-' + esc(c.status) + '" data-id="' + c.id + '" title="Click to change status">' + (STATUS_LABELS[c.status] || c.status) + "</span>";
          }
          if (c.objectIds && c.objectIds.length) {
            h += '<span class="qcol-objtag" title="Attached to: ' + esc(c.objectIds.map(objLabel).join(", ")) + '">📊' +
                 (c.objectIds.length > 1 ? "×" + c.objectIds.length : "") + "</span>";
          }
          h += "</div>";
          h += '<div class="qcol-body">' + esc(c.body) + "</div>";
          h += '<div class="qcol-actions">';
          if (c.selectionState && c.selectionState !== "null") {
            h += '<a href="#" class="qcol-applysel" data-sel="' + esc(c.selectionState) + '">📎 apply filters</a>';
          }
          if (!isReply) h += '<a href="#" class="qcol-doreply" data-id="' + c.id + '" data-author="' + esc(c.author) + '">reply</a>';
          if (own) h += '<a href="#" class="qcol-delete" data-id="' + c.id + '">delete</a>';
          h += "</div></div>";
          return h;
        }

        var html = roots.map(function (c) {
          return one(c, false) + (byParent[c.id] || []).map(function (r) { return one(r, true); }).join("");
        }).join("");

        var stick = $list[0] && ($list[0].scrollHeight - $list[0].scrollTop - $list[0].clientHeight < 40);
        $list.html(html || '<div class="qcol-empty">No comments yet. Start the discussion!</div>');
        if (stick) $list.scrollTop($list[0].scrollHeight);
      }

      // ---------- data ----------
      function refresh() {
        var url = self._apiUrl + "/api/comments?appId=" + encodeURIComponent(self._appId) +
                  "&sheetId=" + encodeURIComponent(self._sheetId);
        fetch(url)
          .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
          .then(function (data) {
            $conn.addClass("qcol-ok").removeClass("qcol-err");
            var payload = JSON.stringify(data);
            if (payload !== self._lastPayload) {   // re-render only on change
              self._lastPayload = payload;
              render(data);
            }
          })
          .catch(function () { $conn.addClass("qcol-err").removeClass("qcol-ok"); });
      }

      function send() {
        var author = $author.val().trim();
        var body = $input.val().trim();
        if (!author) { $author.addClass("qcol-invalid"); return; }
        if (!body) return;
        localStorage.setItem("qlikCollab.author", author);
        $author.removeClass("qcol-invalid");

        var withSel = $element.find(".qcol-selcheck").prop("checked") && self._currentSelections.length > 0;
        fetch(self._apiUrl + "/api/comments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            appId: self._appId,
            sheetId: self._sheetId,
            objectIds: self._attachTargets,
            parentId: self._replyTo,
            author: author,
            body: body,
            selectionState: withSel ? JSON.stringify(self._currentSelections) : null
          })
        }).then(function (r) {
          if (r.ok) {
            $input.val("");
            self._replyTo = null;
            self._attachTargets = [];
            renderChips();
            $element.find(".qcol-replybar").hide();
            refresh();
          }
        });
      }

      // ---------- events ----------
      $element.on("click", ".qcol-send", send);
      $element.on("keydown", ".qcol-input", function (e) {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
      });

      $element.on("click", ".qcol-doreply", function (e) {
        e.preventDefault();
        self._replyTo = parseInt($(this).data("id"), 10);
        $element.find(".qcol-replyname").text($(this).data("author"));
        $element.find(".qcol-replybar").show();
        $input.focus();
      });
      $element.on("click", ".qcol-cancelreply", function (e) {
        e.preventDefault();
        self._replyTo = null;
        $element.find(".qcol-replybar").hide();
      });

      $element.on("click", ".qcol-delete", function (e) {
        e.preventDefault();
        var id = $(this).data("id");
        fetch(self._apiUrl + "/api/comments/" + id + "?author=" + encodeURIComponent($author.val().trim()), { method: "DELETE" })
          .then(refresh);
      });

      // Etap 4: cycle status on click
      $element.on("click", ".qcol-status", function (e) {
        e.preventDefault();
        var order = ["new", "in_progress", "fixed", "closed"];
        var current = order.filter(function (s) { return $(e.target).hasClass("qcol-status-" + s); })[0] || "new";
        var next = order[(order.indexOf(current) + 1) % order.length];
        fetch(self._apiUrl + "/api/comments/" + $(this).data("id") + "/status", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: next })
        }).then(refresh);
      });

      // Etap 6: re-apply the captured selection context
      $element.on("click", ".qcol-applysel", function (e) {
        e.preventDefault();
        var sels;
        try { sels = JSON.parse($(this).attr("data-sel")); } catch (err) { return; }
        self._app.clearAll().then(function () {
          sels.forEach(function (s) {
            if (!s.field || !s.values || !s.values.length) return;
            self._app.field(s.field).selectValues(
              s.values.map(function (v) { return { qText: v }; }), false, true);
          });
        });
      });

      // ---------- polling ----------
      refresh();
      if (self._timer) clearInterval(self._timer);
      self._timer = setInterval(refresh, pollMs);

      return qlik.Promise.resolve();
    },

    beforeDestroy: function () {
      if (this._timer) clearInterval(this._timer);
      if (this._stopPicking) this._stopPicking();
      if (this._selState && this._selState.OnData) {
        try { this._selState.OnData.unbind(); } catch (e) { /* noop */ }
      }
    }
  };
});
