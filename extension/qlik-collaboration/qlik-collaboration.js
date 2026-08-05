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
 * Etap 2: @mentions with autocomplete + notification bell.
 * Etap 3: file attachments; voice messages are audio attachments (MediaRecorder).
 */
define(["qlik", "jquery", "./signalr.min", "css!./qlik-collaboration.css"], function (qlik, $, signalR) {
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
      self._attachTargets = [];
      self._pendingFiles = [];
      self._users = [];
      self._notifs = [];
      self._live = false;

      var sheetInfo = qlik.navigation.getCurrentSheetId();
      self._sheetId = sheetInfo.success ? sheetInfo.sheetId : "unknown-sheet";
      self._appId = app.id;

      // ---------- static skeleton ----------
      $element.html(
        '<div class="qcol-panel">' +
        '  <div class="qcol-header">' +
        '    <span class="qcol-title">Comments <span class="qcol-count"></span></span>' +
        '    <span class="qcol-headright">' +
        '      <span class="qcol-bell" title="Notifications">🔔<span class="qcol-badge" style="display:none"></span></span>' +
        '      <span class="qcol-conn" title="Backend connection">●</span>' +
        '    </span>' +
        '  </div>' +
        '  <div class="qcol-notifs" style="display:none">' +
        '    <div class="qcol-notifs-head">Notifications <a href="#" class="qcol-markread">mark all read</a></div>' +
        '    <div class="qcol-notifs-list"></div>' +
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
        '    <div class="qcol-mentionbox" style="display:none"></div>' +
        '    <textarea class="qcol-input" placeholder="Write a comment… use @name to mention" rows="2"></textarea>' +
        '    <div class="qcol-pending"></div>' +
        '    <div class="qcol-toolbar">' +
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
      self._cellsById = {};

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

      // ---------- users & @mentions (Etap 2) ----------

      function refreshUsers() {
        fetch(self._apiUrl + "/api/users")
          .then(function (r) { return r.json(); })
          .then(function (list) { self._users = list || []; })
          .catch(function () {});
      }

      function highlightMentions(escapedBody) {
        var out = escapedBody;
        self._users.slice().sort(function (a, b) { return b.length - a.length; }).forEach(function (u) {
          var pattern = ("@" + esc(u)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          out = out.replace(new RegExp(pattern, "gi"), function (m) {
            return '<span class="qcol-mention">' + m + "</span>";
          });
        });
        return out;
      }

      function updateMentionBox() {
        var ta = $input[0];
        var uptoCaret = ta.value.substring(0, ta.selectionStart);
        var m = uptoCaret.match(/@([^\s@]*)$/);
        var $box = $element.find(".qcol-mentionbox");
        if (!m) { $box.hide(); return; }
        var frag = m[1].toLowerCase();
        var me = ($author.val() || "").trim().toLowerCase();
        var matches = self._users.filter(function (u) {
          return u.toLowerCase().indexOf(frag) === 0 && u.toLowerCase() !== me;
        }).slice(0, 6);
        if (!matches.length) { $box.hide(); return; }
        $box.html(matches.map(function (u) {
          return '<a href="#" class="qcol-mentionopt" data-u="' + esc(u) + '">@' + esc(u) + "</a>";
        }).join("")).show();
      }

      $element.on("input", ".qcol-input", updateMentionBox);
      $element.on("click", ".qcol-mentionopt", function (e) {
        e.preventDefault();
        var u = $(this).data("u");
        var ta = $input[0];
        var uptoCaret = ta.value.substring(0, ta.selectionStart);
        var rest = ta.value.substring(ta.selectionStart);
        var newUpto = uptoCaret.replace(/@([^\s@]*)$/, "@" + u + " ");
        $input.val(newUpto + rest);
        $element.find(".qcol-mentionbox").hide();
        ta.focus();
        ta.selectionStart = ta.selectionEnd = newUpto.length;
      });

      // ---------- notifications (Etap 2) ----------

      function refreshNotifs() {
        var me = $author.val().trim();
        if (!me) return;
        fetch(self._apiUrl + "/api/notifications?user=" + encodeURIComponent(me))
          .then(function (r) { return r.json(); })
          .then(function (list) {
            self._notifs = list || [];
            var unread = self._notifs.filter(function (n) { return !n.isRead; }).length;
            var $badge = $element.find(".qcol-badge");
            if (unread > 0) $badge.text(unread).show(); else $badge.hide();
            var KIND_ICON = { mention: "@", reply: "↩", status_change: "✎" };
            $element.find(".qcol-notifs-list").html(
              self._notifs.length
                ? self._notifs.map(function (n) {
                    return '<div class="qcol-notif' + (n.isRead ? "" : " qcol-notif-unread") + '">' +
                           '<span class="qcol-notif-kind">' + (KIND_ICON[n.kind] || "•") + "</span>" +
                           "<b>" + esc(n.fromAuthor) + "</b> " + esc(n.excerpt) +
                           '<span class="qcol-notif-time">' + fmtTime(n.createdAt) + "</span></div>";
                  }).join("")
                : '<div class="qcol-empty">No notifications</div>'
            );
          })
          .catch(function () {});
      }

      $element.on("click", ".qcol-bell", function () {
        $element.find(".qcol-notifs").toggle();
        refreshNotifs();
      });

      $element.on("click", ".qcol-markread", function (e) {
        e.preventDefault();
        var me = $author.val().trim();
        if (!me) return;
        fetch(self._apiUrl + "/api/notifications/read?user=" + encodeURIComponent(me), { method: "PUT" })
          .then(refreshNotifs);
      });

      $element.on("change", ".qcol-author", refreshNotifs);

      // ---------- attachments & voice (Etap 3) ----------

      function renderPending() {
        var $box = $element.find(".qcol-pending");
        if (!self._pendingFiles.length) { $box.empty(); return; }
        $box.html(self._pendingFiles.map(function (f, i) {
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

      function startRecording() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === "undefined") {
          $element.find(".qcol-voice").prop("disabled", true).attr("title", "Microphone not available in this browser");
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
        }).catch(function () {
          $element.find(".qcol-voice").attr("title", "Microphone access denied");
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
          h += '<div class="qcol-body">' + highlightMentions(esc(c.body)) + "</div>";
          h += renderAttachments(c);
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
          if (!r.ok) throw new Error(r.status);
          return r.json();
        }).then(function (created) {
          return uploadPending(created.id);
        }).then(function () {
          $input.val("");
          self._replyTo = null;
          self._attachTargets = [];
          self._pendingFiles = [];
          renderChips();
          renderPending();
          $element.find(".qcol-replybar").hide();
          refreshUsers();
          refresh();
        }).catch(function () { /* connection dot already reflects errors */ });
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
            var me = $author.val().trim();
            if (d && me && d.username && d.username.toLowerCase() === me.toLowerCase()) refreshNotifs();
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

      // ---------- start ----------
      refreshUsers();
      tick();
      if (self._timer) clearInterval(self._timer);
      self._timer = setInterval(tick, pollMs);
      connectHub();

      return qlik.Promise.resolve();
    },

    beforeDestroy: function () {
      if (this._timer) clearInterval(this._timer);
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
