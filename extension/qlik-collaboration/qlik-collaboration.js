/*
 * Qlik Collaboration — comments panel extension
 *
 * Context detection (the "hard part"):
 *   - app id      : qlik.currApp(this).id
 *   - sheet id    : qlik.navigation.getCurrentSheetId()
 *   - selections  : app.selectionState() + OnData event  -> captured per comment
 *   - objects     : app.getObjectProperties(sheetId) -> properties.cells
 *                   + click-to-pick on the sheet (validated against known ids)
 *
 * Real-time: SignalR (bundled signalr.min.js) over WebSocket; the server
 * broadcasts "commentsChanged" {appId, sheetId} and "notify" {username}.
 * Polling stays as a safety net (3s without SignalR, 30s with it).
 *
 * One shared discussion per sheet: there are no private messages and nothing is
 * addressed at one person. Every comment is visible to everyone who opens the
 * sheet and carries its author's name, and the bell reports every new comment
 * from anyone — including the ones written on other sheets of the app.
 *
 * Etap 3: file attachments; voice messages are audio attachments (MediaRecorder).
 */
define(["qlik", "jquery", "./signalr.min", "css!./qlik-collaboration.css"], function (qlik, $, signalR) {
  "use strict";

  // ---------- helpers ----------

  // Shown in the panel header and logged at startup, so it is always obvious which
  // build is actually running — browser and server caches make that easy to get wrong.
  var EXT_VERSION = "0.10.0";

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

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  var STATUS_LABELS = {
    "new": "New",
    "in_progress": "In progress",
    "fixed": "Fixed",
    "closed": "Closed"
  };

  function initials(name) {
    var parts = String(name).trim().split(/\s+/);
    return ((parts[0] || "?")[0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
  }

  var AVATAR_COLORS = ["#00754a", "#1565c0", "#6a1b9a", "#b26a00", "#c2185b", "#00838f", "#5d4037", "#455a64"];

  function avatarColor(name) {
    var hash = 0;
    for (var i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  }

  function dayLabel(iso) {
    var d = new Date(iso);
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var day = new Date(d); day.setHours(0, 0, 0, 0);
    var diff = Math.round((today - day) / 86400000);
    if (diff === 0) return "Today";
    if (diff === 1) return "Yesterday";
    return d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  }

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
                  label: "Fallback refresh interval (seconds)",
                  type: "number",
                  defaultValue: 3
                },
                applyMethod: {
                  ref: "collab.applyMethod",
                  label: "Apply filters method",
                  type: "string",
                  component: "dropdown",
                  options: [
                    { value: "auto", label: "Auto - try every method in order" },
                    { value: "plain-texts-state", label: "0. selectValues ['text'] + state (works on Enterprise)" },
                    { value: "objects", label: "1. selectValues [{qText,qNumber}]" },
                    { value: "text-objects", label: "2. selectValues [{qText}] (no number)" },
                    { value: "plain-texts", label: "3. selectValues ['text']" },
                    { value: "plain-numbers", label: "4. selectValues [number]" },
                    { value: "waitfor-objects", label: "5. wait for field, then selectValues" },
                    { value: "objects-nosoftlock", label: "6. selectValues without soft lock" },
                    { value: "engine-selectvalues", label: "7. Engine API selectValues" },
                    { value: "engine-select-match", label: "8. Engine API select - search match (best for dates)" },
                    { value: "selectmatch-search", label: "9. selectMatch - search match" },
                    { value: "selectmatch", label: "10. selectMatch (single value)" }
                  ],
                  defaultValue: "auto"
                },
                identityMode: {
                  ref: "collab.identityMode",
                  label: "User identity",
                  type: "string",
                  component: "dropdown",
                  options: [
                    { value: "auto", label: "Auto — Qlik identity, manual name if unavailable" },
                    { value: "qlik", label: "Qlik identity only — name cannot be typed" },
                    { value: "manual", label: "Manual name entry (development)" }
                  ],
                  defaultValue: "auto"
                },
                displayMode: {
                  ref: "collab.displayMode",
                  label: "Panel display",
                  type: "string",
                  component: "dropdown",
                  options: [
                    { value: "bubble", label: "Bubble — collapsed to a button, expands over the sheet" },
                    { value: "docked", label: "Docked — always open, fills its cell" }
                  ],
                  defaultValue: "bubble"
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
      var identityMode = (layout.collab && layout.collab.identityMode) || "auto";
      var displayMode = (layout.collab && layout.collab.displayMode) || "bubble";

      // Build the UI once; later paints only re-apply changed settings.
      // (Qlik re-paints on resize and after every property-panel edit, so this
      // path must honour setting changes — not silently ignore them.)
      if (self._built) {
        self._apiUrl = apiUrl;
        self._applyMethod = (layout.collab && layout.collab.applyMethod) || "auto";
        if (self._identityMode !== identityMode) {
          self._identityMode = identityMode;
          self._applyIdentityMode();
        }
        if (self._pollMs !== pollMs) {
          self._pollMs = pollMs;
          if (self._timer) clearInterval(self._timer);
          self._timer = setInterval(self._tick, self._live ? 30000 : pollMs);
        }
        // Qlik repaints when the sheet switches between analysis and edit mode, so
        // this is also where floating gives way to docked while a sheet is edited.
        if (self._displayMode !== displayMode) self._displayMode = displayMode;
        if (self._applyDisplayMode) self._applyDisplayMode();
        // Qlik repaints on resize, so this keeps the size buckets right even on a
        // client with no ResizeObserver.
        if (self._applySize) self._applySize();
        return qlik.Promise.resolve();
      }
      self._built = true;
      console.log("qlik-collaboration v" + EXT_VERSION + " loaded");
      self._apiUrl = apiUrl;
      self._app = app;
      self._replyTo = null;
      self._lastPayload = "";
      self._attachTargets = [];
      self._pendingFiles = [];
      self._notifs = [];
      self._live = false;

      var sheetInfo = qlik.navigation.getCurrentSheetId();
      self._sheetId = sheetInfo.success ? sheetInfo.sheetId : "unknown-sheet";
      self._appId = app.id;

      // ---------- static skeleton ----------
      $element.html(
        '<div class="qcol-panel">' +
        // Collapsed state. Lives in the cell (make that cell small on the sheet);
        // expanding lifts the panel out over the dashboard.
        '  <button class="qcol-bubble" title="Comments">' +
        '    <span class="qcol-bubble-icon">💬</span>' +
        '    <span class="qcol-bubble-badge" style="display:none"></span>' +
        '  </button>' +
        '  <div class="qcol-header">' +
        '    <span class="qcol-title" title="Qlik Collaboration v' + EXT_VERSION + '">Comments ' +
        '<span class="qcol-count"></span> <span class="qcol-ver">v' + EXT_VERSION + '</span></span>' +
        '    <span class="qcol-headright">' +
        '      <span class="qcol-me" style="display:none">' +
        '        <span class="qcol-me-avatar"></span><span class="qcol-me-name"></span>' +
        '      </span>' +
        '      <span class="qcol-bell" title="New comments from the team">🔔<span class="qcol-badge" style="display:none"></span></span>' +
        '      <span class="qcol-conn" title="Backend connection">●</span>' +
        '      <span class="qcol-collapse" title="Collapse">✕</span>' +
        '    </span>' +
        '  </div>' +
        '  <div class="qcol-notifs" style="display:none">' +
        '    <div class="qcol-notifs-head">Team activity <a href="#" class="qcol-markread">mark all read</a></div>' +
        '    <div class="qcol-notifs-list"></div>' +
        '  </div>' +
        '  <div class="qcol-selections" style="display:none" title="Current selections (captured with your comment) - click to show what Qlik reports"></div>' +
        '  <pre class="qcol-debug" style="display:none"></pre>' +
        '  <div class="qcol-main">' +
        '    <div class="qcol-list"></div>' +
        '    <div class="qcol-toast" style="display:none"></div>' +
        '  </div>' +
        '  <div class="qcol-compose">' +
        '    <div class="qcol-replybar" style="display:none">' +
        '      Replying to <b class="qcol-replyname"></b>' +
        '      <a href="#" class="qcol-cancelreply">×</a>' +
        '    </div>' +
        '    <div class="qcol-identity-wait" style="display:none">Identifying you through Qlik Sense…</div>' +
        '    <input class="qcol-author" type="text" placeholder="Your name" maxlength="60"/>' +
        '    <div class="qcol-extras" style="display:none">' +
        '      <div class="qcol-attachrow">' +
        '        <select class="qcol-attach"><option value="">attach to a chart…</option></select>' +
        '        <button class="qcol-pick" title="Click charts on the sheet to attach the comment to them">🎯</button>' +
        '      </div>' +
        '      <label class="qcol-withsel"><input type="checkbox" class="qcol-selcheck" checked/> attach current selections</label>' +
        '    </div>' +
        '    <div class="qcol-attachchips" style="display:none"></div>' +
        '    <div class="qcol-pickhint" style="display:none">Click charts to attach/detach… (Esc or 🎯 to finish)</div>' +
        '    <textarea class="qcol-input" placeholder="Write a comment — everyone sees it" rows="1"></textarea>' +
        '    <div class="qcol-pending"></div>' +
        '    <div class="qcol-toolbar">' +
        '      <button class="qcol-more" title="Attach the comment to charts or to the current selections">＋</button>' +
        '      <button class="qcol-filebtn" title="Attach files">📎</button>' +
        '      <button class="qcol-voice" title="Record a voice message">🎤</button>' +
        '      <input type="file" class="qcol-file" multiple style="display:none"/>' +
        '      <button class="qcol-send">Send</button>' +
        '    </div>' +
        '  </div>' +
        '</div>'
      );

      var $list = $element.find(".qcol-list");
      var $author = $element.find(".qcol-author");
      var $input = $element.find(".qcol-input");
      var $conn = $element.find(".qcol-conn");

      // ---------- identity ----------
      // On Enterprise every user is already authenticated by the Qlik Proxy (AD),
      // so we ask Qlik who they are and show that identity read-only — nobody can
      // post under someone else's name. On Desktop Qlik reports UserDirectory=
      // Personal (no real auth), so "auto" falls back to a typed name for dev.
      //   auto   — Qlik identity when real, manual otherwise (default)
      //   qlik   — always the Qlik identity; no manual entry, ever
      //   manual — typed name (development only)
      // kept on `self` (not a closure var) so a property-panel change during a
      // later paint is picked up by the resolver below
      self._identityMode = identityMode;
      self._displayMode = displayMode;
      self._applyMethod = (layout.collab && layout.collab.applyMethod) || "auto";
      self._authorDirectory = null;

      // Announce whoever is reading, not only whoever writes. Comments notify every
      // known user, so a colleague who has never posted would otherwise be outside
      // that audience and see an empty bell until their first comment.
      function registerMe(name, dir) {
        var who = (name || "").trim();
        if (!who || who === self._registeredAs) return;
        self._registeredAs = who;
        fetch(self._apiUrl + "/api/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: who, userDirectory: dir || null })
        }).then(refreshNotifs).catch(function () { self._registeredAs = null; });
      }

      function showManualIdentity() {
        self._authorDirectory = null;
        $element.find(".qcol-me, .qcol-identity-wait").hide();
        $element.find(".qcol-identity-wait").removeClass("qcol-identity-error");
        $element.find(".qcol-send").prop("disabled", false);
        $author.show().val(localStorage.getItem("qlikCollab.author") || "");
        self._lastPayload = "";
        refresh();
        registerMe($author.val(), null);
        refreshNotifs();
      }

      function showQlikIdentity(uid, dir) {
        self._authorDirectory = dir || null;
        $author.val(uid).hide();
        $element.find(".qcol-send").prop("disabled", false);
        $element.find(".qcol-identity-wait").hide().removeClass("qcol-identity-error");
        $element.find(".qcol-me-avatar")
          .text(initials(uid))
          .css("background", avatarColor(uid));
        $element.find(".qcol-me-name").text(uid);
        $element.find(".qcol-me")
          .attr("title", "Signed in through Qlik Sense as " + (dir ? dir + "\\" : "") +
                         uid + " — this name cannot be changed")
          .css("display", "flex");
        // re-render: which comments are "mine" (delete link) depends on the identity
        self._lastPayload = "";
        refresh();
        registerMe(uid, dir);
        refreshNotifs();
      }

      function identityBlocked(msg) {
        $author.hide();
        $element.find(".qcol-me").hide();
        $element.find(".qcol-identity-wait").text("⚠ " + msg).addClass("qcol-identity-error").show();
        $element.find(".qcol-send").prop("disabled", true);
      }

      // The engine answers in one of two shapes depending on the deployment —
      // both verified against a live engine, so parse either:
      //   Enterprise : "UserDirectory=BANK; UserId=ivanov"
      //   Desktop    : "Personal\Me"
      function parseQlikUser(raw) {
        var s = String(raw === undefined || raw === null ? "" : raw).trim();
        if (!s) return null;
        var uid = (s.match(/UserId\s*=\s*([^;]+)/i) || [])[1];
        var dir = (s.match(/UserDirectory\s*=\s*([^;]+)/i) || [])[1];
        if (!uid && s.indexOf("\\") !== -1) {        // "DIRECTORY\user"
          var parts = s.split("\\");
          dir = parts[0];
          uid = parts.slice(1).join("\\");
        }
        if (!uid) uid = s;                           // bare user name
        uid = uid.trim();
        dir = dir ? dir.trim() : null;
        return uid ? { uid: uid, dir: dir } : null;
      }

      function resolveQlikIdentity() {
        var settled = false;

        function fallback(msg) {
          if (settled) return;
          settled = true;
          if (self._identityMode === "qlik") identityBlocked(msg); else showManualIdentity();
        }

        function handleReply(reply) {
          if (settled) return;
          var raw = (reply && reply.qReturn !== undefined) ? reply.qReturn : reply;
          var u = parseQlikUser(raw);
          if (!u) { fallback("Qlik returned no user name."); return; }
          // Desktop has no real login — everyone is Personal\Me. Only trust it as
          // an identity on a server, or when the admin explicitly forced "qlik".
          var isPersonal = !u.dir || u.dir.toLowerCase() === "personal";
          if (!isPersonal || self._identityMode === "qlik") {
            settled = true;
            showQlikIdentity(u.uid, u.dir);
          } else {
            fallback("Qlik reports no authenticated login (Desktop).");
          }
        }

        try {
          var g = (app && app.global) ||
                  (typeof qlik.getGlobal === "function" ? qlik.getGlobal() : null);
          if (!g || typeof g.getAuthenticatedUser !== "function") {
            fallback("Qlik identity API unavailable.");
            return;
          }
          // Capability API methods take a callback and usually also return a
          // promise — accept whichever this Qlik version provides.
          var p = g.getAuthenticatedUser(function (reply) { handleReply(reply); });
          if (p && typeof p.then === "function") {
            p.then(handleReply, function () { fallback("Could not read your Qlik identity."); });
          }
          // never leave the panel stuck on "Identifying you…"
          setTimeout(function () { fallback("Qlik identity request timed out."); }, 5000);
        } catch (e) {
          fallback("Qlik identity API unavailable.");
        }
      }

      function applyIdentityMode() {
        if (self._identityMode === "manual") {
          showManualIdentity();
        } else {
          $author.hide();
          $element.find(".qcol-me").hide();
          $element.find(".qcol-identity-wait")
            .removeClass("qcol-identity-error")
            .text("Identifying you through Qlik Sense…")
            .show();
          resolveQlikIdentity();
        }
      }
      self._applyIdentityMode = applyIdentityMode;
      applyIdentityMode();

      // ---------- selection tracking (Capability API) ----------
      // Selections live per STATE. Objects using an alternate state put their
      // selections in that state, not in the default "$" — reading only "$" is why
      // filters from some charts were captured and from others were not.
      self._selStates = {};                       // stateName -> selectionState object
      self._selState = app.selectionState();      // default state
      self._selStates["$"] = self._selState;
      self._currentSelections = [];
      self._selSignature = "";

      function trackState(name) {
        if (!name || self._selStates[name]) return;
        try {
          var st = app.selectionState(name);
          self._selStates[name] = st;
          try { st.OnData.bind(onSel); } catch (e) { /* the poll covers it */ }
        } catch (e) {
          console.warn("qlik-collaboration: cannot track alternate state '" + name + "'", e);
        }
      }

      // discover alternate states defined in the app, and pick up the app title on
      // the way past: the team inbox lists work from every app at once, where an id
      // is a GUID on Enterprise and a .qvf path on Desktop. Neither says which
      // dashboard is meant, and only the client can see the title.
      self._appName = null;
      self._sheetName = null;
      try {
        app.getAppLayout(function (layout) {
          var l = (layout && layout.qLayout) || layout || {};
          var names = l.qStateNames || [];
          names.forEach(trackState);
          if (names.length) console.log("qlik-collaboration: alternate states:", names);
          self._appName = l.qTitle || (l.qMeta && l.qMeta.title) || null;
        });
      } catch (e) { /* titles stay null; the inbox falls back to the ids */ }

      // A selected value may be numeric (Year, amounts, dates). Selecting such a
      // field back by its TEXT alone silently matches nothing, so keep the number
      // whenever we can prove the value really is numeric.
      function numericOf(v) {
        if (typeof v.qNumber !== "number" || !isFinite(v.qNumber)) return null;
        if (v.qIsNumeric === true) return v.qNumber;
        // qIsNumeric is not always present: fall back to "the text IS the number"
        if (String(v.qNumber) === String(v.qName)) return v.qNumber;
        return null;
      }

      function snapshotSelections() {
        var out = [];
        Object.keys(self._selStates).forEach(function (stateName) {
          var st = self._selStates[stateName];
          ((st && st.selections) || []).forEach(function (s) {
            var vals = s.selectedValues || [];
            var entry = {
              field: s.fieldName || s.field,
              // plain strings: what the chips show, and the format older comments stored
              values: vals.map(function (v) { return v.qName; }),
              // text + number pairs, used when re-applying
              raw: vals.map(function (v) {
                var num = numericOf(v);
                return num === null ? { text: v.qName } : { text: v.qName, number: num };
              }),
              total: s.selectedCount
            };
            if (stateName !== "$") entry.state = stateName;
            // A range selection (dragging an axis, a date range) reports a count but
            // no discrete values, so there is nothing to store or replay. Flag it so
            // the panel can say so instead of silently attaching an empty filter.
            if (!vals.length && s.selectedCount) entry.unsupportedRange = true;
            out.push(entry);
          });
        });
        return out;
      }

      function renderSelections(sels) {
        var $box = $element.find(".qcol-selections");
        // An always-present "No selections" row spent a permanent 35px saying that
        // nothing had happened. When there is nothing to report, report nothing.
        if (!sels.length) {
          $box.empty().hide();
        } else {
          $box.show().html(sels.map(function (s) {
            if (s.unsupportedRange) {
              return '<span class="qcol-chip qcol-chip-range" title="Qlik reports a range selection here, which has no individual values to save or replay. Select the values instead (e.g. in a filter pane) to attach them.">' +
                     esc(s.field) + ": range (cannot be saved)</span>";
            }
            var vals = s.values.slice(0, 5).join(", ") + (s.total > s.values.length ? " …" : "");
            var label = (s.state ? "[" + s.state + "] " : "") + s.field;
            return '<span class="qcol-chip">' + esc(label) + ": " + esc(vals) + "</span>";
          }).join(" "));
        }
        if (self._debug) renderDebug(sels);
      }

      // Click the selections strip to show exactly what Qlik reports — the fastest
      // way to see why a particular chart's filters are not being captured.
      function renderDebug(sels) {
        var lines = ["states tracked: " + Object.keys(self._selStates).join(", ")];
        Object.keys(self._selStates).forEach(function (name) {
          var raw = (self._selStates[name] || {}).selections || [];
          lines.push("--- state " + name + ": " + raw.length + " selection(s) ---");
          raw.forEach(function (s) {
            lines.push(JSON.stringify({
              field: s.fieldName || s.field,
              selectedCount: s.selectedCount,
              selectedValues: (s.selectedValues || []).slice(0, 5)
            }));
          });
        });
        lines.push("--- captured for the next comment ---");
        lines.push(JSON.stringify(sels, null, 1));
        $element.find(".qcol-debug").text(lines.join("\n")).show();
      }

      $element.on("click", ".qcol-selections", function () {
        self._debug = !self._debug;
        if (self._debug) { renderDebug(self._currentSelections); }
        else { $element.find(".qcol-debug").hide(); }
      });

      function onSel() {
        var sels = snapshotSelections();
        var sig = JSON.stringify(sels);
        if (sig === self._selSignature) return;   // nothing changed: no work, no redraw
        self._selSignature = sig;
        self._currentSelections = sels;
        renderSelections(sels);
      }

      try { self._selState.OnData.bind(onSel); } catch (e) { /* the poll below covers it */ }
      onSel();

      // OnData does not fire reliably in every Sense deployment, and if it stays
      // silent nothing is ever captured — the comment is then saved with no filters
      // and no "apply filters" link appears for anyone. A cheap poll makes capture
      // independent of the event; the signature check keeps it free when idle.
      if (self._selTimer) clearInterval(self._selTimer);
      self._selTimer = setInterval(onSel, 1000);

      // ---------- object picker (Etap 5, multi-select) ----------
      self._cellsById = {};

      function objLabel(id) {
        var c = self._cellsById[id];
        return (c ? c.type : "chart") + " (" + id.substring(0, 8) + ")";
      }

      function renderChips() {
        var $box = $element.find(".qcol-attachchips");
        // "Whole sheet" is the default and needs no chip to announce it — the chips
        // only appear once the comment is actually pinned to something.
        if (!self._attachTargets.length) {
          $box.empty().hide();
          return;
        }
        $box.show().html(self._attachTargets.map(function (id) {
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
          var props = model.properties || {};
          // The sheet's own title rides along with the properties we already fetch
          // for the chart picker — no extra call to get a readable name for the inbox.
          self._sheetName = (props.qMetaDef && props.qMetaDef.title) ||
                            (props.qMeta && props.qMeta.title) || null;
          var cells = props.cells || [];
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
      // Chart names in the "attached to" tooltip come from this list, so re-render
      // once it arrives — the first render usually happens before it resolves.
      loadCells().then(function () {
        self._lastPayload = "";
        refresh();
      }).catch(function () { /* edit mode / no sheet — picker stays sheet-only */ });
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

      // ---------- click-to-pick charts on the sheet ----------
      // No public "clicked another object" event exists, so in picking mode we
      // listen on the document (capture) and walk up from the clicked node until
      // an ancestor attribute contains one of the ids we KNOW from
      // getObjectProperties. Only known ids are accepted — a Qlik markup change
      // can disable the shortcut but never mis-attach. Dropdown is the fallback.

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
        if ($element[0].contains(e.target)) {           // clicked back in panel = finish
          stopPicking();
          // if it was the 🎯 button itself, swallow the click — otherwise its own
          // handler fires next, sees picking==false, and restarts picking mode
          if ($(e.target).closest(".qcol-pick").length) { e.preventDefault(); e.stopPropagation(); }
          return;
        }
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

      // ---------- show which charts a comment is attached to ----------
      // The reverse of the picker: given an object id, find its element on the
      // sheet. Qlik puts the id in an attribute of the cell container; which
      // attribute varies by version, so try the known ones and then fall back to
      // scanning, exactly as the picker does in the other direction.
      function findElementForObject(objId) {
        var direct = ['[tid="' + objId + '"]', '[data-qid="' + objId + '"]', '[data-id="' + objId + '"]'];
        for (var i = 0; i < direct.length; i++) {
          try {
            var hit = document.querySelector(direct[i]);
            if (hit && !$element[0].contains(hit)) return hit;
          } catch (e) { /* invalid selector for this id - ignore */ }
        }
        var all = document.querySelectorAll("div,section,article");
        for (var j = 0; j < all.length; j++) {
          var node = all[j];
          if ($element[0].contains(node)) continue;      // never match the panel itself
          var attrs = node.attributes;
          for (var k = 0; k < attrs.length; k++) {
            if (attrs[k].value && attrs[k].value.indexOf(objId) !== -1) return node;
          }
        }
        return null;
      }

      function showAttachedObjects(ids) {
        var found = [];
        ids.forEach(function (id) {
          var el = findElementForObject(id);
          if (!el) return;
          found.push(el);
          el.classList.add("qcol-pick-highlight");
          setTimeout(function () { el.classList.remove("qcol-pick-highlight"); }, 3000);
        });

        if (!found.length) {
          toast("Those charts are not on this sheet any more.");
          return;
        }
        try { found[0].scrollIntoView({ block: "nearest" }); } catch (e) { /* older client */ }
        toast(found.length === ids.length
          ? (ids.length > 1 ? "Highlighted " + ids.length + " charts" : "Highlighted the chart")
          : "Highlighted " + found.length + " of " + ids.length + " charts (the rest are gone)");
      }

      $element.on("click", ".qcol-objtag", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var ids = ($(this).attr("data-objs") || "").split(",").filter(Boolean);
        if (ids.length) showAttachedObjects(ids);
      });

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

      // ---------- composer behaviour ----------

      // Pinning a comment to a chart is occasional. A permanently visible dropdown,
      // picker button and checkbox charged every sheet ~57px for the times it is not.
      $element.on("click", ".qcol-more", function (e) {
        e.preventDefault();
        var $extras = $element.find(".qcol-extras");
        $extras.toggle();
        $(this).toggleClass("qcol-open", $extras.is(":visible"));
      });

      // Grow the box to the text instead of reserving two rows in advance. The cap
      // comes from the stylesheet so the shorter limit under .qcol-short applies too.
      function autoGrow() {
        var ta = $input[0];
        if (!ta) return;
        ta.style.height = "auto";
        var max = parseFloat(window.getComputedStyle(ta).maxHeight);
        ta.style.height = Math.min(ta.scrollHeight, isFinite(max) ? max : 108) + "px";
      }
      self._autoGrow = autoGrow;
      $element.on("input", ".qcol-input", autoGrow);

      // ---------- notifications ----------
      // Every new comment notifies everyone but its author, so the bell is a feed of
      // what the team is doing — across all sheets of the app, not just this one.
      // 'mention'/'broadcast' are legacy kinds: rows written before @mentions were
      // removed are still in the database and must keep rendering.

      var KIND_ICON = { comment: "💬", reply: "↩", status_change: "✎", mention: "@", broadcast: "📢" };
      var KIND_TEXT = {
        comment: "commented",
        reply: "replied to you",
        status_change: "changed the status",
        mention: "mentioned you",
        broadcast: "commented"
      };

      function refreshNotifs() {
        var me = $author.val().trim();
        if (!me) return;
        fetch(self._apiUrl + "/api/notifications?user=" + encodeURIComponent(me))
          .then(function (r) { return r.json(); })
          .then(function (list) {
            self._notifs = list || [];
            var unread = self._notifs.filter(function (n) { return !n.isRead; }).length;
            var label = unread > 99 ? "99+" : String(unread);
            var $badge = $element.find(".qcol-badge");
            if (unread > 0) $badge.text(label).show(); else $badge.hide();
            // Collapsed, the bubble is the only thing on screen — without the count on
            // it, hiding the panel would also hide the fact that anyone had written.
            var $bub = $element.find(".qcol-bubble-badge");
            if (unread > 0) $bub.text(label).show(); else $bub.hide();
            $element.find(".qcol-bubble").attr("title",
              unread > 0 ? "Comments — " + unread + " new" : "Comments");

            // Rebuilding the open dropdown on every poll would reset its scroll
            // under the user's cursor — only redraw when something changed.
            var payload = JSON.stringify(self._notifs);
            if (payload === self._notifPayload) return;
            self._notifPayload = payload;

            $element.find(".qcol-notifs-list").html(
              self._notifs.length
                ? self._notifs.map(function (n) {
                    var here = n.appId === self._appId && n.sheetId === self._sheetId;
                    return '<div class="qcol-notif' + (n.isRead ? "" : " qcol-notif-unread") + '"' +
                           ' data-id="' + n.id + '" data-comment="' + n.commentId + '"' +
                           ' data-app="' + esc(n.appId) + '" data-sheet="' + esc(n.sheetId) + '"' +
                           ' title="' + (here ? "Show this comment" : "Open the sheet with this comment") + '">' +
                           '<span class="qcol-notif-kind">' + (KIND_ICON[n.kind] || "•") + "</span>" +
                           '<span class="qcol-notif-text"><b>' + esc(n.fromAuthor) + "</b> " +
                           esc(KIND_TEXT[n.kind] || "") + ": " + esc(n.excerpt) + "</span>" +
                           '<span class="qcol-notif-time">' + fmtTime(n.createdAt) + "</span>" +
                           (here ? "" : '<span class="qcol-notif-away" title="On another sheet">↗</span>') +
                           "</div>";
                  }).join("")
                : '<div class="qcol-empty">No notifications</div>'
            );
          })
          .catch(function () {});
      }

      // ---------- jumping to the comment a notification points at ----------

      function toast(msg) {
        var $t = $element.find(".qcol-toast");
        $t.text(msg).stop(true, true).fadeIn(120);
        clearTimeout(self._toastTimer);
        self._toastTimer = setTimeout(function () { $t.fadeOut(300); }, 3500);
      }

      function highlightComment(commentId) {
        var $item = $list.find('.qcol-item[data-id="' + commentId + '"]');
        if (!$item.length) {
          toast("That comment is no longer on this sheet.");
          return false;
        }
        // scroll inside the list only — never move the Qlik sheet behind us
        var top = $item.position().top + $list.scrollTop() - ($list.height() / 2) + ($item.height() / 2);
        $list.scrollTop(Math.max(0, top));
        var $card = $item.find(".qcol-msg").addClass("qcol-flash");
        setTimeout(function () { $card.removeClass("qcol-flash"); }, 2200);
        return true;
      }

      function gotoComment(appId, sheetId, commentId) {
        if (appId !== self._appId) {
          toast("This comment belongs to another app — open that app to see it.");
          return;
        }
        if (sheetId !== self._sheetId) {
          // hand the target to the panel on the destination sheet
          try {
            sessionStorage.setItem("qlikCollab.goto",
              JSON.stringify({ appId: appId, sheetId: sheetId, commentId: commentId }));
          } catch (e) { /* private mode — navigation still works, just no highlight */ }
          try {
            // gotoSheet reports failure by return value, not by throwing
            var nav = qlik.navigation.gotoSheet(sheetId);
            if (nav && nav.success === false) {
              try { sessionStorage.removeItem("qlikCollab.goto"); } catch (e2) { /* noop */ }
              toast("Could not open that sheet: " + (nav.errorMsg || "unknown error"));
            }
          } catch (e) {
            try { sessionStorage.removeItem("qlikCollab.goto"); } catch (e2) { /* noop */ }
            toast("Could not open that sheet.");
          }
          return;
        }
        highlightComment(commentId);
      }

      // after navigating from another sheet, highlight the comment we came for
      function consumePendingGoto() {
        var raw = null;
        try { raw = sessionStorage.getItem("qlikCollab.goto"); } catch (e) { return; }
        if (!raw) return;
        var t = null;
        try { t = JSON.parse(raw); } catch (e) { /* corrupt — drop it below */ }
        if (!t || t.appId !== self._appId || t.sheetId !== self._sheetId) return;
        try { sessionStorage.removeItem("qlikCollab.goto"); } catch (e) { /* noop */ }
        setTimeout(function () { highlightComment(String(t.commentId)); }, 300);
      }

      $element.on("click", ".qcol-notif", function () {
        var $n = $(this);
        var me = $author.val().trim();
        var notifId = $n.attr("data-id");

        if (me && $n.hasClass("qcol-notif-unread")) {
          $n.removeClass("qcol-notif-unread");   // instant feedback
          fetch(self._apiUrl + "/api/notifications/" + notifId + "/read?user=" + encodeURIComponent(me),
                { method: "PUT" })
            .then(refreshNotifs)
            .catch(function () {});
        }

        $element.find(".qcol-notifs").hide();
        gotoComment($n.attr("data-app"), $n.attr("data-sheet"), $n.attr("data-comment"));
      });

      $element.on("click", ".qcol-bell", function () {
        $element.find(".qcol-notifs").toggle();
        refreshNotifs();
      });

      $element.on("click", ".qcol-markread", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var me = $author.val().trim();
        if (!me) return;
        fetch(self._apiUrl + "/api/notifications/read?user=" + encodeURIComponent(me), { method: "PUT" })
          .then(refreshNotifs);
      });

      // dev mode only: the Qlik identity cannot be typed, so this fires only when
      // someone edits the manual name field
      $element.on("change", ".qcol-author", function () {
        registerMe($author.val(), null);
        refreshNotifs();
      });

      // ---------- attachments & voice (Etap 3) ----------

      function renderPending() {
        var $box = $element.find(".qcol-pending");
        if (!self._pendingFiles.length) { $box.empty().hide(); return; }
        $box.show().html(self._pendingFiles.map(function (f, i) {
          var icon = /\.webm$|\.ogg$|\.mp3$|\.m4a$|\.wav$/i.test(f.name) ? "🎤" : "📄";
          return '<span class="qcol-chip qcol-chip-file">' + icon + " " + esc(f.name) +
                 ' <a href="#" class="qcol-pending-x" data-i="' + i + '">×</a></span>';
        }).join(" "));
      }

      $element.on("click", ".qcol-filebtn", function (e) {
        e.preventDefault();
        $element.find(".qcol-file").trigger("click");
      });

      $element.on("change", ".qcol-file", function () {
        var files = this.files;
        for (var i = 0; i < files.length; i++) {
          self._pendingFiles.push({ file: files[i], name: files[i].name });
        }
        this.value = "";
        renderPending();
      });

      $element.on("click", ".qcol-pending-x", function (e) {
        e.preventDefault();
        self._pendingFiles.splice(parseInt($(this).data("i"), 10), 1);
        renderPending();
      });

      function stopRecording() {
        if (self._recorder) {
          try { self._recorder.stop(); } catch (err) { /* already stopped */ }
          self._recorder = null;
        }
        $element.find(".qcol-voice").removeClass("qcol-recording").text("🎤");
      }
      self._stopRecording = stopRecording;

      // The pending strip is hidden while empty, so an error posted into it has to
      // reveal it — and hide it again afterwards if no files are queued behind it.
      function voiceError(msg) {
        var $box = $element.find(".qcol-pending");
        $box.find(".qcol-voicerr").remove();
        $box.show().append('<span class="qcol-chip qcol-voicerr">⚠ ' + esc(msg) + "</span>");
        setTimeout(function () {
          $box.find(".qcol-voicerr").remove();
          renderPending();
        }, 6000);
      }

      function startRecording() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === "undefined") {
          voiceError("No microphone support in this browser — try Chrome at localhost:4848/hub");
          return;
        }
        navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
          var chunks = [];
          var rec = new MediaRecorder(stream);
          self._recorder = rec;
          rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
          rec.onstop = function () {
            stream.getTracks().forEach(function (t) { t.stop(); });
            if (chunks.length) {
              var blob = new Blob(chunks, { type: "audio/webm" });
              var stamp = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
              self._pendingFiles.push({ file: blob, name: "voice-" + stamp + ".webm" });
              renderPending();
            }
          };
          rec.start();
          $element.find(".qcol-voice").addClass("qcol-recording").text("⏹");
        }).catch(function (err) {
          console.error("qlik-collaboration: microphone error", err);
          voiceError("Microphone blocked (" + (err && err.name) + ") — try Chrome at localhost:4848/hub");
        });
      }

      $element.on("click", ".qcol-voice", function (e) {
        e.preventDefault();
        if (self._recorder) stopRecording(); else startRecording();
      });

      // ---------- rendering ----------

      function renderAttachments(c) {
        if (!c.attachments || !c.attachments.length) return "";
        return '<div class="qcol-atts">' + c.attachments.map(function (a) {
          var url = self._apiUrl + "/api/attachments/" + a.id;
          if (/^image\//.test(a.contentType)) {
            return '<a href="' + url + '" target="_blank"><img class="qcol-att-img" src="' + url + '" alt="' + esc(a.fileName) + '"/></a>';
          }
          if (/^audio\//.test(a.contentType) || /\.webm$/i.test(a.fileName)) {
            return '<audio class="qcol-att-audio" controls preload="none" src="' + url + '"></audio>';
          }
          return '<a class="qcol-att-file" href="' + url + '" target="_blank">📄 ' + esc(a.fileName) +
                 ' <span>(' + fmtSize(a.sizeBytes) + ")</span></a>";
        }).join("") + "</div>";
      }

      function render(comments) {
        // Soft-deleting a parent keeps its replies (schema.sql), so a reply can
        // arrive with a parent that is no longer in the list — show it as a root
        // instead of dropping it from the panel entirely.
        var present = {};
        comments.forEach(function (c) { present[c.id] = true; });

        var byParent = {};
        comments.forEach(function (c) {
          var key = (c.parentId && present[c.parentId]) ? c.parentId : "root";
          (byParent[key] = byParent[key] || []).push(c);
        });
        var roots = byParent["root"] || [];
        $element.find(".qcol-count").text("(" + comments.length + ")");

        var me = $author.val().trim();

        function one(c, isReply) {
          var own = c.author === me;
          var h = '<div class="qcol-item' + (isReply ? " qcol-reply" : "") + '" data-id="' + c.id + '">';
          h += '<span class="qcol-avatar" style="background:' + avatarColor(c.author) + '">' + esc(initials(c.author)) + "</span>";
          h += '<div class="qcol-msg">';
          h += '<div class="qcol-meta"><b>' + esc(c.author) + '</b><span class="qcol-time">' + fmtTime(c.createdAt) + "</span>";
          if (!isReply) {
            h += '<span class="qcol-status qcol-status-' + esc(c.status) + '" data-id="' + c.id + '" title="Click to change status">' + (STATUS_LABELS[c.status] || c.status) + "</span>";
          }
          if (c.objectIds && c.objectIds.length) {
            h += '<span class="qcol-objtag" data-objs="' + esc(c.objectIds.join(",")) + '"' +
                 ' title="Attached to: ' + esc(c.objectIds.map(objLabel).join(", ")) +
                 '\nClick to highlight these charts on the sheet">📊' +
                 (c.objectIds.length > 1 ? "×" + c.objectIds.length : "") + "</span>";
          }
          h += "</div>";
          h += '<div class="qcol-body">' + esc(c.body) + "</div>";
          h += renderAttachments(c);
          h += '<div class="qcol-actions">';
          if (c.selectionState && c.selectionState !== "null") {
            h += '<a href="#" class="qcol-applysel" data-sel="' + esc(c.selectionState) + '">📎 apply filters</a>';
          }
          if (!isReply) h += '<a href="#" class="qcol-doreply" data-id="' + c.id + '" data-author="' + esc(c.author) + '">reply</a>';
          if (own) h += '<a href="#" class="qcol-delete" data-id="' + c.id + '">delete</a>';
          h += "</div></div></div>";
          return h;
        }

        var lastDay = null;
        var html = roots.map(function (c) {
          var block = "";
          var day = dayLabel(c.createdAt);
          if (day !== lastDay) {
            lastDay = day;
            block += '<div class="qcol-day"><span>' + esc(day) + "</span></div>";
          }
          block += one(c, false) + (byParent[c.id] || []).map(function (r) { return one(r, true); }).join("");
          return block;
        }).join("");

        var stick = $list[0] && ($list[0].scrollHeight - $list[0].scrollTop - $list[0].clientHeight < 40);
        $list.html(html || '<div class="qcol-empty">No comments yet. Start the discussion!</div>');
        if (stick) $list.scrollTop($list[0].scrollHeight);
      }

      // ---------- data ----------

      // fetch() rejects with a TypeError when the request never reached a server at
      // all — backend down, wrong port, blocked by the Enterprise CSP. That is a very
      // different problem from a server that answered and said no, so name it.
      function describeFetchError(err) {
        if (err instanceof TypeError) return "no response — backend down, wrong URL, or blocked by the Qlik CSP";
        return (err && err.message) ? "server answered " + err.message : "unknown error";
      }

      function refresh() {
        // The server decides what this person may read — the team sees every thread,
        // anyone else only their own — so it has to be told who is asking. Until the
        // identity resolves it would answer with an empty list, which would blank the
        // panel and then repopulate it; skip the round trip instead.
        var me = ($author.val() || "").trim();
        if (!me) {
          // Manual mode with nothing typed is a dead end the user can fix; the Qlik
          // identity path is still resolving and the composer already says so.
          if ($author.is(":visible")) {
            $list.html('<div class="qcol-empty">Enter your name below to see the discussion.</div>');
          }
          return;
        }

        var url = self._apiUrl + "/api/comments?appId=" + encodeURIComponent(self._appId) +
                  "&sheetId=" + encodeURIComponent(self._sheetId) +
                  "&user=" + encodeURIComponent(me);
        fetch(url)
          .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
          .then(function (data) {
            $conn.addClass("qcol-ok").removeClass("qcol-err")
                 .attr("title", "Connected to " + self._apiUrl);
            var payload = JSON.stringify(data);
            if (payload !== self._lastPayload) {   // re-render only on change
              self._lastPayload = payload;
              render(data);
            }
            // first successful load: did we arrive here from a notification?
            if (!self._gotoChecked) {
              self._gotoChecked = true;
              consumePendingGoto();
            }
          })
          // Say WHICH address is unreachable. "The dot is red" sends people looking
          // at Qlik, at the network, at the extension — anywhere but the one setting
          // that is actually wrong.
          .catch(function (err) {
            $conn.addClass("qcol-err").removeClass("qcol-ok")
                 .attr("title", "Cannot reach the backend at " + self._apiUrl +
                                " — is it running? (" + describeFetchError(err) + ")");
          });
      }

      function uploadPending(commentId) {
        var uploads = self._pendingFiles.map(function (f) {
          var fd = new FormData();
          fd.append("file", f.file, f.name);
          return fetch(self._apiUrl + "/api/comments/" + commentId + "/attachments", {
            method: "POST",
            body: fd
          });
        });
        return Promise.all(uploads);
      }

      function send() {
        var author = $author.val().trim();
        var body = $input.val().trim();
        if (!author) { $author.addClass("qcol-invalid"); return; }
        if (!body && !self._pendingFiles.length) return;
        if (!body) body = "🎤"; // voice/file-only message needs a body
        localStorage.setItem("qlikCollab.author", author);
        $author.removeClass("qcol-invalid");
        stopRecording();

        // Only selections with discrete values can be replayed; a range selection
        // carries nothing to store. Say so rather than attaching an empty filter.
        var wantSel = $element.find(".qcol-selcheck").prop("checked");
        var usableSel = self._currentSelections.filter(function (s) {
          return s.values && s.values.length;
        });
        if (wantSel && !usableSel.length && self._currentSelections.length) {
          toast("Qlik reports only a range selection here — it cannot be saved as a filter.");
        }
        var withSel = wantSel && usableSel.length > 0;
        fetch(self._apiUrl + "/api/comments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            appId: self._appId,
            sheetId: self._sheetId,
            // Stored with the comment so the team inbox can name the dashboard
            // instead of printing a GUID. Null is fine — it falls back to the id.
            appName: self._appName,
            sheetName: self._sheetName,
            objectIds: self._attachTargets,
            parentId: self._replyTo,
            author: author,
            authorDirectory: self._authorDirectory,
            body: body,
            selectionState: withSel ? JSON.stringify(usableSel) : null
          })
        }).then(function (r) {
          if (!r.ok) throw new Error(r.status);
          return r.json();
        }).then(function (created) {
          return uploadPending(created.id);
        }).then(function () {
          $input.val("");
          autoGrow();                 // collapse back to one row
          self._replyTo = null;
          self._attachTargets = [];
          self._pendingFiles = [];
          renderChips();
          renderPending();
          $element.find(".qcol-replybar").hide();
          refresh();
        }).catch(function (err) {
          // This used to fail silently: the comment vanished from nowhere the user
          // could see, the text stayed in the box, and the only clue was a small red
          // dot in the header. Nothing is cleared on this path, so the comment, the
          // attachments and the reply target all survive a retry.
          console.error("qlik-collaboration: could not send the comment", err);
          toast("Comment NOT sent — " + describeFetchError(err) + ". Your text is kept, try again.");
        });
      }

      // ---------- events ----------

      $element.on("click", ".qcol-send", function (e) { e.preventDefault(); send(); });
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

      // Etap 6: re-apply the captured selection context.
      // Failures used to be silent — every step now reports what went wrong.

      function selectionItems(s) {
        if (s.raw && s.raw.length) {
          return s.raw.map(function (r) {
            // qNumber is what actually matches a numeric field; qText alone does not
            return (typeof r.number === "number")
              ? { qText: r.text, qNumber: r.number }
              : { qText: r.text };
          });
        }
        // comments written before numbers were captured
        return (s.values || []).map(function (v) { return { qText: v }; });
      }

      // Only pass a state to app.field() when there really is an alternate state.
      // app.field(name, "$") returns a different wrapper whose selectValues takes
      // different arguments — Qlik then iterates the wrong thing and throws
      // "e.forEach is not a function". app.field(name) is the form that works.
      function fieldFor(s) {
        return (s.state && s.state !== "$")
          ? self._app.field(s.field, s.state)
          : self._app.field(s.field);
      }

      // ---------- apply-filters strategies ----------
      // The Capability API is a compatibility layer, and the micro-frontend client
      // used by recent Enterprise releases reimplements it — argument shapes the
      // older Desktop client accepted can throw inside Qlik's own bundle there.
      // So every documented way of making a selection is available here, selectable
      // from the properties panel ("Apply filters method"). "auto" tries them in
      // order and reports which one worked.

      function valueTexts(s) {
        return selectionItems(s).map(function (o) { return o.qText; });
      }
      function valueNumbers(s) {
        var objs = selectionItems(s);
        var nums = [];
        for (var i = 0; i < objs.length; i++) {
          var n = (typeof objs[i].qNumber === "number") ? objs[i].qNumber : Number(objs[i].qText);
          if (!isFinite(n) || objs[i].qText === "") return null;   // not a numeric field
          nums.push(n);
        }
        return nums;
      }
      function enigmaDoc() {
        var doc = self._app.model && self._app.model.enigmaModel;
        if (!doc || typeof doc.getField !== "function") throw new Error("enigma model unavailable");
        return doc;
      }

      var APPLY_METHODS = {
        // 0 - PROVEN on the Enterprise micro-frontend client: plain values, and the
        // state passed explicitly. That client's selectValues iterates the argument
        // directly, so [{qText:...}] objects make it throw "e.forEach is not a
        // function"; ["1186"] is what it accepts.
        "plain-texts-state": function (s) {
          return self._app.field(s.field, s.state || "$")
                          .selectValues(valueTexts(s), false, true);
        },
        // 1 - what worked on Desktop: [{qText}] (+qNumber for numeric values)
        "objects": function (s) {
          return fieldFor(s).selectValues(selectionItems(s), false, true);
        },
        // 2 - same, without soft lock (some builds reject softlock on published apps)
        "objects-nosoftlock": function (s) {
          return fieldFor(s).selectValues(selectionItems(s), false, false);
        },
        // 3 - text only, no qNumber (a wrong qNumber can match nothing)
        "text-objects": function (s) {
          return fieldFor(s).selectValues(
            valueTexts(s).map(function (t) { return { qText: t }; }), false, true);
        },
        // 4 - plain strings instead of objects
        "plain-texts": function (s) {
          return fieldFor(s).selectValues(valueTexts(s), false, true);
        },
        // 5 - plain numbers (numeric fields only)
        "plain-numbers": function (s) {
          var nums = valueNumbers(s);
          if (!nums) throw new Error("values are not numeric");
          return fieldFor(s).selectValues(nums, false, true);
        },
        // 6 - wait for the field model before selecting (fixes "not ready yet")
        "waitfor-objects": function (s) {
          var f = fieldFor(s);
          var ready = f.waitFor && typeof f.waitFor.then === "function"
            ? f.waitFor : { then: function (cb) { return cb(); } };
          return ready.then(function () {
            return f.selectValues(selectionItems(s), false, true);
          });
        },
        // 7 - Engine API directly, bypassing the Capability layer entirely
        "engine-selectvalues": function (s) {
          return enigmaDoc().getField(s.field, s.state || "$").then(function (f) {
            return f.selectValues({
              qFieldValues: selectionItems(s).map(function (o) {
                return (typeof o.qNumber === "number")
                  ? { qText: o.qText, qIsNumeric: true, qNumber: o.qNumber }
                  : { qText: o.qText, qIsNumeric: false, qNumber: 0 };
              }),
              qToggleMode: false,
              qSoftLock: true
            });
          });
        },
        // 8 - Engine API search-match, e.g. ("6/1/2023"|"9/4/2023").
        // This is the one that handles DUAL fields — dates especially. A date is
        // text plus a numeric serial, and selectionState only ever gives us the
        // text, so a value-based select can match nothing. A search matches on the
        // formatted text, which is exactly what we captured.
        "engine-select-match": function (s) {
          var expr = "(" + valueTexts(s).map(function (t) {
            return '"' + String(t).replace(/"/g, '""') + '"';
          }).join("|") + ")";
          return enigmaDoc().getField(s.field, s.state || "$").then(function (f) {
            return f.select(expr, true, 0);
          });
        },
        // 9 - Capability search-match, same idea without the Engine API
        "selectmatch-search": function (s) {
          var expr = "(" + valueTexts(s).map(function (t) {
            return '"' + String(t).replace(/"/g, '""') + '"';
          }).join("|") + ")";
          return fieldFor(s).selectMatch(expr, true);
        },
        // 9 - Capability selectMatch (one value at a time)
        "selectmatch": function (s) {
          var texts = valueTexts(s);
          if (texts.length !== 1) throw new Error("selectMatch handles a single value only");
          return fieldFor(s).selectMatch(texts[0], true);
        }
      };

      // Order used by "auto": the shapes proven to work come first, so the common
      // case succeeds on the first try instead of throwing its way down the list.
      var APPLY_ORDER = [
        "plain-texts-state", "plain-texts", "plain-numbers",
        "objects", "text-objects",
        "waitfor-objects", "objects-nosoftlock",
        "engine-selectvalues",
        // search-based, and the ones that work for dual fields such as dates
        "engine-select-match", "selectmatch-search", "selectmatch"
      ];

      function selectAttempts(s) {
        // read from self, not the captured layout: the setting can change on a re-paint
        var chosen = self._applyMethod || "auto";
        var names = (chosen === "auto") ? APPLY_ORDER : [chosen];
        return names.filter(function (n) { return APPLY_METHODS[n]; })
                    .map(function (n) {
                      return {
                        name: n,
                        // logged before the call, so the console shows exactly what
                        // is being handed to Qlik
                        preview: { field: s.field, state: s.state || "$", values: valueTexts(s) },
                        run: function () { return APPLY_METHODS[n](s); }
                      };
                    });
      }

      // Did this field actually end up selected?
      function fieldHasSelection(fieldName) {
        var now = snapshotSelections();
        for (var i = 0; i < now.length; i++) {
          if (now[i].field === fieldName && now[i].values && now[i].values.length) return true;
        }
        return false;
      }

      function runAttempts(attempts, fieldName, onDone) {
        var i = 0;
        (function next(lastErr) {
          if (i >= attempts.length) { onDone(lastErr || new Error("no method selected anything"), null); return; }
          var a = attempts[i++];

          // Resolving is not the same as selecting. selectValues(["6/1/2023"]) on a
          // date field resolves happily and matches nothing, so check the state
          // afterwards and keep going instead of declaring victory.
          function settled() {
            setTimeout(function () {
              if (fieldHasSelection(fieldName)) {
                console.log("qlik-collaboration: applied via '" + a.name + "'");
                onDone(null, a.name);
              } else {
                console.warn("qlik-collaboration: '" + a.name + "' resolved but selected nothing in '" + fieldName + "' - trying the next method");
                next(new Error("'" + a.name + "' selected nothing"));
              }
            }, 350);
          }

          var r;
          try {
            console.log("qlik-collaboration v" + EXT_VERSION + ": trying '" + a.name + "'", a.preview);
            r = a.run();
          } catch (err) {
            console.warn("qlik-collaboration: method '" + a.name + "' threw", err);
            next(err);
            return;
          }
          if (r && typeof r.then === "function") {
            r.then(settled, function (err) {
              console.warn("qlik-collaboration: method '" + a.name + "' rejected", err);
              next(err);
            });
          } else {
            settled();
          }
        })();
      }

      // Clear current selections, then continue NO MATTER WHAT: rejected, thrown,
      // or never settled. A hanging clearAll is indistinguishable from "the button
      // does nothing", which is exactly how this failed before.
      function clearAllThen(next) {
        var moved = false;
        function go(why) {
          if (moved) return;
          moved = true;
          if (why) console.warn("qlik-collaboration: continuing without a clean clearAll -", why);
          next();
        }
        try {
          var p = self._app.clearAll();
          if (p && typeof p.then === "function") {
            p.then(function () { go(); }, function (err) { go(err || "clearAll rejected"); });
          } else {
            go();
          }
        } catch (err) {
          go(err);
        }
        setTimeout(function () { go("clearAll did not settle within 1.5s"); }, 1500);
      }

      // A method can report success and still select nothing. Read the selection
      // state back and say so, instead of claiming the filters were applied.
      function verifyApplied(sels, used) {
        setTimeout(function () {
          var now = snapshotSelections();
          var missing = sels.filter(function (s) {
            return !now.some(function (n) {
              return n.field === s.field && n.values && n.values.length;
            });
          }).map(function (s) { return s.field; });

          if (missing.length) {
            console.warn("qlik-collaboration: '" + used + "' reported success but nothing was selected in:", missing);
            toast("'" + used + "' selected nothing in " + missing.join(", ") +
                  " - try another Apply filters method in the settings");
          } else {
            toast("Filters applied" + (used ? " (" + used + ")" : ""));
          }
        }, 800);
      }

      function applySelections(sels) {
        var pending = sels.length;
        var failed = [];
        var used = null;

        function step(field, err, method) {
          if (err) {
            console.error("qlik-collaboration: could not select in field '" + field + "'", err);
            failed.push(field);
          } else if (method) {
            used = method;
          }
          if (--pending > 0) return;
          if (failed.length) {
            toast("Could not apply: " + failed.join(", ") + " - see the console, then try another Apply filters method");
          } else {
            verifyApplied(sels, used);
          }
        }

        // Clearing must never block the selection. A clearAll() that rejects -- or
        // never settles, which is silent and looks exactly like "nothing happened" --
        // used to swallow the whole operation because the selects ran in its .then().
        clearAllThen(function () {
          sels.forEach(function (s) {
            if (!s.field || !selectionItems(s).length) { step(s.field); return; }
            runAttempts(selectAttempts(s), s.field, function (err, method) { step(s.field, err, method); });
          });
        }, function (err) {
          console.error("qlik-collaboration: clearAll failed", err);
          toast("Could not clear the current selections.");
        });
      }

      $element.on("click", ".qcol-applysel", function (e) {
        e.preventDefault();
        var sels;
        try {
          sels = JSON.parse($(this).attr("data-sel"));
        } catch (err) {
          console.error("qlik-collaboration: stored selection state is not valid JSON", err);
          toast("Could not read the saved filters.");
          return;
        }
        if (!sels || !sels.length) { toast("This comment has no filters saved."); return; }
        applySelections(sels);
      });

      // ---------- real-time (SignalR) with polling fallback ----------

      function tick() { refresh(); refreshNotifs(); }

      function connectHub() {
        try {
          var conn = new signalR.HubConnectionBuilder()
            .withUrl(self._apiUrl + "/hubs/comments", {
              skipNegotiation: true,
              transport: signalR.HttpTransportType.WebSockets
            })
            .withAutomaticReconnect()
            .build();

          conn.on("commentsChanged", function (d) {
            if (d && d.appId === self._appId && d.sheetId === self._sheetId) refresh();
          });
          conn.on("notify", function (d) {
            var me = ($author.val() || "").trim().toLowerCase();
            if (!d || !me) return;
            // server sends one message listing everyone it notified
            var targets = d.usernames || (d.username ? [d.username] : []);
            for (var i = 0; i < targets.length; i++) {
              if (String(targets[i]).toLowerCase() === me) { refreshNotifs(); return; }
            }
          });

          conn.onreconnected(function () { $conn.addClass("qcol-live"); tick(); });
          conn.onclose(function () { $conn.removeClass("qcol-live"); });

          conn.start().then(function () {
            self._live = true;
            $conn.addClass("qcol-live").attr("title", "Real-time connection active");
            // SignalR delivers changes instantly — polling becomes a 30s safety net
            if (self._timer) clearInterval(self._timer);
            self._timer = setInterval(tick, 30000);
          }).catch(function () { /* no hub — polling stays at the configured rate */ });

          self._connection = conn;
        } catch (err) { /* signalR lib unavailable — polling continues */ }
      }

      // ---------- bubble / expand ----------
      // A Qlik extension cannot resize its own cell — the sheet layout owns that — so
      // "collapse out of the way" cannot mean shrinking in place: a small bubble in a
      // big cell still occupies the whole cell. Collapsed, the panel is only the
      // bubble, so a small cell is enough; expanded, it lifts out with position:fixed
      // and floats over the dashboard.

      var $panel = $element.find(".qcol-panel");

      function bubbleWanted() {
        if (self._displayMode === "docked") return false;
        // Floating over a sheet that is being edited gets in the way of editing it.
        try {
          var mode = qlik.navigation.getMode && qlik.navigation.getMode();
          if (mode && String(mode).toLowerCase().indexOf("edit") !== -1) return false;
        } catch (e) { /* older client — assume analysis */ }
        return true;
      }

      // position:fixed is relative to the viewport only while no ancestor has a
      // transform, filter or contain — any of those silently turn it into "fixed
      // inside that ancestor", which here means trapped in the cell and clipped. Rather
      // than hope, measure once: park a probe at a known viewport spot and see whether
      // it landed there. If not, this client cannot float and we stay docked.
      function canFloat() {
        if (self._canFloat !== undefined) return self._canFloat;
        var probe = document.createElement("div");
        probe.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;" +
                              "opacity:0;pointer-events:none";
        $panel[0].appendChild(probe);
        var r = probe.getBoundingClientRect();
        probe.parentNode.removeChild(probe);
        self._canFloat = Math.abs(r.top) < 2 && Math.abs(r.left) < 2;
        if (!self._canFloat) {
          console.warn("qlik-collaboration: this client anchors position:fixed to the " +
                       "cell, so the panel cannot float — staying docked.");
        }
        return self._canFloat;
      }

      function applyDisplayMode() {
        var bubble = bubbleWanted() && canFloat();
        $panel.toggleClass("qcol-bubbly", bubble);
        if (!bubble) {
          $panel.removeClass("qcol-expanded");
          return;
        }
        $panel.toggleClass("qcol-expanded", !!self._expanded);
      }
      self._applyDisplayMode = applyDisplayMode;

      function setExpanded(open) {
        self._expanded = open;
        try { localStorage.setItem("qlikCollab.expanded", open ? "1" : "0"); } catch (e) { /* noop */ }
        applyDisplayMode();
        if (open) {
          if (self._applySize) self._applySize();
          // the list only auto-sticks to the bottom while it has a height to measure
          $list.scrollTop($list[0] ? $list[0].scrollHeight : 0);
          $input.focus();
        }
      }

      // Reopen the way it was left. Default collapsed: the point of the exercise is
      // that the dashboard is not covered until someone asks for the discussion.
      try { self._expanded = localStorage.getItem("qlikCollab.expanded") === "1"; }
      catch (e) { self._expanded = false; }

      $element.on("click", ".qcol-bubble", function (e) {
        e.preventDefault();
        setExpanded(true);
      });
      $element.on("click", ".qcol-collapse", function (e) {
        e.preventDefault();
        setExpanded(false);
      });
      // Esc closes it, the way every overlay on the web does.
      $element.on("keydown", function (e) {
        if (e.key === "Escape" && self._expanded && !self._picking) setExpanded(false);
      });

      applyDisplayMode();

      // ---------- size adaptation ----------
      // A Qlik object is resized by dragging its cell, so the viewport never changes
      // and media queries never fire for it. Watch the element itself instead, and
      // give way on chrome rather than on type size — the complaint that started this
      // was "hard to see", so shrinking the text would have made it worse.

      function applySize() {
        // Measure the panel, not the cell: once floating they are different boxes,
        // and while docked the panel fills the cell so the two agree anyway.
        var w = $panel.width() || 0;
        var h = $panel.height() || 0;
        var narrow = w > 0 && w < 280;
        var short = h > 0 && h < 340;
        var sig = (narrow ? "n" : "") + (short ? "s" : "");
        // Writing to the DOM from inside a resize callback can feed itself; only
        // touch it when the bucket actually changed.
        if (sig === self._sizeSig) return;
        self._sizeSig = sig;
        $panel
          .toggleClass("qcol-narrow", narrow)
          .toggleClass("qcol-short", short);
        autoGrow();                 // the composer's max height differs per bucket
      }
      self._applySize = applySize;

      if (typeof ResizeObserver === "function") {
        try {
          self._resizeObserver = new ResizeObserver(applySize);
          self._resizeObserver.observe($element[0]);
        } catch (e) { /* older client — Qlik's own repaint-on-resize covers it */ }
      }
      applySize();

      // ---------- start ----------
      self._tick = tick;          // re-paints reuse these when settings change
      self._pollMs = pollMs;
      tick();
      if (self._timer) clearInterval(self._timer);
      self._timer = setInterval(tick, pollMs);
      connectHub();

      return qlik.Promise.resolve();
    },

    beforeDestroy: function () {
      if (this._timer) clearInterval(this._timer);
      if (this._selTimer) clearInterval(this._selTimer);
      if (this._resizeObserver) {
        try { this._resizeObserver.disconnect(); } catch (e) { /* noop */ }
      }
      if (this._stopPicking) this._stopPicking();
      if (this._stopRecording) this._stopRecording();
      if (this._connection) {
        try { this._connection.stop(); } catch (e) { /* noop */ }
      }
      if (this._selState && this._selState.OnData) {
        try { this._selState.OnData.unbind(); } catch (e) { /* noop */ }
      }
    }
  };
});
