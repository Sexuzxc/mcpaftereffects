// ============================================================================
// ae_bridge.jsx - resident ExtendScript bridge for the After Effects MCP server
// https://github.com/  (AE MCP Bridge, v1.0.0, bridge protocol version 1)
//
// WHAT IT IS
//   A single ES3 script that lives inside one After Effects instance for the
//   whole session. It polls a "mailbox" folder every TICK_MS through
//   app.scheduleTask, consumes request-*.json files written by the MCP server
//   (Python or TypeScript - both speak the same protocol), executes the named
//   tool against app.project, and writes back response-<id>.json with a
//   correlated, JSON-safe result.
//
//   Mailbox layout (override the root with the AE_MCP_RUNTIME_DIR env var):
//     <root>/heartbeat.json          written every HEARTBEAT_MS + on state change
//     <root>/bridge.log              capped rolling log
//     <root>/commands/request-*.json consumed on read (deleted before running)
//     <root>/results/response-<id>.json   one per request
//
//   <root> defaults to Folder.temp + "/ae-mcp-bridge". The server computes the
//   same default from os.tmpdir(), so both sides agree; AE_MCP_RUNTIME_DIR is
//   read via $.getenv and must be set on BOTH sides when used.
//
// SAFETY
//   - Every mutating request runs inside one undo group; every request runs
//     with modal dialogs suppressed (both can be disabled per request).
//   - Requests are consumed BEFORE execution: a crash never re-runs a command.
//   - Whoever can write into the mailbox executes ExtendScript inside this AE.
//     The folder sits under the per-user temp dir - that is the trust boundary.
//
// KEEP THIS FILE ES3: var only, no arrow functions, no let/const, no template
// literals, no Array.prototype.map/filter/forEach, no Date.toISOString.
//
// INSTALL: copy into  %APPDATA%\Adobe\After Effects <version>\Scripts\Startup\
// so every AE launch starts it, or run once via File > Scripts > Run Script
// File, or let the MCP server push it with:  AfterFX.exe -r ae_bridge.jsx
// ============================================================================

// ---------------------------------------------------------------------------
// json2.jsx (minimal JSON polyfill, ES3-safe) - AE ships ExtendScript with a
// JSON object in recent versions, but be robust on older builds.
// ---------------------------------------------------------------------------
if (typeof JSON === "undefined") {
    JSON = {};
}
if (typeof JSON.stringify !== "function") {
    JSON.stringify = function (value) {
        var t = typeof value;
        if (value === null || t === "undefined") return "null";
        if (t === "number") return isFinite(value) ? String(value) : "null";
        if (t === "boolean") return value ? "true" : "false";
        if (t === "string") return JSON._esc(value);
        if (t === "object") {
            if (value instanceof Array) {
                var arr = [];
                for (var i = 0; i < value.length; i++) {
                    arr.push(JSON.stringify(value[i]));
                }
                return "[" + arr.join(",") + "]";
            }
            var parts = [];
            for (var k in value) {
                if (value.hasOwnProperty(k) && typeof value[k] !== "function" && typeof value[k] !== "undefined") {
                    parts.push(JSON._esc(String(k)) + ":" + JSON.stringify(value[k]));
                }
            }
            return "{" + parts.join(",") + "}";
        }
        return "null";
    };
    JSON._esc = function (s) {
        return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
            .replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
    };
}
if (typeof JSON.parse !== "function") {
    JSON.parse = function (text) {
        return eval("(" + String(text) + ")"); // mailbox content only - trusted writer is the local server
    };
}

// ---------------------------------------------------------------------------
// AeBridge core
// ---------------------------------------------------------------------------
(function () {
    if ($.global.AE_MCP_BRIDGE) {
        return; // one bridge per AE process - never install a second poller
    }

    var BRIDGE_VERSION = 1;
    var TICK_MS = 250;
    var HEARTBEAT_MS = 1000;
    var LOG_MAX_CHARS = 128 * 1024;
    var RESULT_MAX_CHARS = 8 * 1024 * 1024; // truncate huge results with a flag

    // ---- small ES3 utilities ------------------------------------------------

    function normalizePath(p) {
        return String(p).replace(/\\/g, "/");
    }

    function toWindowsPath(p) {
        return String(p).replace(/\//g, "\\");
    }

    function ensureDir(dir) {
        var parts = normalizePath(dir).split("/");
        var cur = "";
        for (var i = 0; i < parts.length; i++) {
            if (parts[i].length === 0 && i > 0) continue;
            cur = (i === 0) ? parts[i] : cur + "/" + parts[i];
            if (cur.length === 0 || /^[A-Za-z]:$/.test(cur)) continue;
            var f = new Folder(cur);
            if (!f.exists) f.create();
        }
        return new Folder(dir).exists;
    }

    function writeAtomic(path, text) {
        var dest = new File(path);
        var tmp = new File(path + ".tmp");
        tmp.encoding = "UTF-8";
        if (!tmp.open("w")) return false;
        tmp.write(text);
        tmp.close();
        if (dest.exists) {
            try { dest.remove(); } catch (eRm) { /* best effort */ }
        }
        return tmp.rename(dest.name);
    }

    function pad2(n) { return (n < 10 ? "0" : "") + n; }

    function isoNow() {
        var d = new Date();
        return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
            "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()) +
            "." + ("00" + d.getMilliseconds()).slice(-3);
    }

    function describeError(e) {
        try {
            if (e === null || e === undefined) return "unknown error";
            if (typeof e === "string") return e;
            var msg = (e.message === undefined || e.message === null) ? "" : String(e.message);
            if (msg.length === 0) msg = "error";
            if (e.line !== undefined && e.line !== null && e.line > 0) msg += " (line " + String(e.line) + ")";
            return msg;
        } catch (eFmt) {
            return "unformattable error";
        }
    }

    function appendLog(msg) {
        try {
            var f = new File(state.runtimeDir + "/bridge.log");
            f.encoding = "UTF-8";
            if (f.open("a")) {
                f.writeln("[" + isoNow() + "] " + String(msg));
                f.close();
            }
            if (f.length > LOG_MAX_CHARS) {
                // rolling cap: keep the file bounded, drop old content
                var r = new File(state.runtimeDir + "/bridge.log");
                if (r.open("r")) {
                    var tail = r.read();
                    r.close();
                    var cut = tail.length - LOG_MAX_CHARS / 2;
                    if (cut > 0) tail = tail.substring(cut);
                    var w = new File(state.runtimeDir + "/bridge.log");
                    if (w.open("w")) { w.write(tail); w.close(); }
                }
            }
        } catch (eLog) { /* never let logging kill the tick */ }
    }

    // ---- state ----------------------------------------------------------------

    function runtimeDir() {
        try {
            var injected = $.getenv("AE_MCP_RUNTIME_DIR");
            if (injected && String(injected).length > 0) {
                return normalizePath(String(injected));
            }
        } catch (eEnv) { /* env access blocked - fall through */ }
        return normalizePath(Folder.temp.fsName) + "/ae-mcp-bridge";
    }

    var state = {
        runtimeDir: runtimeDir(),
        id: "bridge-" + Math.floor(Math.random() * 900000 + 100000),
        version: BRIDGE_VERSION,
        startedAt: new Date().getTime(),
        ticks: 0,
        served: 0,
        busy: false,
        busySince: null,
        lastError: null,
        lastHeartbeatAt: 0,
        taskId: null,
        dirsReady: false
    };

    function securityPrefOn() {
        try {
            var v = app.preferences.getPrefAsLong("Pref_Scripting", "Pref_SCRIPTING_FILE_NETWORK_SECURITY");
            return Number(v) === 1;
        } catch (ePref) {
            return null; // unknown
        }
    }

    function projectInfo() {
        var info = { project: null, project_name: null, dirty: false, num_items: 0 };
        try {
            var p = app.project;
            if (p) {
                info.dirty = !!p.dirty;
                info.num_items = p.numItems;
                if (p.file) {
                    info.project = normalizePath(p.file.fsName);
                    info.project_name = String(p.file.displayName);
                }
            }
        } catch (eProj) { /* unreadable - report what we have */ }
        return info;
    }

    function dirsReady() {
        if (state.dirsReady) return true;
        var ok = ensureDir(state.runtimeDir + "/commands") && ensureDir(state.runtimeDir + "/results");
        state.dirsReady = ok;
        return ok;
    }

    function heartbeat(force) {
        var now = new Date().getTime();
        if (!force && now - state.lastHeartbeatAt < HEARTBEAT_MS) return;
        if (!dirsReady()) return;
        var info = projectInfo();
        var hb = {
            kind: "ae_mcp_bridge_heartbeat",
            id: state.id,
            version: state.version,
            ae_version: String(app.version),
            ae_build: String(app.buildName),
            project: info.project,
            project_name: info.project_name,
            dirty: info.dirty,
            num_items: info.num_items,
            started_at: state.startedAt,
            uptime_s: Math.round((now - state.startedAt) / 1000),
            ticks: state.ticks,
            served: state.served,
            busy: state.busy,
            busy_since: state.busySince,
            last_error: state.lastError,
            security_pref: securityPrefOn(),
            runtime_dir: state.runtimeDir,
            ts: now,
            iso: isoNow()
        };
        writeAtomic(state.runtimeDir + "/heartbeat.json", JSON.stringify(hb));
        state.lastHeartbeatAt = now;
    }

    // ---- request queue ------------------------------------------------------

    function oldestRequest() {
        var folder = new Folder(state.runtimeDir + "/commands");
        if (!folder.exists) return null;
        var files = folder.getFiles("request-*.json");
        if (!files || files.length === 0) return null;
        files.sort(function (a, b) { return String(a.name) < String(b.name) ? -1 : 1; });
        return files[0];
    }

    function consumeRequest(file) {
        // Returns {id, tool, args, undoGroup, suppressDialogs} or {id, parseError}
        var entry = { id: null };
        var name = String(file.name);
        // The id lives in the filename: request-<ts>-<id>.json - a corrupt body
        // still gets a correlated response.
        var m = name.match(/^request-([0-9]+)-(.+)\.json$/);
        if (m) entry.id = m[2];
        else entry.id = name.replace(/^request-/, "").replace(/\.json$/, "");

        var text = "";
        try {
            file.encoding = "UTF-8";
            if (file.open("r")) {
                text = file.read();
                file.close();
            }
        } catch (eRead) {
            entry.parseError = "cannot read request: " + describeError(eRead);
        }
        try { file.remove(); } catch (eDel) { /* may already be gone */ }

        if (!entry.parseError) {
            try {
                var body = JSON.parse(text);
                entry.tool = body.tool;
                entry.args = body.args || {};
                if (body.undo_group === false) entry.undoGroup = false;
                if (body.suppress_dialogs === false) entry.suppressDialogs = false;
                entry.ts = body.ts || null;
            } catch (eParse) {
                entry.parseError = "cannot parse request body: " + describeError(eParse);
            }
        }
        return entry;
    }

    function writeResponse(id, obj) {
        obj.id = id;
        obj.response_iso = isoNow();
        var text = JSON.stringify(obj);
        if (text.length > RESULT_MAX_CHARS) {
            obj.result = null;
            obj.truncated = true;
            obj.error = {
                code: "RESULT_TOO_LARGE",
                message: "Result was " + text.length + " chars; limit is " + RESULT_MAX_CHARS +
                    ". Narrow the query (use limit/depth/paths) instead."
            };
            text = JSON.stringify(obj);
        }
        var path = state.runtimeDir + "/results/response-" + id + ".json";
        if (!writeAtomic(path, text)) {
            appendLog("FATAL: cannot write response " + path);
        }
        return path;
    }

    // ---- dispatch --------------------------------------------------------------

    function serveRequest(entry) {
        var started = new Date().getTime();
        var resp = { ok: false, tool: entry.tool || null };
        var handler = null;

        if (entry.parseError) {
            resp.error = { code: "BAD_REQUEST", message: entry.parseError };
        } else if (typeof entry.tool !== "string" || !$.global.AE_MCP_TOOLS[entry.tool]) {
            var known = [];
            for (var k in $.global.AE_MCP_TOOLS) {
                if ($.global.AE_MCP_TOOLS.hasOwnProperty(k)) known.push(k);
            }
            known.sort();
            resp.error = {
                code: "UNKNOWN_TOOL",
                message: "No bridge tool named '" + entry.tool + "'",
                available_tools: known
            };
        } else {
            handler = $.global.AE_MCP_TOOLS[entry.tool];
        }

        if (handler) {
            var undoName = "AE MCP: " + entry.tool;
            var usedUndo = entry.undoGroup !== false;
            var suppressed = entry.suppressDialogs !== false;
            if (usedUndo) { try { app.beginUndoGroup(undoName); } catch (eU) { } }
            if (suppressed) { try { app.beginSuppressDialogs(); } catch (eS) { } }
            try {
                resp.result = handler(entry.args || {});
                resp.ok = true;
            } catch (eTool) {
                resp.error = { code: "TOOL_ERROR", message: describeError(eTool), tool: entry.tool };
            } finally {
                if (suppressed) { try { app.endSuppressDialogs(false); } catch (eS2) { } }
                if (usedUndo) { try { app.endUndoGroup(); } catch (eU2) { } }
            }
        }

        resp.meta = {
            ae_version: String(app.version),
            duration_ms: new Date().getTime() - started,
            served: state.served + 1
        };
        writeResponse(entry.id, resp);
        state.served++;
        appendLog("served " + (entry.tool || "?") + " [" + entry.id + "] ok=" + resp.ok +
            " " + resp.meta.duration_ms + "ms" + (resp.error ? " err=" + resp.error.code : ""));
    }

    // ---- main loop ------------------------------------------------------------

    function tick() {
        try {
            state.ticks++;
            if (!dirsReady()) return;
            heartbeat(false);

            var reqFile = oldestRequest();
            if (reqFile === null) return;

            state.busy = true;
            state.busySince = new Date().getTime();
            heartbeat(true);
            try {
                var entry = consumeRequest(reqFile);
                serveRequest(entry);
            } finally {
                state.busy = false;
                state.busySince = null;
                heartbeat(true);
            }
        } catch (eTick) {
            state.lastError = describeError(eTick);
            appendLog("tick failed: " + state.lastError);
        }
    }

    // ---- export ---------------------------------------------------------------

    $.global.AE_MCP_BRIDGE = {
        state: state,
        tick: tick,
        stop: function () {
            try { if (state.taskId !== null) app.cancelTask(state.taskId); } catch (e) { }
            state.taskId = null;
        },
        log: appendLog
    };

    // Tool registry (populated by the AeTools parts below) + shared helpers.
    $.global.AE_MCP_TOOLS = $.global.AE_MCP_TOOLS || {};
    $.global.AE_MCP_HELPERS = null; // assigned right after this block

    // Run one tick immediately so the heartbeat exists before the first
    // scheduled tick, then keep polling for the life of the process.
    tick();
    state.taskId = app.scheduleTask("$.global.AE_MCP_BRIDGE.tick()", TICK_MS, true);
    appendLog("bridge " + BRIDGE_VERSION + " started, runtime=" + state.runtimeDir + ", ae=" + app.version);
})();

// ---------------------------------------------------------------------------
// Shared helpers for tool implementations. Everything below registers plain
// functions on $.global.AE_MCP_HELPERS and tool functions on $.global.AE_MCP_TOOLS.
// ---------------------------------------------------------------------------
(function () {
    if (!$.global.AE_MCP_TOOLS) return;

    var H = {};

    H.norm = function (p) { return String(p).replace(/\//g, "\\"); };
    H.fwd = function (p) { return String(p).replace(/\\/g, "/"); };
    H.iso = function () {
        var d = new Date();
        function p2(n) { return (n < 10 ? "0" : "") + n; }
        return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + "T" +
            p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds());
    };
    H.err = function (msg, code) {
        var e = new Error(msg);
        e.aeCode = code || "TOOL_ERROR";
        return e;
    };
    H.num = function (v, dflt) {
        var n = Number(v);
        return isNaN(n) ? dflt : n;
    };
    H.str = function (v, dflt) {
        if (v === null || v === undefined) return dflt;
        return String(v);
    };
    H.bool = function (v, dflt) {
        if (v === null || v === undefined) return !!dflt;
        if (typeof v === "boolean") return v;
        if (v === "true" || v === 1 || v === "1") return true;
        if (v === "false" || v === 0 || v === "0") return false;
        return !!dflt;
    };
    H.numArr = function (v, dflt) {
        if (v === null || v === undefined) return dflt || null;
        if (v instanceof Array) {
            var out = [];
            for (var i = 0; i < v.length; i++) out.push(Number(v[i]));
            return out;
        }
        return [Number(v)];
    };
    // RGB 0-255 or 0-1 floats -> normalized 0-1 triple
    H.color = function (v, dflt) {
        var arr = H.numArr(v, dflt || [0, 0, 0]);
        var big = false;
        for (var i = 0; i < arr.length && i < 3; i++) { if (arr[i] > 1.0001) big = true; }
        var out = [];
        for (var j = 0; j < 3; j++) {
            var x = Number(arr[j]);
            if (isNaN(x)) x = 0;
            if (big) x = x / 255;
            if (x < 0) x = 0; if (x > 1) x = 1;
            out.push(x);
        }
        return out;
    };
    H.requireProject = function () {
        if (!app.project) throw H.err("No project is open in After Effects. Open or create a project first.", "NO_PROJECT");
        return app.project;
    };
    H.itemByIdOrName = function (v) {
        var p = H.requireProject();
        if (typeof v === "number" || (typeof v === "string" && /^[0-9]+$/.test(v))) {
            var id = Number(v);
            for (var i = 1; i <= p.numItems; i++) {
                if (p.item(i).id === id) return p.item(i);
            }
            throw H.err("No project item with id " + id, "NOT_FOUND");
        }
        var name = String(v);
        for (var j = 1; j <= p.numItems; j++) {
            if (String(p.item(j).name) === name) return p.item(j);
        }
        throw H.err("No project item named '" + name + "'", "NOT_FOUND");
    };
    H.folderByIdOrName = function (v, dflt) {
        var p = H.requireProject();
        if (v === null || v === undefined || v === "" ) return p.rootFolder;
        if (v === "root") return p.rootFolder;
        var it = H.itemByIdOrName(v);
        if (!(it instanceof FolderItem)) throw H.err("Item '" + v + "' is not a folder", "NOT_A_FOLDER");
        return it;
    };
    H.compDefault = function (v) {
        var p = H.requireProject();
        if (v === null || v === undefined || v === "") {
            var active = null;
            try { active = p.activeItem; } catch (eA) { }
            if (active && active instanceof CompItem) return active;
            // fall back to the single comp if there is exactly one
            var found = [];
            for (var i = 1; i <= p.numItems; i++) {
                if (p.item(i) instanceof CompItem) found.push(p.item(i));
            }
            if (found.length === 1) return found[0];
            throw H.err("No active composition - open a comp or pass 'comp' (id or name)", "NO_ACTIVE_COMP");
        }
        var it = H.itemByIdOrName(v);
        if (!(it instanceof CompItem)) throw H.err("Item '" + v + "' is not a composition", "NOT_A_COMP");
        return it;
    };
    H.layerDefault = function (comp, v) {
        if (v === null || v === undefined || v === "") {
            var sel = null;
            try { if (comp.selectedLayers && comp.selectedLayers.length > 0) sel = comp.selectedLayers[0]; } catch (eS) { }
            if (!sel) throw H.err("No layer given and no layer is selected in '" + comp.name + "'", "NO_LAYER");
            return sel;
        }
        return H.layerBySel(comp, v);
    };
    H.layerBySel = function (comp, v) {
        if (typeof v === "number" || (typeof v === "string" && /^[0-9]+$/.test(v))) {
            var idx = Number(v);
            if (idx < 1 || idx > comp.numLayers) {
                throw H.err("Layer index " + idx + " out of range 1.." + comp.numLayers + " in '" + comp.name + "'", "OUT_OF_RANGE");
            }
            return comp.layer(idx);
        }
        var name = String(v);
        for (var i = 1; i <= comp.numLayers; i++) {
            if (String(comp.layer(i).name) === name) return comp.layer(i);
        }
        throw H.err("No layer named '" + name + "' in '" + comp.name + "' (" + comp.numLayers + " layers)", "NOT_FOUND");
    };
    H.layerIndices = function (comp, list) {
        // list: array of name-or-index -> array of 1-based indices (unique)
        if (!(list instanceof Array)) list = [list];
        var idxs = {};
        for (var i = 0; i < list.length; i++) {
            var L = H.layerBySel(comp, list[i]);
            var idx = 1;
            while (idx <= comp.numLayers && comp.layer(idx) !== L) idx++;
            idxs[idx] = true;
        }
        var out = [];
        for (var k in idxs) { if (idxs.hasOwnProperty(k)) out.push(Number(k)); }
        out.sort(function (a, b) { return a - b; });
        return out;
    };
    H.timeArg = function (comp, a) {
        var t = a.time_s !== undefined ? Number(a.time_s) : comp.time;
        if (isNaN(t)) t = comp.time;
        return t;
    };
    H.frameDur = function (comp) { return 1.0 / comp.frameRate; };

    // ---- property path resolution --------------------------------------------
    var PATH_ALIASES = {
        "transform": "ADBE Transform Group",
        "position": "ADBE Position",
        "anchor point": "ADBE Anchor Point",
        "scale": "ADBE Scale",
        "rotation": "ADBE Rotate Z",
        "z rotation": "ADBE Rotate Z",
        "x rotation": "ADBE Rotate X",
        "y rotation": "ADBE Rotate Y",
        "orientation": "ADBE Orientation",
        "opacity": "ADBE Opacity",
        "effects": "ADBE Effect Parade",
        "masks": "ADBE Mask Parade",
        "source text": "ADBE Text Document",
        "text": "ADBE Text Document",
        "marker": "ADBE Marker",
        "time remap": "ADBE Time Remapping",
        "point of interest": "ADBE Point of Interest",
        "material options": "ADBE Material Options Group",
        "audio levels": "ADBE Audio Levels",
        "root vectors group": "ADBE Root Vectors Group",
        "transform group": "ADBE Vector Transform Group"
    };

    H.matchSeg = function (group, seg) {
        if (!group || group.numProperties === undefined) throw H.err("Property path segment '" + seg + "': parent is not a group", "BAD_PATH");
        var alias = PATH_ALIASES[String(seg).toLowerCase()];
        // 1. exact matchName
        try {
            var byM = group.property(alias || seg);
            if (byM) return byM;
        } catch (e1) { /* keep trying */ }
        // 2. case-insensitive matchName or display name scan
        var lower = String(seg).toLowerCase();
        var lowerAlias = alias ? String(alias).toLowerCase() : null;
        for (var i = 1; i <= group.numProperties; i++) {
            var p = group.property(i);
            var mn = String(p.matchName).toLowerCase();
            var dn = String(p.name).toLowerCase();
            if (mn === lower || dn === lower || (lowerAlias && mn === lowerAlias)) return p;
        }
        // 3. unique display-name substring match
        var hits = [];
        for (var k = 1; k <= group.numProperties; k++) {
            var q = group.property(k);
            if (String(q.name).toLowerCase().indexOf(lower) >= 0) hits.push(q);
        }
        if (hits.length === 1) return hits[0];
        var names = [];
        for (var m = 1; m <= group.numProperties; m++) names.push(group.property(m).name);
        throw H.err("Cannot resolve property segment '" + seg + "'. Available: " + names.join(", "), "BAD_PATH");
    };

    H.propByPath = function (layer, path) {
        var segs = String(path).split(".");
        var cur = layer;
        for (var i = 0; i < segs.length; i++) {
            cur = H.matchSeg(cur, segs[i]);
        }
        return cur;
    };

    // ---- value serialization ---------------------------------------------------
    H.serializeValue = function (prop, atTime) {
        try {
            var vt = prop.propertyValueType;
            if (vt === PropertyValueType.TEXT_DOCUMENT) {
                var td = prop.value;
                return H.serializeTextDoc(td);
            }
            var v = (atTime !== undefined && atTime !== null) ? prop.valueAtTime(atTime, false) : prop.value;
            if (vt === PropertyValueType.COLOR || vt === PropertyValueType.TwoD_SPATIAL ||
                vt === PropertyValueType.TwoD || vt === PropertyValueType.ThreeD_SPATIAL ||
                vt === PropertyValueType.ThreeD) {
                return H.numArr(v, []);
            }
            if (vt === PropertyValueType.OneD) return Number(v);
            if (vt === PropertyValueType.CUSTOM_VALUE || vt === PropertyValueType.NO_VALUE) return null;
            if (vt === PropertyValueType.BooleanValue) return !!v;
            if (typeof v === "number") return v;
            if (v instanceof Array) return H.numArr(v, []);
            return String(v);
        } catch (eSer) {
            return null;
        }
    };

    H.serializeTextDoc = function (td) {
        var o = { text: "" };
        try { o.text = String(td.text); } catch (e1) { }
        try { o.font = String(td.font); } catch (e2) { }
        try { o.font_size = Number(td.fontSize); } catch (e3) { }
        try { o.fill_color = H.color(td.fillColor); o.apply_fill = !!td.applyFill; } catch (e4) { }
        try { o.stroke_color = H.color(td.strokeColor); o.apply_stroke = !!td.applyStroke; o.stroke_width = Number(td.strokeWidth); } catch (e5) { }
        try { o.tracking = Number(td.tracking); } catch (e6) { }
        try { o.leading = Number(td.leading); } catch (e7) { }
        try { o.justification = String(td.justification); } catch (e8) { }
        try { o.box_text = !!td.boxText; if (td.boxText) o.box_text_size = H.numArr(td.boxTextSize, []); } catch (e9) { }
        try { o.baseline_shift = Number(td.baselineLocShift); } catch (e10) { }
        return o;
    };

    H.propSummary = function (prop) {
        var o = {
            name: String(prop.name),
            match_name: String(prop.matchName),
            type: null, dimension: null, value: null,
            num_keys: 0, animated: false, expression: null
        };
        try { o.type = String(prop.propertyValueType); } catch (eT) { }
        try { if (prop.numKeys !== undefined) o.num_keys = prop.numKeys; } catch (eK) { }
        o.animated = o.num_keys > 0;
        try {
            if (prop.numProperties !== undefined && prop.numProperties !== null && prop.numProperties > 0) {
                o.type = "group";
                o.num_properties = prop.numProperties;
            } else {
                try { o.dimension = Number(prop.propertyDimension); } catch (eD) { }
                o.value = H.serializeValue(prop);
            }
        } catch (eV) { }
        try { if (prop.expression !== undefined && String(prop.expression).length > 0) o.expression = String(prop.expression); } catch (eE) { }
        return o;
    };

    H.layerTypeName = function (layer) {
        try {
            if (layer.nullLayer) return "null";
            if (layer instanceof CameraLayer) return "camera";
            if (layer instanceof LightLayer) return "light";
            if (layer instanceof TextLayer) return "text";
            if (layer instanceof ShapeLayer) return "shape";
            if (layer.adjustmentLayer) return "adjustment";
            if (layer instanceof AVLayer) {
                if (layer.audioEnabled && !layer.hasVideo) return "audio";
                if (layer.source instanceof SolidSource) return "solid";
                if (layer.source instanceof AVItem) return "footage";
                return "av";
            }
            if (layer instanceof AVItem === false && layer.index !== undefined) return "layer";
            return "unknown";
        } catch (eT) { return "unknown"; }
    };

    H.compSummary = function (comp) {
        return {
            id: comp.id,
            name: String(comp.name),
            width: comp.width,
            height: comp.height,
            pixel_aspect: Number(comp.pixelAspect),
            duration: Number(comp.duration),
            frame_rate: Number(comp.frameRate),
            num_layers: comp.numLayers,
            folder: comp.parentFolder ? String(comp.parentFolder.name) : null
        };
    };

    H.layerSummary = function (layer) {
        var o = {
            index: layer.index,
            name: String(layer.name),
            type: H.layerTypeName(layer),
            enabled: !!layer.enabled,
            solo: !!layer.solo,
            shy: !!layer.shy,
            locked: !!layer.locked,
            three_d: !!layer.threeDLayer,
            in_point: Number(layer.inPoint),
            out_point: Number(layer.outPoint),
            start_time: Number(layer.startTime),
            label: Number(layer.label)
        };
        try { o.parent = layer.parent ? String(layer.parent.name) : null; } catch (eP) { }
        try { o.stretch = Number(layer.stretch); } catch (eSt) { }
        try { o.quality = (layer.quality === LayerQuality.BEST) ? "best" : "draft"; } catch (eQ) { }
        try { o.num_effects = layer.property("ADBE Effect Parade").numProperties; } catch (eEf) { }
        try { o.num_masks = layer.property("ADBE Mask Parade").numProperties; } catch (eM) { }
        return o;
    };

    H.markerValueSummary = function (mv, t) {
        var o = { time_s: Number(t), comment: "", chapter: null, url: null, duration_s: 0, cue_point_name: null, params: {} };
        try { o.comment = String(mv.comment); } catch (e1) { }
        try { o.chapter = mv.chapter ? String(mv.chapter) : null; } catch (e2) { }
        try { o.url = mv.url ? String(mv.url) : null; } catch (e3) { }
        try { o.duration_s = Number(mv.duration); } catch (e4) { }
        try { o.cue_point_name = mv.cuePointName ? String(mv.cuePointName) : null; } catch (e5) { }
        return o;
    };

    H.serializeMarkers = function (markerProp) {
        var out = [];
        try {
            for (var i = 1; i <= markerProp.numKeys; i++) {
                out.push(H.markerValueSummary(markerProp.keyValue(i), markerProp.keyTime(i)));
            }
        } catch (eM) { }
        return out;
    };

    H.effectsList = function (layer) {
        var out = [];
        try {
            var fx = layer.property("ADBE Effect Parade");
            for (var i = 1; i <= fx.numProperties; i++) {
                var e = fx.property(i);
                out.push({ index: i, name: String(e.name), match_name: String(e.matchName) });
            }
        } catch (eE) { }
        return out;
    };

    // Generic JSON-safe guard: keep plain data, stringify AE objects, cap size.
    H.jsonSafe = function (v, depth) {
        if (depth === undefined) depth = 0;
        try {
            var t = typeof v;
            if (v === null || t === "undefined") return null;
            if (t === "number" || t === "boolean") return v;
            if (t === "string") return v.length > 200000 ? v.substring(0, 200000) + "...[truncated]" : v;
            if (t === "function") return null;
            if (t === "object") {
                if (depth > 12) return "[depth limit]";
                if (v instanceof Array) {
                    var arr = [];
                    for (var i = 0; i < v.length; i++) arr.push(H.jsonSafe(v[i], depth + 1));
                    return arr;
                }
                if (v instanceof Date) return H.iso();
                var o = {};
                for (var k in v) {
                    if (v.hasOwnProperty(k)) o[k] = H.jsonSafe(v[k], depth + 1);
                }
                return o;
            }
            return String(v);
        } catch (eSafe) {
            return null;
        }
    };

    $.global.AE_MCP_HELPERS = H;
})();

// ===========================================================================
// TOOLS PART 2: system, project, items, compositions
// ===========================================================================
(function () {
    if (!$.global.AE_MCP_TOOLS || !$.global.AE_MCP_HELPERS) return;
    var T = $.global.AE_MCP_TOOLS;
    var H = $.global.AE_MCP_HELPERS;

    // ------------------------------------------------------------------ system

    T["ping"] = function (a) {
        var info = { pong: true, ae_version: String(app.version), ae_build: String(app.buildName) };
        try {
            if (app.project) {
                info.project_name = app.project.file ? String(app.project.file.displayName) : null;
                info.dirty = !!app.project.dirty;
                info.num_items = app.project.numItems;
            }
        } catch (eP) { }
        info.bridge = {
            id: $.global.AE_MCP_BRIDGE.state.id,
            version: $.global.AE_MCP_BRIDGE.state.version,
            uptime_s: Math.round((new Date().getTime() - $.global.AE_MCP_BRIDGE.state.startedAt) / 1000),
            served: $.global.AE_MCP_BRIDGE.state.served
        };
        return info;
    };

    T["ae_info"] = function (a) {
        var info = {
            ae_version: String(app.version),
            ae_build: String(app.buildName),
            ae_language: null,
            has_project: !!app.project,
            security_pref: null,
            features: {},
            project: null,
            runtime_dir: $.global.AE_MCP_BRIDGE.state.runtimeDir
        };
        try { info.ae_language = String(app.isoLanguage); } catch (eL) { }
        try { info.security_pref = app.preferences.getPrefAsLong("Pref_Scripting", "Pref_SCRIPTING_FILE_NETWORK_SECURITY") === 1; } catch (eP) { }
        info.features.saveFrameToPng = parseFloat(app.version) >= 23.0;
        try { info.features.app_effects = (typeof app.effects !== "undefined" && app.effects !== null); } catch (eE) { }
        try { info.features.app_fonts = (typeof app.fonts !== "undefined" && app.fonts !== null); } catch (eF) { }
        info.features.socket = (typeof Socket !== "undefined");
        if (app.project) {
            info.project = {
                file: app.project.file ? H.fwd(app.project.file.fsName) : null,
                dirty: !!app.project.dirty,
                num_items: app.project.numItems,
                bits_per_channel: app.project.bitsPerChannel
            };
        }
        return info;
    };

    T["get_active_item"] = function (a) {
        var p = H.requireProject();
        var out = { active_item: null, selected_layers: [], selected_properties: [] };
        try {
            var it = p.activeItem;
            if (it) {
                out.active_item = { id: it.id, name: String(it.name), type: (it instanceof CompItem) ? "comp" : (it instanceof FolderItem ? "folder" : "footage") };
            }
        } catch (eA) { }
        try {
            var it2 = p.activeItem;
            if (it2 && it2 instanceof CompItem) {
                for (var i = 0; i < it2.selectedLayers.length; i++) {
                    out.selected_layers.push(H.layerSummary(it2.selectedLayers[i]));
                }
                for (var j = 0; j < it2.selectedProperties.length; j++) {
                    out.selected_properties.push(H.propSummary(it2.selectedProperties[j]));
                }
            }
        } catch (eS) { }
        return out;
    };

    T["menu_command"] = function (a) {
        if (a.command === undefined || a.command === null) throw H.err("command is required", "BAD_ARGS");
        var id = null;
        if (typeof a.command === "number") {
            id = a.command;
        } else if (/^[0-9]+$/.test(String(a.command))) {
            id = Number(a.command);
        } else {
            id = app.findMenuCommandId(String(a.command));
            if (!id) throw H.err("Menu command not found: '" + a.command + "'", "NOT_FOUND");
        }
        app.executeCommand(id);
        return { command: a.command, command_id: id, executed: true };
    };

    T["run_script"] = function (a) {
        var code = H.str(a.code, "");
        if (!code) throw H.err("code is required", "BAD_ARGS");
        var fn;
        try {
            fn = new Function(code);
        } catch (eSyn) {
            throw H.err("Syntax error in script: " + H.err(eSyn).message, "SYNTAX_ERROR");
        }
        var result = fn();
        return { result: H.jsonSafe(result) };
    };

    T["help_bridge"] = function (a) {
        return {
            bridge: "ae_bridge.jsx resident ExtendScript bridge",
            how_it_works: [
                "The MCP server writes commands/request-<id>.json into the bridge mailbox.",
                "This bridge (loaded inside After Effects) consumes them every 250 ms,",
                "executes the named tool inside one undo group with dialogs suppressed,",
                "and writes results/response-<id>.json back."
            ],
            install_steps: [
                "1. Enable AE preference: Scripting & Expressions > 'Allow Scripts to Write Files and Access Network'.",
                "2. Run the installer (install.py) or copy bridge/ae_bridge.jsx into",
                "   %APPDATA%\\Adobe\\After Effects <version>\\Scripts\\Startup\\ so it auto-starts.",
                "   Or run it once via File > Scripts > Run Script File.",
                "   Or just call any tool - the server pushes the bridge via 'AfterFX.exe -r'."
            ],
            mailbox: $.global.AE_MCP_BRIDGE.state.runtimeDir,
            troubleshooting: [
                "ping fails + no heartbeat.json -> AE not running or bridge not loaded (see install steps).",
                "All tools time out -> security preference is OFF, or a modal dialog blocks AE.",
                "See the mailbox bridge.log for the AE side of errors."
            ]
        };
    };

    // ----------------------------------------------------------------- project

    function itemKind(it) {
        if (it instanceof CompItem) return "comp";
        if (it instanceof FolderItem) return "folder";
        if (it instanceof FootageItem) {
            try { if (it.mainSource instanceof SolidSource) return "solid"; } catch (eS) { }
            return "footage";
        }
        return "unknown";
    }

    function footageSummary(it) {
        var o = {};
        try {
            o.path = it.file ? H.fwd(it.file.fsName) : null;
            o.width = it.width;
            o.height = it.height;
            o.duration = Number(it.duration);
            o.frame_rate = Number(it.frameRate);
            o.has_video = it.hasVideo;
            o.has_audio = it.hasAudio;
            o.still = !!it.mainSource.isStill;
        } catch (eF) { }
        return o;
    }

    function itemSummary(it) {
        var o = { id: it.id, name: String(it.name), kind: itemKind(it) };
        try { o.folder = it.parentFolder ? String(it.parentFolder.name) : null; } catch (eP) { }
        try {
            if (o.kind === "comp") o.summary = H.compSummary(it);
            else if (o.kind === "footage") o.summary = footageSummary(it);
            else if (o.kind === "folder") o.summary = { num_items: it.numItems };
            else if (o.kind === "solid") { }
        } catch (eS) { }
        return o;
    }

    T["project_info"] = function (a) {
        var p = H.requireProject();
        var out = {
            file: p.file ? H.fwd(p.file.fsName) : null,
            name: p.file ? String(p.file.displayName) : null,
            dirty: !!p.dirty,
            num_items: p.numItems,
            bits_per_channel: p.bitsPerChannel,
            time_display_type: String(p.timeDisplayType),
            active_item: null,
            census: { comp: 0, folder: 0, footage: 0, solid: 0, unknown: 0 }
        };
        try {
            var it = p.activeItem;
            if (it) out.active_item = { id: it.id, name: String(it.name), kind: itemKind(it) };
        } catch (eA) { }
        for (var i = 1; i <= p.numItems; i++) {
            var k = itemKind(p.item(i));
            if (out.census[k] !== undefined) out.census[k]++;
            else out.census.unknown++;
        }
        if (H.bool(a.include_folders, true)) {
            out.folder_tree = folderTree(p.rootFolder, 0);
        }
        return out;
    };

    function folderTree(folder, depth) {
        var node = { id: folder.id, name: String(folder.name), items: [], folders: [] };
        if (depth > 6) return node;
        try {
            for (var i = 1; i <= folder.numItems; i++) {
                var it = folder.item(i);
                if (it instanceof FolderItem) node.folders.push(folderTree(it, depth + 1));
                else node.items.push({ id: it.id, name: String(it.name), kind: itemKind(it) });
            }
        } catch (eT) { }
        return node;
    }

    T["project_list_items"] = function (a) {
        var p = H.requireProject();
        var typeFilter = H.str(a.type, null);
        var contains = H.str(a.name_contains, null);
        if (contains) contains = contains.toLowerCase();
        var limit = Math.min(H.num(a.limit, 200), 1000);
        var parentFolder = null;
        if (a.folder !== undefined && a.folder !== null && a.folder !== "") {
            parentFolder = H.folderByIdOrName(a.folder);
        }
        var out = [];
        for (var i = 1; i <= p.numItems && out.length < limit; i++) {
            var it = p.item(i);
            var kind = itemKind(it);
            if (typeFilter && kind !== typeFilter) continue;
            if (parentFolder && it.parentFolder !== parentFolder) continue;
            if (contains && String(it.name).toLowerCase().indexOf(contains) < 0) continue;
            out.push(itemSummary(it));
        }
        return { count: out.length, items: out };
    };

    T["project_new"] = function (a) {
        if (app.project && app.project.dirty && H.bool(a.save_current, true)) {
            try { app.project.save(); } catch (eSave) {
                throw H.err("Current project has unsaved changes and was never saved; save it first: " + describeErrorSafe(eSave), "SAVE_FAILED");
            }
        }
        app.newProject();
        return { created: true };
    };

    function describeErrorSafe(e) { try { return String(e.message || e); } catch (x) { return "error"; } }

    T["project_open"] = function (a) {
        var path = H.norm(H.str(a.path, ""));
        if (!path) throw H.err("path is required", "BAD_ARGS");
        var f = new File(path);
        if (!f.exists) throw H.err("File not found: " + path, "NOT_FOUND");
        if (app.project && app.project.dirty) {
            try { app.project.save(); } catch (eSave) { /* never-saved project: keep going */ }
        }
        app.open(f);
        var proj = app.project;
        if (!proj) throw H.err("Project did not open", "OPEN_FAILED");
        return {
            opened: true,
            file: proj.file ? H.fwd(proj.file.fsName) : path,
            num_items: proj.numItems
        };
    };

    T["project_save"] = function (a) {
        var p = H.requireProject();
        if (a.path !== undefined && a.path !== null && a.path !== "") {
            var f = new File(H.norm(String(a.path)));
            p.save(f);
            return { saved: true, path: H.fwd(p.file.fsName) };
        }
        if (!p.file) throw H.err("Project has never been saved - pass 'path' for Save As", "NEVER_SAVED");
        p.save();
        return { saved: true, path: H.fwd(p.file.fsName) };
    };

    T["project_close"] = function (a) {
        var p = H.requireProject();
        var opts = H.bool(a.save, true) ? CloseOptions.SAVE_CHANGES : CloseOptions.DO_NOT_SAVE_CHANGES;
        p.close(opts);
        return { closed: true, saved: H.bool(a.save, true) };
    };

    T["project_import_file"] = function (a) {
        var p = H.requireProject();
        var path = H.norm(H.str(a.path, ""));
        if (!path) throw H.err("path is required", "BAD_ARGS");
        var f = new File(path);
        if (!f.exists) throw H.err("File not found: " + path, "NOT_FOUND");
        var io = new ImportOptions();
        io.file = f;
        if (H.bool(a.sequence, false)) {
            io.sequence = true;
        }
        var mode = H.str(a.psd_mode, null);
        if (mode) {
            if (mode === "comp" || mode === "sequence_layers") io.importAs = ImportAsType.COMP;
            else if (mode === "comp_cropped") io.importAs = ImportAsType.COMP_CROPPED_LAYERS;
            else io.importAs = ImportAsType.FOOTAGE;
        }
        var item;
        try {
            item = p.importFile(io);
        } catch (eImp) {
            throw H.err("Import failed: " + describeErrorSafe(eImp), "IMPORT_FAILED");
        }
        if (a.folder !== undefined && a.folder !== null && a.folder !== "") {
            try { item.parentFolder = H.folderByIdOrName(a.folder); } catch (eF) { }
        }
        return { imported: true, item: itemSummary(item) };
    };

    T["project_consolidate"] = function (a) {
        var p = H.requireProject();
        var n = p.consolidateFootage();
        return { consolidated: true, items_removed: Number(n) };
    };

    T["project_remove_unused"] = function (a) {
        var p = H.requireProject();
        var n = p.removeUnusedFootage();
        return { removed: true, items_removed: Number(n) };
    };

    T["project_reduce"] = function (a) {
        var p = H.requireProject();
        if (!(a.keep_comps instanceof Array) || a.keep_comps.length === 0) {
            throw H.err("keep_comps must be a non-empty array of comp names/ids", "BAD_ARGS");
        }
        var items = [];
        for (var i = 0; i < a.keep_comps.length; i++) {
            var it = H.itemByIdOrName(a.keep_comps[i]);
            if (!(it instanceof CompItem)) throw H.err("'" + a.keep_comps[i] + "' is not a composition", "NOT_A_COMP");
            items.push(it);
        }
        var n = p.reduceProject(items);
        return { reduced: true, items_removed: Number(n) };
    };

    T["project_set_bit_depth"] = function (a) {
        var p = H.requireProject();
        var bits = H.num(a.bits, 8);
        if (bits !== 8 && bits !== 16 && bits !== 32) throw H.err("bits must be 8, 16 or 32", "BAD_ARGS");
        p.bitsPerChannel = bits;
        return { bits_per_channel: p.bitsPerChannel };
    };

    // ------------------------------------------------------------------- items

    T["item_rename"] = function (a) {
        var it = H.itemByIdOrName(a.item);
        var old = String(it.name);
        it.name = H.str(a.new_name, old);
        return { renamed: true, id: it.id, old_name: old, new_name: String(it.name) };
    };

    T["item_delete"] = function (a) {
        var it = H.itemByIdOrName(a.item);
        var id = it.id, name = String(it.name);
        it.remove();
        return { deleted: true, id: id, name: name };
    };

    T["folder_create"] = function (a) {
        var p = H.requireProject();
        var parent = H.folderByIdOrName(a.parent, p.rootFolder);
        var f = p.items.addFolder(H.str(a.name, "Folder"));
        f.parentFolder = parent;
        return { created: true, id: f.id, name: String(f.name) };
    };

    T["item_move"] = function (a) {
        var it = H.itemByIdOrName(a.item);
        var target = H.folderByIdOrName(a.folder);
        it.parentFolder = target;
        return { moved: true, id: it.id, name: String(it.name), folder: String(target.name) };
    };

    // -------------------------------------------------------------- compositions

    T["comp_create"] = function (a) {
        var p = H.requireProject();
        var name = H.str(a.name, "");
        if (!name) throw H.err("name is required", "BAD_ARGS");
        var w = Math.round(H.num(a.width, 1920));
        var h = Math.round(H.num(a.height, 1080));
        var pa = H.num(a.pixel_aspect, 1.0);
        var dur = H.num(a.duration, 5);
        var fps = H.num(a.frame_rate, 30);
        if (w < 1 || h < 1) throw H.err("width/height must be >= 1", "BAD_ARGS");
        if (dur <= 0) throw H.err("duration must be > 0", "BAD_ARGS");
        if (fps <= 0) throw H.err("frame_rate must be > 0", "BAD_ARGS");
        var comp = p.items.addComp(name, w, h, pa, dur, fps);
        if (a.background_color !== undefined && a.background_color !== null) {
            try { comp.bgColor = H.color(a.background_color); } catch (eBg) { }
        }
        if (a.folder !== undefined && a.folder !== null && a.folder !== "") {
            try { comp.parentFolder = H.folderByIdOrName(a.folder); } catch (eF) { }
        }
        return { created: true, comp: H.compSummary(comp) };
    };

    T["comp_list"] = function (a) {
        var p = H.requireProject();
        var out = [];
        for (var i = 1; i <= p.numItems; i++) {
            if (p.item(i) instanceof CompItem) out.push(H.compSummary(p.item(i)));
        }
        return { count: out.length, comps: out };
    };

    T["comp_info"] = function (a) {
        var comp = H.compDefault(a.comp);
        var out = {
            comp: H.compSummary(comp),
            work_area_start: Number(comp.workAreaStart),
            work_area_duration: Number(comp.workAreaDuration),
            motion_blur: !!comp.motionBlur,
            shutter_angle: Number(comp.motionBlurShutterAngle),
            shutter_phase: Number(comp.motionBlurShutterPhase),
            markers: H.serializeMarkers(comp.markerProperty),
            num_layers: comp.numLayers,
            layers: []
        };
        if (H.bool(a.include_layers, true)) {
            for (var i = 1; i <= comp.numLayers; i++) {
                out.layers.push(H.layerSummary(comp.layer(i)));
            }
        }
        return out;
    };

    T["comp_set_settings"] = function (a) {
        var comp = H.compDefault(a.comp);
        var changed = [];
        if (a.width !== undefined || a.height !== undefined) {
            if (a.width === undefined || a.height === undefined) {
                throw H.err("Set width and height together", "BAD_ARGS");
            }
            comp.width = Math.round(Number(a.width));
            comp.height = Math.round(Number(a.height));
            changed.push("size");
        }
        if (a.pixel_aspect !== undefined) { comp.pixelAspect = Number(a.pixel_aspect); changed.push("pixel_aspect"); }
        if (a.duration !== undefined) { comp.duration = Number(a.duration); changed.push("duration"); }
        if (a.frame_rate !== undefined) { comp.frameRate = Number(a.frame_rate); changed.push("frame_rate"); }
        if (a.background_color !== undefined) { comp.bgColor = H.color(a.background_color); changed.push("background_color"); }
        if (a.motion_blur !== undefined) { comp.motionBlur = H.bool(a.motion_blur); changed.push("motion_blur"); }
        if (a.shutter_angle !== undefined) { comp.motionBlurShutterAngle = Number(a.shutter_angle); changed.push("shutter_angle"); }
        if (a.shutter_phase !== undefined) { comp.motionBlurShutterPhase = Number(a.shutter_phase); changed.push("shutter_phase"); }
        if (a.work_area_start !== undefined) { comp.workAreaStart = Number(a.work_area_start); changed.push("work_area_start"); }
        if (a.work_area_duration !== undefined) { comp.workAreaDuration = Number(a.work_area_duration); changed.push("work_area_duration"); }
        return { changed: changed, comp: H.compSummary(comp) };
    };

    T["comp_duplicate"] = function (a) {
        var comp = H.compDefault(a.comp);
        var dup = comp.duplicate();
        if (a.new_name !== undefined && a.new_name !== null && a.new_name !== "") {
            dup.name = H.str(a.new_name, "");
        }
        return { duplicated: true, comp: H.compSummary(dup) };
    };

    T["comp_delete"] = function (a) {
        var comp = H.compDefault(a.comp);
        var id = comp.id, name = String(comp.name);
        comp.remove();
        return { deleted: true, id: id, name: name };
    };

    T["comp_precompose"] = function (a) {
        var comp = H.compDefault(a.comp);
        if (!(a.layers instanceof Array) || a.layers.length === 0) {
            throw H.err("layers must be a non-empty array of layer indices/names", "BAD_ARGS");
        }
        var name = H.str(a.name, "");
        if (!name) throw H.err("name is required", "BAD_ARGS");
        var idxs = H.layerIndices(comp, a.layers);
        if (idxs.length === 0) throw H.err("No layers resolved from the given list", "NOT_FOUND");
        var moveAll = H.bool(a.move_all_attributes, true);
        var pre = comp.layers.precompose(idxs, name, moveAll);
        return { precomposed: true, precomp: H.compSummary(pre), layer_indices: idxs };
    };

    // register private helpers used by later parts
    H.itemKind = itemKind;
    H.itemSummary = itemSummary;
    H.footageSummary = footageSummary;
})();

// ===========================================================================
// TOOLS PART 3: layers, transform/properties, keyframes, expressions
// ===========================================================================
(function () {
    if (!$.global.AE_MCP_TOOLS || !$.global.AE_MCP_HELPERS) return;
    var T = $.global.AE_MCP_TOOLS;
    var H = $.global.AE_MCP_HELPERS;

    // ------------------------------------------------------------------- layers

    function textDocFromStyle(td, a) {
        if (a.font !== undefined && a.font !== null && a.font !== "") td.font = String(a.font);
        if (a.font_size !== undefined) td.fontSize = Number(a.font_size);
        if (a.fill_color !== undefined) { td.fillColor = H.color(a.fill_color); td.applyFill = true; }
        if (a.apply_fill !== undefined) td.applyFill = H.bool(a.apply_fill);
        if (a.stroke_color !== undefined) { td.strokeColor = H.color(a.stroke_color); td.applyStroke = true; }
        if (a.stroke_width !== undefined) td.strokeWidth = Number(a.stroke_width);
        if (a.apply_stroke !== undefined) td.applyStroke = H.bool(a.apply_stroke);
        if (a.stroke_over_fill !== undefined) td.strokeOverFill = H.bool(a.stroke_over_fill);
        if (a.tracking !== undefined) td.tracking = Number(a.tracking);
        if (a.leading !== undefined && Number(a.leading) > 0) td.leading = Number(a.leading);
        if (a.baseline_shift !== undefined) td.baselineLocShift = Number(a.baseline_shift);
        if (a.justification !== undefined) {
            var jmap = {
                "left": ParagraphJustification.LEFT_JUSTIFY,
                "center": ParagraphJustification.CENTER_JUSTIFY,
                "right": ParagraphJustification.RIGHT_JUSTIFY,
                "full_justify": ParagraphJustification.FULL_JUSTIFY,
                "full_force": ParagraphJustification.FULL_JUSTIFY_LASTLINE
            };
            if (jmap[String(a.justification).toLowerCase()]) td.justification = jmap[String(a.justification).toLowerCase()];
        }
        return td;
    }

    T["layer_add_solid"] = function (a) {
        var comp = H.compDefault(a.comp);
        var name = H.str(a.name, "Solid");
        var w = Math.round(H.num(a.width, comp.width));
        var h = Math.round(H.num(a.height, comp.height));
        var col = H.color(a.color !== undefined ? a.color : [128, 128, 128]);
        var layer = comp.layers.addSolid(col, name, w, h, comp.pixelAspect, comp.duration);
        if (H.bool(a.adjustment, false)) layer.adjustmentLayer = true;
        if (a.folder !== undefined && a.folder !== null && a.folder !== "") {
            try { layer.source.parentFolder = H.folderByIdOrName(a.folder); } catch (eF) { }
        }
        return { added: true, layer: H.layerSummary(layer) };
    };

    T["layer_add_null"] = function (a) {
        var comp = H.compDefault(a.comp);
        var w = Math.round(H.num(a.width, 100));
        var h = Math.round(H.num(a.height, 100));
        var layer = comp.layers.addNull(w, h);
        if (a.name !== undefined && a.name !== null && a.name !== "") layer.name = String(a.name);
        return { added: true, layer: H.layerSummary(layer) };
    };

    T["layer_add_text"] = function (a) {
        var comp = H.compDefault(a.comp);
        var text = String(a.text === undefined || a.text === null ? "" : a.text);
        if (text === "") throw H.err("text is required", "BAD_ARGS");
        var layer;
        if (H.bool(a.box_text, false)) {
            var bw = H.num(a.box_width, 400);
            var bh = H.num(a.box_height, 100);
            layer = comp.layers.addBoxText([bw, bh], text);
        } else {
            layer = comp.layers.addText(text);
        }
        if (a.name !== undefined && a.name !== null && a.name !== "") layer.name = String(a.name);
        var srcText = layer.property("ADBE Text Document");
        var td = srcText.value;
        td = textDocFromStyle(td, a);
        srcText.setValue(td);
        if (a.position !== undefined && a.position !== null) {
            try { layer.property("ADBE Position").setValue(H.numArr(a.position)); } catch (ePos) { }
        }
        if (a.start_time !== undefined) layer.startTime = Number(a.start_time);
        return { added: true, layer: H.layerSummary(layer), text: td.text };
    };

    function addShapeGroup(comp, a, layer) {
        var groupName = H.str(a.group_name, "Group");
        var root = layer.property("ADBE Root Vectors Group");
        var group = root.addProperty("ADBE Vector Group");
        group.name = groupName;
        var contents = group.property("ADBE Vectors Group");
        var shapeType = String(a.shape_type || "rect").toLowerCase();
        var size = H.numArr(a.size !== undefined ? a.size : [200, 200], [200, 200]);
        var shape;
        if (shapeType === "ellipse") {
            shape = contents.addProperty("ADBE Vector Shape - Ellipse");
            shape.property("ADBE Vector Ellipse Size").setValue([size[0], size[1]]);
            shape.property("ADBE Vector Ellipse Position").setValue([0, 0]);
        } else if (shapeType === "star" || shapeType === "polygon") {
            shape = contents.addProperty("ADBE Vector Shape - Star");
            shape.property("ADBE Vector Star Type").setValue(shapeType === "star" ? 2 : 1);
            shape.property("ADBE Vector Star Points").setValue(Math.round(H.num(a.points, 5)));
            var outer = a.outer_radius !== undefined ? Number(a.outer_radius) : (size[1] / 2);
            shape.property("ADBE Vector Star Outer Radius").setValue(outer);
            if (shapeType === "star") {
                shape.property("ADBE Vector Star Inner Radius").setValue(a.inner_radius !== undefined ? Number(a.inner_radius) : outer / 2);
            }
        } else {
            shape = contents.addProperty("ADBE Vector Shape - Rect");
            shape.property("ADBE Vector Rect Size").setValue([size[0], size[1]]);
            var round = a.roundness !== undefined ? Number(a.roundness) : 0;
            shape.property("ADBE Vector Rect Roundness").setValue(round);
        }
        // fill / stroke
        var hasFill = a.fill_color !== undefined && a.fill_color !== null;
        if (hasFill) {
            var fill = contents.addProperty("ADBE Vector Graphic - Fill");
            fill.property("ADBE Vector Fill Color").setValue(H.color(a.fill_color));
            if (a.fill_opacity !== undefined) fill.property("ADBE Vector Fill Opacity").setValue(Number(a.fill_opacity));
        }
        var sw = a.stroke_width !== undefined ? Number(a.stroke_width) : 0;
        if (sw > 0 || a.stroke_color !== undefined) {
            var stroke = contents.addProperty("ADBE Vector Graphic - Stroke");
            stroke.property("ADBE Vector Stroke Color").setValue(H.color(a.stroke_color !== undefined ? a.stroke_color : [0, 0, 0]));
            stroke.property("ADBE Vector Stroke Width").setValue(sw);
        }
        if (a.position !== undefined && a.position !== null && a.position.length >= 2) {
            try {
                group.property("ADBE Vector Transform Group").property("ADBE Vector Position").setValue([Number(a.position[0]), Number(a.position[1])]);
            } catch (eGP) { }
        }
        return group;
    }

    T["layer_add_shape"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer;
        if (a.layer !== undefined && a.layer !== null && a.layer !== "") {
            layer = H.layerBySel(comp, a.layer);
        } else {
            layer = comp.layers.addShape();
            if (a.name !== undefined && a.name !== null && a.name !== "") layer.name = String(a.name);
        }
        addShapeGroup(comp, a, layer);
        if (a.position !== undefined && a.position !== null && a.layer === undefined) {
            try { layer.property("ADBE Position").setValue(H.numArr(a.position)); } catch (eP) { }
        }
        if (a.start_time !== undefined) layer.startTime = Number(a.start_time);
        if (H.bool(a.three_d, false)) layer.threeDLayer = true;
        return { added: true, layer: H.layerSummary(layer) };
    };

    T["layer_add_camera"] = function (a) {
        var comp = H.compDefault(a.comp);
        var name = H.str(a.name, "Camera");
        var pos = a.position !== undefined ? H.numArr(a.position) : [comp.width / 2, comp.height / 2, -comp.height];
        var layer = comp.layers.addCamera(name, pos);
        var opts = layer.property("ADBE Camera Options Group");
        var twoNode = H.bool(a.two_node, false);
        if (a.point_of_interest !== undefined && a.point_of_interest !== null) {
            try { layer.property("ADBE Point of Interest").setValue(H.numArr(a.point_of_interest)); } catch (ePoi) { }
        } else if (twoNode) {
            try { layer.property("ADBE Point of Interest").setValue([comp.width / 2, comp.height / 2, 0]); } catch (ePoi2) { }
        }
        try { if (a.zoom !== undefined) opts.property("ADBE Camera Zoom").setValue(Number(a.zoom)); } catch (eZ) { }
        try {
            if (a.depth_of_field !== undefined) {
                opts.property("ADBE Camera Depth of Field").setValue(H.bool(a.depth_of_field) ? 2 : 1);
            }
            if (a.focus_distance !== undefined) opts.property("ADBE Camera Focus Distance").setValue(Number(a.focus_distance));
            if (a.aperture !== undefined) opts.property("ADBE Camera Aperture").setValue(Number(a.aperture));
            if (a.blur_level !== undefined) opts.property("ADBE Camera Blur Level").setValue(Number(a.blur_level));
        } catch (eDof) { }
        // one-node/two-node toggle has no stable matchName; report what we did
        var warned = twoNode && a.point_of_interest === undefined ? null : "two_node camera uses Point of Interest";
        return { added: true, layer: H.layerSummary(layer), note: warned };
    };

    T["layer_add_light"] = function (a) {
        var comp = H.compDefault(a.comp);
        var name = H.str(a.name, "Light");
        var pos = a.position !== undefined ? H.numArr(a.position) : [comp.width / 2, comp.height / 2, 0];
        var layer = comp.layers.addLight(name, pos);
        var typeMap = {
            "point": LightType.POINT, "spot": LightType.SPOT,
            "parallel": LightType.PARALLEL, "ambient": LightType.AMBIENT
        };
        var lt = typeMap[String(H.str(a.light_type, "point")).toLowerCase()];
        if (lt !== undefined) layer.lightType = lt;
        try { if (a.color !== undefined) layer.property("ADBE Light Color").setValue(H.color(a.color)); } catch (eC) {
            try { layer.property("color").setValue(H.color(a.color)); } catch (eC2) { }
        }
        try { if (a.intensity !== undefined) layer.property("ADBE Light Intensity").setValue(Number(a.intensity)); } catch (eI) { }
        try {
            if (a.falloff !== undefined) layer.property("ADBE Light Falloff Radius").setValue(Number(a.falloff));
        } catch (eFal) { }
        try {
            if (a.casts_shadows !== undefined) layer.property("ADBE Light Casts Shadows").setValue(H.bool(a.casts_shadows) ? 1 : 0);
            if (a.shadow_darkness !== undefined) layer.property("ADBE Light Shadow Darkness").setValue(Number(a.shadow_darkness));
            if (a.shadow_diffusion !== undefined) layer.property("ADBE Light Shadow Diffusion").setValue(Number(a.shadow_diffusion));
        } catch (eSh) { }
        return { added: true, layer: H.layerSummary(layer) };
    };

    T["layer_add_footage"] = function (a) {
        var comp = H.compDefault(a.comp);
        var item = H.itemByIdOrName(a.item);
        if (!(item instanceof AVItem)) throw H.err("Item '" + a.item + "' cannot be added as a layer (not an AVItem)", "NOT_A_FOOTAGE");
        var layer = comp.layers.add(item);
        var pos = a.position !== undefined ? H.numArr(a.position) : [comp.width / 2, comp.height / 2];
        try { layer.property("ADBE Position").setValue(pos); } catch (eP) { }
        if (a.start_time !== undefined) layer.startTime = Number(a.start_time);
        if (H.bool(a.fit_to_comp, false)) {
            try {
                var sx = (comp.width / item.width) * 100;
                var sy = (comp.height / item.height) * 100;
                var s = Math.min(sx, sy);
                layer.property("ADBE Scale").setValue([s, s]);
            } catch (eFit) { }
        }
        return { added: true, layer: H.layerSummary(layer) };
    };

    T["layer_duplicate"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        var dup = layer.duplicate();
        if (a.new_name !== undefined && a.new_name !== null && a.new_name !== "") dup.name = String(a.new_name);
        if (a.shift_s !== undefined && Number(a.shift_s) !== 0) {
            dup.startTime = dup.startTime + Number(a.shift_s);
        }
        return { duplicated: true, layer: H.layerSummary(dup) };
    };

    T["layer_delete"] = function (a) {
        var comp = H.compDefault(a.comp);
        if (a.layer === undefined || a.layer === null) throw H.err("layer is required", "BAD_ARGS");
        var idxs = H.layerIndices(comp, a.layer instanceof Array ? a.layer : [a.layer]);
        var names = [];
        for (var i = idxs.length - 1; i >= 0; i--) {
            names.push(String(comp.layer(idxs[i]).name));
            comp.layer(idxs[i]).remove();
        }
        return { deleted: true, count: idxs.length, names: names };
    };

    T["layer_list"] = function (a) {
        var comp = H.compDefault(a.comp);
        var typeFilter = H.str(a.only_matching_type, null);
        var out = [];
        for (var i = 1; i <= comp.numLayers; i++) {
            var s = H.layerSummary(comp.layer(i));
            if (typeFilter && s.type !== typeFilter) continue;
            out.push(s);
        }
        return { count: out.length, layers: out };
    };

    function keyframeCounts(layer, max) {
        var out = [];
        function walk(group, path, depth) {
            if (out.length >= max || depth > 4) return;
            var n = 0;
            try { n = group.numProperties; } catch (eN) { return; }
            for (var i = 1; i <= n && out.length < max; i++) {
                var p;
                try { p = group.property(i); } catch (eP) { continue; }
                if (p.numProperties !== undefined && p.numProperties !== null && p.numProperties > 0) {
                    walk(p, path + "." + String(p.name), depth + 1);
                } else if (p.numKeys !== undefined && p.numKeys > 0) {
                    out.push({ path: path + "." + String(p.name), match_name: String(p.matchName), num_keys: p.numKeys });
                }
            }
        }
        walk(layer, "", 0);
        return out;
    }

    T["layer_info"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        var out = H.layerSummary(layer);
        out.id = layer.index;
        out.flags = {
            enabled: !!layer.enabled, solo: !!layer.solo, shy: !!layer.shy,
            locked: !!layer.locked, three_d: !!layer.threeDLayer,
            guide: !!layer.guideLayer, adjustment: !!layer.adjustmentLayer,
            auto_orient: String(layer.autoOrient)
        };
        // transform values
        var tr = {};
        var tprops = {
            "anchor_point": ["ADBE Transform Group", "ADBE Anchor Point"],
            "position": ["ADBE Transform Group", "ADBE Position"],
            "scale": ["ADBE Transform Group", "ADBE Scale"],
            "rotation": ["ADBE Transform Group", "ADBE Rotate Z"],
            "opacity": ["ADBE Transform Group", "ADBE Opacity"],
            "orientation": ["ADBE Transform Group", "ADBE Orientation"],
            "x_rotation": ["ADBE Transform Group", "ADBE Rotate X"],
            "y_rotation": ["ADBE Transform Group", "ADBE Rotate Y"],
            "point_of_interest": ["ADBE Transform Group", "ADBE Point of Interest"]
        };
        for (var key in tprops) {
            if (!tprops.hasOwnProperty(key)) continue;
            try {
                var pp = layer.property(tprops[key][0]).property(tprops[key][1]);
                tr[key] = H.serializeValue(pp);
                if (pp.numKeys > 0) tr[key + "_keys"] = pp.numKeys;
            } catch (eTr) { }
        }
        out.transform = tr;
        // source
        try {
            if (layer.source) {
                out.source = {
                    id: layer.source.id,
                    name: String(layer.source.name),
                    width: layer.source.width,
                    height: layer.source.height,
                    frame_rate: Number(layer.source.frameRate),
                    duration: Number(layer.source.duration),
                    path: (layer.source.file ? H.fwd(layer.source.file.fsName) : null)
                };
            }
        } catch (eSrc) { }
        out.effects = H.effectsList(layer);
        try {
            var masks = layer.property("ADBE Mask Parade");
            out.masks = [];
            for (var m = 1; m <= masks.numProperties; m++) {
                var mk = masks.property(m);
                out.masks.push({ index: m, name: String(mk.name), match_name: String(mk.matchName) });
            }
        } catch (eMk) { }
        try { out.markers = H.serializeMarkers(layer.property("ADBE Marker")); } catch (eMar) { }
        if (String(H.layerTypeName(layer)) === "text") {
            try { out.text = H.serializeTextDoc(layer.property("ADBE Text Document").value); } catch (eTx) { }
        }
        out.animated_properties = keyframeCounts(layer, 60);
        return out;
    };

    T["layer_set_flags"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        var changed = [];
        function setB(key, apply, guard) {
            if (a[key] !== undefined) {
                try { apply(H.bool(a[key])); changed.push(key); } catch (e) {
                    if (!guard) throw H.err("Cannot set '" + key + "': " + describeErrorSafe(e), "SET_FAILED");
                }
            }
        }
        setB("enabled", function (v) { layer.enabled = v; });
        setB("solo", function (v) { layer.solo = v; });
        setB("shy", function (v) { layer.shy = v; });
        setB("locked", function (v) { layer.locked = v; });
        setB("three_d", function (v) { layer.threeDLayer = v; });
        setB("guide", function (v) { layer.guideLayer = v; }, true);
        setB("audio_enabled", function (v) { layer.audioEnabled = v; });
        setB("motion_blur", function (v) { layer.motionBlur = v; });
        setB("adjustment", function (v) { layer.adjustmentLayer = v; }, true);
        if (a.auto_orient !== undefined) {
            var amap = {
                "none": AutoOrientType.NO_AUTO_ORIENT,
                "along_path": AutoOrientType.ALONG_PATH,
                "toward_poi": AutoOrientType.TOWARD_POINT_OF_INTEREST,
                "each_frame": AutoOrientType.PERPENDICULAR_TO_PATH
            };
            var at = amap[String(a.auto_orient).toLowerCase()];
            if (at === undefined) throw H.err("Unknown auto_orient '" + a.auto_orient + "'", "BAD_ARGS");
            layer.autoOrient = at;
            changed.push("auto_orient");
        }
        return { changed: changed, layer: H.layerSummary(layer) };
    };

    T["layer_set_parent"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        var parentRef = a.parent;
        if (parentRef === undefined || parentRef === null || parentRef === "" ||
            String(parentRef).toLowerCase() === "none" || String(parentRef).toLowerCase() === "null") {
            layer.parent = null;
            return { parented: false, layer: H.layerSummary(layer) };
        }
        var parent = H.layerBySel(comp, parentRef);
        if (parent === layer) throw H.err("A layer cannot parent itself", "BAD_ARGS");
        var keep = H.bool(a.keep_transform, true);
        if (keep) layer.parent = parent;
        else layer.setParentWithJump(parent);
        return { parented: true, parent: String(parent.name), keep_transform: keep, layer: H.layerSummary(layer) };
    };

    T["layer_reorder"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        var where = String(H.str(a.where, "top")).toLowerCase();
        if (where === "top") layer.moveToBeginning();
        else if (where === "bottom") layer.moveToEnd();
        else if (where === "before" || where === "after") {
            if (a.reference === undefined || a.reference === null) throw H.err("reference layer is required for before/after", "BAD_ARGS");
            var ref = H.layerBySel(comp, a.reference);
            if (where === "before") layer.moveBefore(ref); else layer.moveAfter(ref);
        } else if (where === "index") {
            var idx = Math.round(H.num(a.index, 1));
            if (idx < 1 || idx > comp.numLayers) throw H.err("index out of range", "OUT_OF_RANGE");
            if (idx === 1) layer.moveToBeginning();
            else {
                layer.moveToEnd();
                // after moving to end, place before the layer that now occupies target index
                layer.moveBefore(comp.layer(idx));
            }
        } else throw H.err("Unknown where '" + where + "'", "BAD_ARGS");
        return { moved: true, new_index: layer.index, layer: H.layerSummary(layer) };
    };

    T["layer_trim"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        var changed = [];
        if (a.start_time !== undefined) { layer.startTime = Number(a.start_time); changed.push("start_time"); }
        if (a.in_point !== undefined) { layer.inPoint = Number(a.in_point); changed.push("in_point"); }
        if (a.out_point !== undefined) { layer.outPoint = Number(a.out_point); changed.push("out_point"); }
        if (layer.inPoint >= layer.outPoint) {
            throw H.err("in_point (" + layer.inPoint + ") must be < out_point (" + layer.outPoint + ")", "BAD_ARGS");
        }
        return { changed: changed, in_point: Number(layer.inPoint), out_point: Number(layer.outPoint), start_time: Number(layer.startTime) };
    };

    T["layer_split"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        var t = (a.time_s !== undefined) ? Number(a.time_s) : comp.time;
        if (t <= layer.inPoint || t >= layer.outPoint) {
            throw H.err("Split time " + t + " must be inside the layer (" + layer.inPoint + " .. " + layer.outPoint + ")", "OUT_OF_RANGE");
        }
        var dup = layer.duplicate();
        dup.startTime = layer.startTime; // same source alignment
        dup.inPoint = t;
        dup.outPoint = layer.outPoint;
        dup.moveAfter(layer);
        layer.outPoint = t;
        return {
            split: true, time_s: t,
            left: { name: String(layer.name), in_point: Number(layer.inPoint), out_point: Number(layer.outPoint) },
            right: { name: String(dup.name), in_point: Number(dup.inPoint), out_point: Number(dup.outPoint), index: dup.index }
        };
    };

    T["layer_set_quality"] = function (a) {
        var comp = H.compDefault(a.comp);
        if (a.layer === undefined || a.layer === null) throw H.err("layer is required", "BAD_ARGS");
        var list = a.layer instanceof Array ? a.layer : [a.layer];
        var quality = String(H.str(a.quality, "best")).toLowerCase();
        var q = quality === "draft" ? LayerQuality.DRAFT : LayerQuality.BEST;
        var changed = [];
        for (var i = 0; i < list.length; i++) {
            var L = H.layerBySel(comp, list[i]);
            L.quality = q;
            if (a.motion_blur_samples !== undefined) {
                try { L.motionBlurSamples = Math.min(64, Math.max(2, Math.round(Number(a.motion_blur_samples)))); } catch (eM) { }
            }
            changed.push(String(L.name));
        }
        return { changed: changed, quality: quality };
    };

    // ------------------------------------------------------ transform / props

    var TRANSFORM_PATHS = {
        "position": "ADBE Position",
        "scale": "ADBE Scale",
        "rotation": "ADBE Rotate Z",
        "x_rotation": "ADBE Rotate X",
        "y_rotation": "ADBE Rotate Y",
        "opacity": "ADBE Opacity",
        "anchor_point": "ADBE Anchor Point",
        "orientation": "ADBE Orientation"
    };

    T["transform_set"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        var tg = layer.property("ADBE Transform Group");
        var changed = [];
        var doKey = H.bool(a.set_keyframe, false);
        for (var key in TRANSFORM_PATHS) {
            if (!TRANSFORM_PATHS.hasOwnProperty(key)) continue;
            if (a[key] === undefined) continue;
            var prop;
            try { prop = tg.property(TRANSFORM_PATHS[key]); } catch (eP) { continue; }
            var val;
            if (key === "rotation" || key === "x_rotation" || key === "y_rotation" || key === "opacity") {
                val = Number(a[key]);
            } else {
                val = H.numArr(a[key]);
            }
            if (doKey) prop.setValueAtTime(comp.time, val);
            else prop.setValue(val);
            changed.push(key);
        }
        return { changed: changed, set_keyframe: doKey, time_s: Number(comp.time), layer: H.layerSummary(layer) };
    };

    T["prop_get"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        if (!a.path) throw H.err("path is required", "BAD_ARGS");
        var prop = H.propByPath(layer, a.path);
        var t = H.timeArg(comp, a);
        var out = H.propSummary(prop);
        out.value = H.serializeValue(prop, t);
        try { out.expression = String(prop.expression); } catch (eE) { }
        try { out.expression_error = String(prop.expressionError); } catch (eEr) { }
        try { out.can_set_expression = !!prop.canSetExpression; } catch (eCs) { }
        try { out.can_vary_over_time = !!prop.canVaryOverTime; } catch (eCv) { }
        return out;
    };

    function setPropValue(prop, value, comp, timeS, wantKeyframe) {
        var vt;
        try { vt = prop.propertyValueType; } catch (eV) { vt = null; }
        if (vt === PropertyValueType.TEXT_DOCUMENT) {
            var td = prop.value;
            if (typeof value === "string") {
                td.text = value;
            } else if (value && typeof value === "object") {
                if (value.text !== undefined) td.text = String(value.text);
                if (value.font !== undefined) td.font = String(value.font);
                if (value.font_size !== undefined) td.fontSize = Number(value.font_size);
                if (value.fill_color !== undefined) td.fillColor = H.color(value.fill_color);
                if (value.stroke_color !== undefined) td.strokeColor = H.color(value.stroke_color);
                if (value.tracking !== undefined) td.tracking = Number(value.tracking);
            }
            prop.setValue(td);
            return "text_document";
        }
        var v = value;
        if (vt === PropertyValueType.COLOR) v = H.color(value);
        else if (vt === PropertyValueType.TwoD || vt === PropertyValueType.TwoD_SPATIAL ||
                 vt === PropertyValueType.ThreeD || vt === PropertyValueType.ThreeD_SPATIAL) {
            v = H.numArr(value);
        } else if (vt === PropertyValueType.OneD) v = Number(value);
        else if (vt === PropertyValueType.BooleanValue) v = H.bool(value);
        if (wantKeyframe) {
            var t = (timeS !== undefined && timeS !== null) ? Number(timeS) : comp.time;
            // update-or-create at nearest-key granularity of half a frame
            var half = H.frameDur(comp) / 2;
            var idx = null;
            try { idx = prop.nearestKeyIndex(t); } catch (eN) { idx = null; }
            if (idx !== null && idx > 0 && Math.abs(prop.keyTime(idx) - t) <= half) {
                prop.setValueAtKey(idx, v);
            } else {
                prop.setValueAtTime(t, v);
            }
            return "keyframe";
        }
        prop.setValue(v);
        return "static";
    }
    H.setPropValue = setPropValue;

    T["prop_set"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        if (!a.path) throw H.err("path is required", "BAD_ARGS");
        var prop = H.propByPath(layer, a.path);
        if (a.value === undefined) throw H.err("value is required", "BAD_ARGS");
        var mode = setPropValue(prop, a.value, comp, a.time_s, H.bool(a.keyframe, false));
        return {
            set: true, mode: mode, path: String(prop.matchName),
            value: H.serializeValue(prop),
            num_keys: (prop.numKeys !== undefined) ? prop.numKeys : null
        };
    };

    function propTree(group, depth, maxDepth, includeValues, count) {
        var items = [];
        var n = 0;
        try { n = group.numProperties; } catch (eN) { return items; }
        for (var i = 1; i <= n && count.n < 400; i++) {
            var p;
            try { p = group.property(i); } catch (eP) { continue; }
            var o = { name: String(p.name), match_name: String(p.matchName) };
            var isGroup = false;
            try { isGroup = (p.numProperties !== undefined && p.numProperties !== null && p.numProperties > 0); } catch (eG) { }
            if (isGroup) {
                o.type = "group";
                if (depth < maxDepth) {
                    o.children = propTree(p, depth + 1, maxDepth, includeValues, count);
                } else {
                    o.children_truncated = true;
                }
            } else {
                try { o.type = String(p.propertyValueType); } catch (eT) { }
                try { o.dimension = Number(p.propertyDimension); } catch (eD) { }
                try { o.num_keys = p.numKeys; } catch (eK) { }
                if (includeValues) o.value = H.serializeValue(p);
            }
            items.push(o);
            count.n++;
        }
        return items;
    }

    T["prop_list"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        var root = (a.path !== undefined && a.path !== null && a.path !== "") ? H.propByPath(layer, a.path) : layer;
        var maxDepth = Math.min(Math.max(H.num(a.depth, 4), 1), 8);
        var count = { n: 0 };
        var tree = propTree(root, 0, maxDepth, H.bool(a.include_values, true), count);
        return { root: (a.path ? String(a.path) : String(layer.name)), num_properties: count.n, properties: tree };
    };

    T["prop_clear"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        if (!a.path) throw H.err("path is required", "BAD_ARGS");
        var prop = H.propByPath(layer, a.path);
        var removedExpression = false, removedKeys = 0;
        if (H.bool(a.remove_expression, true)) {
            try { if (String(prop.expression).length > 0) { prop.expression = ""; removedExpression = true; } } catch (eE) { }
        }
        if (H.bool(a.remove_keyframes, false)) {
            try {
                var nk = prop.numKeys;
                while (prop.numKeys > 0) prop.removeKey(prop.numKeys);
                removedKeys = nk;
            } catch (eK) { }
        }
        return { cleared: true, removed_expression: removedExpression, removed_keyframes: removedKeys };
    };

    var BLEND_MODES = {
        "normal": BlendingMode.NORMAL, "multiply": BlendingMode.MULTIPLY, "screen": BlendingMode.SCREEN,
        "overlay": BlendingMode.OVERLAY, "add": BlendingMode.ADD, "dissolve": BlendingMode.DISSOLVE,
        "dancing_dissolve": BlendingMode.DANCING_DISSOLVE, "darken": BlendingMode.DARKEN,
        "lighten": BlendingMode.LIGHTEN, "classic_color_burn": BlendingMode.CLASSIC_COLOR_BURN,
        "classic_color_dodge": BlendingMode.CLASSIC_COLOR_DODGE, "color_burn": BlendingMode.COLOR_BURN,
        "color_dodge": BlendingMode.COLOR_DODGE, "hard_light": BlendingMode.HARD_LIGHT,
        "soft_light": BlendingMode.SOFT_LIGHT, "vivid_light": BlendingMode.VIVID_LIGHT,
        "linear_light": BlendingMode.LINEAR_LIGHT, "pin_light": BlendingMode.PIN_LIGHT,
        "hard_mix": BlendingMode.HARD_MIX, "difference": BlendingMode.DIFFERENCE,
        "exclusion": BlendingMode.EXCLUSION, "hue": BlendingMode.HUE, "saturation": BlendingMode.SATURATION,
        "color": BlendingMode.COLOR, "luminosity": BlendingMode.LUMINOSITY,
        "stencil_alpha": BlendingMode.STENCIL_ALPHA, "stencil_luma": BlendingMode.STENCIL_LUMA,
        "silhouette_alpha": BlendingMode.SILHOUETTE_ALPHA, "silhouette_luma": BlendingMode.SILHOUETTE_LUMA,
        "alpha_add": BlendingMode.ALPHA_ADD, "luminescent_premultiply": BlendingMode.LUMINESCENT_PREMULTIPLY
    };

    T["blend_mode_set"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        var mode = String(H.str(a.mode, "normal")).toLowerCase();
        var bm = BLEND_MODES[mode];
        if (bm === undefined) {
            var keys = [];
            for (var k in BLEND_MODES) { if (BLEND_MODES.hasOwnProperty(k)) keys.push(k); }
            throw H.err("Unknown blend mode '" + mode + "'. Valid: " + keys.join(", "), "BAD_ARGS");
        }
        layer.blendingMode = bm;
        return { changed: true, blend_mode: mode };
    };

    T["track_matte_set"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        var map = {
            "none": TrackMatteType.NO_TRACK_MATTE, "alpha": TrackMatteType.ALPHA,
            "alpha_inverted": TrackMatteType.ALPHA_INVERTED, "luma": TrackMatteType.LUMA,
            "luma_inverted": TrackMatteType.LUMA_INVERTED
        };
        var kind = String(H.str(a.matte, "none")).toLowerCase();
        var tm = map[kind];
        if (tm === undefined) throw H.err("Unknown matte '" + kind + "'", "BAD_ARGS");
        layer.trackMatteType = tm;
        return { changed: true, track_matte: kind };
    };

    // ---------------------------------------------------------------- keyframes

    function interpMaps() {
        return {
            "linear": KeyframeInterpolationType.LINEAR,
            "bezier": KeyframeInterpolationType.BEZIER,
            "hold": KeyframeInterpolationType.HOLD,
            "auto_bezier": KeyframeInterpolationType.AUTO_BEZIER
        };
    }

    T["keyframe_set"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        if (!a.path) throw H.err("path is required", "BAD_ARGS");
        var prop = H.propByPath(layer, a.path);
        if (!prop.canVaryOverTime) throw H.err("Property '" + prop.matchName + "' cannot vary over time", "NOT_ANIMATABLE");
        var interp = null;
        if (a.interpolation !== undefined && a.interpolation !== null) {
            var im = interpMaps()[String(a.interpolation).toLowerCase()];
            if (!im) throw H.err("Unknown interpolation '" + a.interpolation + "'", "BAD_ARGS");
            interp = im;
        }
        var created = 0, updated = 0;
        var half = H.frameDur(comp) / 2;

        function putKey(t, value) {
            var idx = null;
            try { idx = prop.nearestKeyIndex(t); } catch (eN) { }
            if (idx !== null && idx > 0 && Math.abs(prop.keyTime(idx) - t) <= half) {
                prop.setValueAtKey(idx, value);
                updated++;
                if (interp) prop.setInterpolationTypeAtKey(idx, interp, interp);
                return idx;
            }
            prop.setValueAtTime(t, value);
            created++;
            var ni = prop.nearestKeyIndex(t);
            if (interp) prop.setInterpolationTypeAtKey(ni, interp, interp);
            return ni;
        }

        if (a.times !== undefined && a.values !== undefined) {
            if (!(a.times instanceof Array) || !(a.values instanceof Array) || a.times.length !== a.values.length) {
                throw H.err("times and values must be parallel arrays of equal length", "BAD_ARGS");
            }
            for (var i = 0; i < a.times.length; i++) putKey(Number(a.times[i]), a.values[i]);
        } else {
            if (a.value === undefined) throw H.err("value is required (or use times+values arrays)", "BAD_ARGS");
            var t = (a.time_s !== undefined) ? Number(a.time_s) : comp.time;
            putKey(t, a.value);
        }
        return { keys_created: created, keys_updated: updated, num_keys: prop.numKeys };
    };

    T["keyframe_remove"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        if (!a.path) throw H.err("path is required", "BAD_ARGS");
        var prop = H.propByPath(layer, a.path);
        var before = prop.numKeys;
        var removed = 0;
        if (H.bool(a.remove_all, false)) {
            while (prop.numKeys > 0) prop.removeKey(prop.numKeys);
            removed = before;
        } else if (a.indices !== undefined && a.indices !== null) {
            var idxs = [];
            for (var i = 0; i < a.indices.length; i++) idxs.push(Math.round(Number(a.indices[i])));
            idxs.sort(function (x, y) { return y - x; }); // descending
            for (var j = 0; j < idxs.length; j++) {
                if (idxs[j] >= 1 && idxs[j] <= prop.numKeys) { prop.removeKey(idxs[j]); removed++; }
            }
        } else if (a.time_s !== undefined) {
            var half = H.frameDur(comp);
            var idx = prop.nearestKeyIndex(Number(a.time_s));
            if (idx > 0 && Math.abs(prop.keyTime(idx) - Number(a.time_s)) <= half) { prop.removeKey(idx); removed++; }
            else throw H.err("No keyframe within one frame of time " + a.time_s, "NOT_FOUND");
        } else if (a.range !== undefined && a.range instanceof Array && a.range.length === 2) {
            for (var k = prop.numKeys; k >= 1; k--) {
                var t = prop.keyTime(k);
                if (t >= Number(a.range[0]) && t <= Number(a.range[1])) { prop.removeKey(k); removed++; }
            }
        } else {
            throw H.err("Provide indices, time_s, range or remove_all", "BAD_ARGS");
        }
        return { removed: removed, num_keys: prop.numKeys };
    };

    function easeSummary(easeArr) {
        var out = [];
        try {
            for (var i = 0; i < easeArr.length; i++) {
                out.push({ speed: Number(easeArr[i].speed), influence: Number(easeArr[i].influence) });
            }
        } catch (eE) { }
        return out;
    }

    T["keyframe_list"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        if (!a.path) throw H.err("path is required", "BAD_ARGS");
        var prop = H.propByPath(layer, a.path);
        var keys = [];
        for (var i = 1; i <= prop.numKeys; i++) {
            var o = {
                index: i,
                time_s: Number(prop.keyTime(i)),
                value: H.serializeValue(prop, prop.keyTime(i)),
                interpolation_in: String(prop.keyInInterpolationType(i)),
                interpolation_out: String(prop.keyOutInterpolationType(i))
            };
            try { o.temporal_auto_bezier = !!prop.keyTemporalAutoBezier(i); } catch (eTa) { }
            try { o.temporal_continuous = !!prop.keyTemporalContinuous(i); } catch (eTc) { }
            try { o.spatial_auto_bezier = !!prop.keySpatialAutoBezier(i); } catch (eSa) { }
            try { o.spatial_continuous = !!prop.keySpatialContinuous(i); } catch (eSc) { }
            try { o.ease_in = easeSummary(prop.keyTemporalEase(i)); } catch (eEi) { }
            try { o.ease_out = easeSummary(prop.keyTemporalEaseOut === undefined ? prop.keyTemporalEase(i) : prop.keyTemporalEaseOut(i)); } catch (eEo) { }
            try {
                var tin = prop.keyTangentIn(i), tout = prop.keyTangentOut(i);
                o.tangent_in = { type: String(tin.type), value: tin.one_d !== undefined ? tin.one_d : (tin.two_d !== undefined ? H.numArr(tin.two_d) : null) };
                o.tangent_out = { type: String(tout.type), value: tout.one_d !== undefined ? tout.one_d : (tout.two_d !== undefined ? H.numArr(tout.two_d) : null) };
            } catch (eTg) { }
            keys.push(o);
        }
        return { path: String(prop.matchName), num_keys: prop.numKeys, keyframes: keys };
    };

    T["keyframe_set_interpolation"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        if (!a.path) throw H.err("path is required", "BAD_ARGS");
        var prop = H.propByPath(layer, a.path);
        var im = interpMaps();
        var inType = null, outType = null;
        if (a.interpolation !== undefined && a.interpolation !== null) {
            inType = outType = im[String(a.interpolation).toLowerCase()];
            if (!inType) throw H.err("Unknown interpolation '" + a.interpolation + "'", "BAD_ARGS");
        }
        var indices = [];
        if (a.indices !== undefined && a.indices !== null) {
            for (var ii = 0; ii < a.indices.length; ii++) indices.push(Math.round(Number(a.indices[ii])));
        } else {
            for (var k = 1; k <= prop.numKeys; k++) indices.push(k);
        }
        var changed = 0;
        for (var i = 0; i < indices.length; i++) {
            var idx = indices[i];
            if (idx < 1 || idx > prop.numKeys) continue;
            if (inType) { prop.setInterpolationTypeAtKey(idx, inType, outType); changed++; }
            if (a.ease_in !== undefined || a.ease_out !== undefined) {
                var dim = 1;
                try { dim = Math.max(1, Number(prop.propertyDimension)); } catch (eD) { dim = 1; }
                var inEase = null, outEase = null;
                if (a.ease_in !== undefined) inEase = buildEaseArray(a.ease_in, dim, i);
                if (a.ease_out !== undefined) outEase = buildEaseArray(a.ease_out, dim, i);
                try {
                    if (inEase && outEase) prop.setTemporalEaseAtKey(idx, inEase, outEase);
                    else if (inEase) prop.setTemporalEaseAtKey(idx, inEase, currentEase(prop, idx, dim));
                    else if (outEase) prop.setTemporalEaseAtKey(idx, currentEase(prop, idx, dim), outEase);
                    changed++;
                } catch (eE) { }
            }
        }
        return { changed: changed, num_keys: prop.numKeys };
    };

    function buildEaseArray(spec, dim, keyPos) {
        function mk(speed, influence) {
            var inf = (influence === undefined || influence === null) ? 33.3333 : Number(influence);
            if (inf <= 0) inf = 0.1;
            if (inf > 100) inf = 100;
            return new KeyframeEase(Number(speed), inf);
        }
        var arr = [];
        if (spec instanceof Array && spec.length > 0) {
            if (typeof spec[0] === "object" && spec[0] !== null) {
                // per-key specs: [[speed, inf], ...]
                var s = spec[Math.min(keyPos, spec.length - 1)];
                arr.push(mk(s[0], s[1]));
            } else {
                // [speed, influence] or [speed]
                arr.push(mk(spec[0], spec.length > 1 ? spec[1] : undefined));
            }
        } else if (typeof spec === "number") {
            arr.push(mk(spec, undefined));
        } else {
            arr.push(mk(0, undefined));
        }
        while (arr.length < dim) arr.push(arr[0]);
        return arr.slice(0, dim);
    }

    function currentEase(prop, idx, dim) {
        var arr = [];
        try {
            var e = prop.keyTemporalEase(idx);
            for (var i = 0; i < dim; i++) {
                var src = (i < e.length) ? e[i] : e[e.length - 1];
                arr.push(new KeyframeEase(Number(src.speed), Number(src.influence)));
            }
        } catch (eCur) {
            for (var j = 0; j < dim; j++) arr.push(new KeyframeEase(0, 33.3333));
        }
        return arr;
    }

    T["keyframe_set_spatial"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        if (!a.path) throw H.err("path is required", "BAD_ARGS");
        var prop = H.propByPath(layer, a.path);
        var indices = [];
        if (a.indices !== undefined && a.indices !== null) {
            for (var i = 0; i < a.indices.length; i++) indices.push(Math.round(Number(a.indices[i])));
        } else {
            for (var k = 1; k <= prop.numKeys; k++) indices.push(k);
        }
        var changed = 0;
        for (var j = 0; j < indices.length; j++) {
            var idx = indices[j];
            if (idx < 1 || idx > prop.numKeys) continue;
            if (a.spatial_auto_bezier !== undefined) {
                try { prop.setSpatialAutoBezierAtKey(idx, H.bool(a.spatial_auto_bezier)); changed++; } catch (eAB) { }
            }
            if (a.tangent_in !== undefined || a.tangent_out !== undefined) {
                try {
                    var tin = a.tangent_in !== undefined ? H.numArr(a.tangent_in) : null;
                    var tout = a.tangent_out !== undefined ? H.numArr(a.tangent_out) : null;
                    prop.setSpatialTangentsAtKey(idx, tin, tout);
                    changed++;
                } catch (eTg) { }
            }
        }
        return { changed: changed, num_keys: prop.numKeys };
    };

    T["keyframe_shift"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        if (!a.path) throw H.err("path is required", "BAD_ARGS");
        var delta = Number(a.delta_s);
        if (isNaN(delta) || delta === 0) throw H.err("delta_s must be a non-zero number", "BAD_ARGS");
        var prop = H.propByPath(layer, a.path);
        var rangeLo = (a.range instanceof Array) ? Number(a.range[0]) : -Infinity;
        var rangeHi = (a.range instanceof Array) ? Number(a.range[1]) : Infinity;
        // capture in-range keys
        var captured = [];
        for (var i = 1; i <= prop.numKeys; i++) {
            var t = Number(prop.keyTime(i));
            if (t < rangeLo || t > rangeHi) continue;
            var rec = { time: t, value: H.serializeValue(prop, t) };
            try { rec.in_interp = String(prop.keyInInterpolationType(i)); } catch (e1) { }
            try { rec.out_interp = String(prop.keyOutInterpolationType(i)); } catch (e2) { }
            try { rec.ease_in = prop.keyTemporalEase(i); } catch (e3) { }
            try { rec.ease_out = prop.keyTemporalEase(i); } catch (e4) { }
            captured.push(rec);
        }
        if (captured.length === 0) return { shifted: 0, num_keys: prop.numKeys };
        // remove originals (descending)
        for (var k = prop.numKeys; k >= 1; k--) {
            var tt = Number(prop.keyTime(k));
            if (tt < rangeLo || tt > rangeHi) continue;
            prop.removeKey(k);
        }
        // re-add shifted, restoring interpolation + ease
        var im = interpMaps();
        var shifted = 0;
        for (var c = 0; c < captured.length; c++) {
            var rec2 = captured[c];
            prop.setValueAtTime(rec2.time + delta, rec2.value);
            var ni = prop.nearestKeyIndex(rec2.time + delta);
            try {
                var it = im[String(rec2.in_interp).toLowerCase()];
                var ot = im[String(rec2.out_interp).toLowerCase()];
                if (it && ot) prop.setInterpolationTypeAtKey(ni, it, ot);
            } catch (e5) { }
            try {
                if (rec2.ease_in && rec2.ease_out) {
                    prop.setTemporalEaseAtKey(ni, rec2.ease_in, rec2.ease_out);
                }
            } catch (e6) { }
            shifted++;
        }
        return { shifted: shifted, num_keys: prop.numKeys, delta_s: delta };
    };

    // -------------------------------------------------------------- expressions

    T["expression_set"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        if (!a.path) throw H.err("path is required", "BAD_ARGS");
        var prop = H.propByPath(layer, a.path);
        if (!prop.canSetExpression) throw H.err("Property '" + prop.matchName + "' cannot have an expression", "NOT_SUPPORTED");
        prop.expression = String(a.expression === undefined || a.expression === null ? "" : a.expression);
        var errText = "";
        try { errText = String(prop.expressionError); } catch (eE) { }
        var out = {
            set: true, path: String(prop.matchName),
            expression: String(prop.expression),
            error: errText === "" ? null : errText
        };
        return out;
    };

    T["expression_get"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        if (!a.path) throw H.err("path is required", "BAD_ARGS");
        var prop = H.propByPath(layer, a.path);
        var expr = "", err = "";
        try { expr = String(prop.expression); } catch (e1) { }
        try { err = String(prop.expressionError); } catch (e2) { }
        return { path: String(prop.matchName), expression: expr, error: err === "" ? null : err };
    };

    T["expression_remove"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        if (!a.path) throw H.err("path is required", "BAD_ARGS");
        var prop = H.propByPath(layer, a.path);
        prop.expression = "";
        return { removed: true, path: String(prop.matchName) };
    };

    T["expression_scan_errors"] = function (a) {
        var limit = Math.min(H.num(a.limit, 50), 200);
        var errors = [];
        var comps = [];
        if (a.comp !== undefined && a.comp !== null && a.comp !== "") {
            comps.push(H.compDefault(a.comp));
        } else {
            var p = H.requireProject();
            for (var i = 1; i <= p.numItems; i++) {
                if (p.item(i) instanceof CompItem) comps.push(p.item(i));
            }
        }
        for (var c = 0; c < comps.length && errors.length < limit; c++) {
            var comp = comps[c];
            for (var L = 1; L <= comp.numLayers && errors.length < limit; L++) {
                var layer = comp.layer(L);
                scanPropErrors(layer, String(layer.name), limit, errors, comp.name);
            }
        }
        return { errors_found: errors.length, errors: errors };
    };

    function scanPropErrors(group, path, limit, errors, compName) {
        if (errors.length >= limit) return;
        var n = 0;
        try { n = group.numProperties; } catch (eN) { return; }
        for (var i = 1; i <= n && errors.length < limit; i++) {
            var p;
            try { p = group.property(i); } catch (eP) { continue; }
            var isGroup = false;
            try { isGroup = (p.numProperties !== undefined && p.numProperties > 0); } catch (eG) { }
            if (isGroup) {
                scanPropErrors(p, path + "." + String(p.name), limit, errors, compName);
            } else {
                try {
                    var ex = String(p.expression);
                    if (ex.length > 0) {
                        var err = String(p.expressionError);
                        if (err.length > 0) {
                            errors.push({
                                comp: compName, layer: path.split(".")[0],
                                property: path + "." + String(p.name),
                                error: err.substring(0, 500)
                            });
                        }
                    }
                } catch (eE) { }
            }
        }
    }

    H.textDocFromStyle = textDocFromStyle;
    H.addShapeGroup = addShapeGroup;
    H.interpMaps = interpMaps;
    H.buildEaseArray = buildEaseArray;
})();

// ===========================================================================
// TOOLS PART 4: effects, text, shapes, masks, markers, time, render, footage, batch
// ===========================================================================
(function () {
    if (!$.global.AE_MCP_TOOLS || !$.global.AE_MCP_HELPERS) return;
    var T = $.global.AE_MCP_TOOLS;
    var H = $.global.AE_MCP_HELPERS;

    // ------------------------------------------------------------------ effects

    var COMMON_EFFECTS = [
        ["ADBE Gaussian Blur 2", "Gaussian Blur", "Blur & Sharpen"],
        ["ADBE Camera Lens Blur", "Camera Lens Blur", "Blur & Sharpen"],
        ["ADBE Motion Blur", "Directional Blur", "Blur & Sharpen"],
        ["ADBE Radial Blur", "Radial Blur", "Blur & Sharpen"],
        ["ADBE Sharpen", "Sharpen", "Blur & Sharpen"],
        ["ADBE Unsharp Mask2", "Unsharp Mask", "Blur & Sharpen"],
        ["ADBE Brightness Contrast", "Brightness & Contrast", "Color Correction"],
        ["ADBE CurvesCustom", "Curves", "Color Correction"],
        ["ADBE Color Balance", "Color Balance", "Color Correction"],
        ["ADBE Vibrance", "Vibrance", "Color Correction"],
        ["ADBE HUE SATURATION", "Hue/Saturation", "Color Correction"],
        ["ADBE Pro Levels2", "Levels", "Color Correction"],
        ["ADBE Easy Levels2", "Levels (Individual Controls)", "Color Correction"],
        ["ADBE Tint", "Tint", "Color Correction"],
        ["ADBE Tritone", "Tritone", "Color Correction"],
        ["ADBE Fill", "Fill", "Generate"],
        ["ADBE Ramp", "Gradient Ramp", "Generate"],
        ["ADBE 4ColorGradient", "4-Color Gradient", "Generate"],
        ["ADBE Grid", "Grid", "Generate"],
        ["ADBE Lens Flare", "Lens Flare", "Generate"],
        ["ADBE Glow", "Glow", "Stylize"],
        ["ADBE Drop Shadow", "Drop Shadow", "Perspective"],
        ["ADBE Radial Shadow", "Radial Shadow", "Perspective"],
        ["ADBE 3D Glasses", "3D Glasses", "Channel"],
        ["ADBE Venice", "Venetian Blinds", "Transition"],
        ["ADBE Linear Wipe", "Linear Wipe", "Transition"],
        ["ADBE Slide", "Slide", "Transition"],
        ["ADBE Time Displacement", "Time Displacement", "Time"],
        ["ADBE Echo", "Echo", "Time"],
        ["ADBE Posterize Time", "Posterize Time", "Time"],
        ["ADBE Wiggle Positions", "Wiggle Transform/Positions", "Distort"],
        ["ADBE Displacement Map", "Displacement Map", "Distort"],
        ["ADBE Turbulent Displace", "Turbulent Displace", "Distort"],
        ["ADBE Wave Warp", "Wave Warp", "Distort"],
        ["ADBE Warp", "Warp", "Distort"],
        ["ADBE Mirror", "Mirror", "Distort"],
        ["ADBE Transform", "Transform", "Distort"],
        ["ADBE Tile", "Motion Tile", "Stylize"],
        ["ADBE Fractal", "Fractal Noise", "Noise & Grain"],
        ["ADBE Noise", "Noise", "Noise & Grain"],
        ["ADBE Roughen Edges", "Roughen Edges", "Stylize"],
        ["ADBE Mosaic", "Mosaic", "Stylize"],
        ["ADBE Emitter", "CC Particle World", "Simulation"],
        ["ADBE Solid Composite", "Solid Composite", "Channel"],
        ["ADBE Remove Grain2", "Remove Grain", "Noise & Grain"],
        ["ADBE Channel Blur", "Channel Blur", "Blur & Sharpen"]
    ];

    T["effect_add"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        var fx = layer.property("ADBE Effect Parade");
        var matchName = H.str(a.match_name, null);
        if (!matchName) {
            var want = H.str(a.name, "");
            if (!want) throw H.err("Provide match_name or name", "BAD_ARGS");
            // try AE 2024+ app.effects registry for an exact-ish match
            try {
                if (typeof app.effects !== "undefined" && app.effects) {
                    var wl = want.toLowerCase();
                    var best = null;
                    for (var i = 0; i < app.effects.length; i++) {
                        var dn = String(app.effects[i].displayName).toLowerCase();
                        if (dn === wl) { best = app.effects[i].matchName; break; }
                        if (!best && dn.indexOf(wl) >= 0) best = app.effects[i].matchName;
                    }
                    if (best) matchName = best;
                }
            } catch (eAE) { }
            if (!matchName) matchName = want; // let AE resolve display names directly
        }
        var effect;
        try {
            if (a.index !== undefined && a.index !== null) {
                effect = fx.addProperty(matchName, Math.max(1, Math.round(Number(a.index))));
            } else {
                effect = fx.addProperty(matchName);
            }
        } catch (eAdd) {
            throw H.err("Cannot add effect '" + matchName + "': " + String(eAdd.message || eAdd) +
                ". Use effect_list_installed to find the exact matchName.", "NOT_FOUND");
        }
        var applied = [];
        if (a.params && typeof a.params === "object") {
            applied = applyEffectParams(effect, a.params, comp);
        }
        return { added: true, effect: { index: fx.numProperties, name: String(effect.name), match_name: String(effect.matchName) }, params_applied: applied };
    };

    function findEffectParam(effect, key) {
        try {
            var byMn = effect.property(String(key));
            if (byMn) return byMn;
        } catch (e1) { }
        var lower = String(key).toLowerCase();
        for (var i = 1; i <= effect.numProperties; i++) {
            var p = effect.property(i);
            if (String(p.name).toLowerCase() === lower || String(p.matchName).toLowerCase() === lower) return p;
        }
        var hits = [];
        for (var j = 1; j <= effect.numProperties; j++) {
            var q = effect.property(j);
            if (String(q.name).toLowerCase().indexOf(lower) >= 0) hits.push(q);
        }
        if (hits.length === 1) return hits[0];
        return null;
    }

    function applyEffectParams(effect, params, comp) {
        var applied = [], failed = [];
        for (var key in params) {
            if (!params.hasOwnProperty(key)) continue;
            var p = findEffectParam(effect, key);
            if (!p) { failed.push({ param: key, reason: "not found" }); continue; }
            if (p.numProperties !== undefined && p.numProperties !== null && p.numProperties > 0) {
                failed.push({ param: key, reason: "is a group" });
                continue;
            }
            try {
                var spec = params[key];
                var wantKey = false, t = comp.time, value = spec;
                if (spec && typeof spec === "object" && !(spec instanceof Array) &&
                    (spec.value !== undefined || spec.keyframe !== undefined || spec.time_s !== undefined)) {
                    value = spec.value;
                    wantKey = H.bool(spec.keyframe, false);
                    if (spec.time_s !== undefined) t = Number(spec.time_s);
                }
                if (wantKey) {
                    if (!propCanVary(p)) throw H.err("cannot keyframe");
                    p.setValueAtTime(t, coerceParamValue(p, value));
                } else {
                    p.setValue(coerceParamValue(p, value));
                }
                applied.push(key);
            } catch (eSet) {
                failed.push({ param: key, reason: String(eSet.message || eSet) });
            }
        }
        return { applied: applied, failed: failed };
    }

    function propCanVary(p) {
        try { return !!p.canVaryOverTime; } catch (eV) { return false; }
    }

    function coerceParamValue(p, value) {
        var vt = null;
        try { vt = p.propertyValueType; } catch (eV) { }
        if (vt === PropertyValueType.COLOR) return H.color(value);
        if (vt === PropertyValueType.TwoD || vt === PropertyValueType.TwoD_SPATIAL ||
            vt === PropertyValueType.ThreeD || vt === PropertyValueType.ThreeD_SPATIAL) return H.numArr(value);
        if (vt === PropertyValueType.BooleanValue) return H.bool(value);
        if (vt === PropertyValueType.OneD) return Number(value);
        return value;
    }

    T["effect_remove"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        var fx = layer.property("ADBE Effect Parade");
        if (H.bool(a.all, false)) {
            var n = fx.numProperties;
            while (fx.numProperties > 0) fx.property(fx.numProperties).remove();
            return { removed: n };
        }
        if (a.effect === undefined || a.effect === null) throw H.err("effect or all=true is required", "BAD_ARGS");
        var e;
        if (typeof a.effect === "number" || /^[0-9]+$/.test(String(a.effect))) {
            var idx = Number(a.effect);
            if (idx < 1 || idx > fx.numProperties) throw H.err("Effect index out of range", "OUT_OF_RANGE");
            e = fx.property(idx);
        } else {
            e = findEffectParam(fx, String(a.effect));
        }
        if (!e) throw H.err("Effect not found: " + a.effect, "NOT_FOUND");
        var name = String(e.name);
        e.remove();
        return { removed: true, name: name };
    };

    T["effect_list_installed"] = function (a) {
        var contains = H.str(a.name_contains, null);
        if (contains) contains = contains.toLowerCase();
        var cat = H.str(a.category_contains, null);
        if (cat) cat = cat.toLowerCase();
        var limit = Math.min(H.num(a.limit, 200), 1000);
        var out = [];
        try {
            if (typeof app.effects !== "undefined" && app.effects) {
                for (var i = 0; i < app.effects.length && out.length < limit; i++) {
                    var e = app.effects[i];
                    var row = { match_name: String(e.matchName), name: String(e.displayName), category: String(e.category || "") };
                    if (contains && String(row.name).toLowerCase().indexOf(contains) < 0 &&
                        String(row.match_name).toLowerCase().indexOf(contains) < 0) continue;
                    if (cat && String(row.category).toLowerCase().indexOf(cat) < 0) continue;
                    out.push(row);
                }
                if (out.length > 0) return { source: "app.effects", count: out.length, effects: out };
            }
        } catch (eAE) { }
        for (var k = 0; k < COMMON_EFFECTS.length && out.length < limit; k++) {
            var row2 = { match_name: COMMON_EFFECTS[k][0], name: COMMON_EFFECTS[k][1], category: COMMON_EFFECTS[k][2] };
            if (contains && String(row2.name).toLowerCase().indexOf(contains) < 0 &&
                String(row2.match_name).toLowerCase().indexOf(contains) < 0) continue;
            if (cat && String(row2.category).toLowerCase().indexOf(cat) < 0) continue;
            out.push(row2);
        }
        return { source: "curated_common_list", count: out.length, effects: out };
    };

    function effectGroupParams(group, depth, count) {
        var items = [];
        var n = 0;
        try { n = group.numProperties; } catch (eN) { return items; }
        for (var i = 1; i <= n && count.n < 200; i++) {
            var p;
            try { p = group.property(i); } catch (eP) { continue; }
            count.n++;
            var isGroup = false;
            try { isGroup = (p.numProperties !== undefined && p.numProperties > 0); } catch (eG) { }
            var o = { index: i, name: String(p.name), match_name: String(p.matchName) };
            if (isGroup) {
                o.type = "group";
                if (depth < 3) o.children = effectGroupParams(p, depth + 1, count);
            } else {
                try { o.type = String(p.propertyValueType); } catch (eT) { }
                try { o.num_keys = p.numKeys; } catch (eK) { }
                try { o.value = H.serializeValue(p); } catch (eV) { }
            }
            items.push(o);
        }
        return items;
    }

    T["effect_get_params"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        var fx = layer.property("ADBE Effect Parade");
        var e = resolveEffect(fx, a.effect);
        var count = { n: 0 };
        var params = effectGroupParams(e, 0, count);
        return { effect: { index: e.propertyGroupIndex !== undefined ? null : null, name: String(e.name), match_name: String(e.matchName) }, num_params: count.n, params: params };
    };

    function resolveEffect(fx, sel) {
        if (sel === undefined || sel === null || sel === "") {
            if (fx.numProperties === 0) throw H.err("Layer has no effects", "NOT_FOUND");
            return fx.property(1);
        }
        if (typeof sel === "number" || /^[0-9]+$/.test(String(sel))) {
            var idx = Number(sel);
            if (idx < 1 || idx > fx.numProperties) throw H.err("Effect index out of range", "OUT_OF_RANGE");
            return fx.property(idx);
        }
        var e = findEffectParam(fx, String(sel));
        if (!e) throw H.err("Effect not found: " + sel, "NOT_FOUND");
        return e;
    }

    T["effect_set_params"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        var fx = layer.property("ADBE Effect Parade");
        var e = resolveEffect(fx, a.effect);
        if (!a.params || typeof a.params !== "object") throw H.err("params object is required", "BAD_ARGS");
        var res = applyEffectParams(e, a.params, comp);
        return { effect: { name: String(e.name), match_name: String(e.matchName) }, params_applied: res.applied, params_failed: res.failed };
    };

    // -------------------------------------------------------------------- text

    T["text_set_content"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        if (H.layerTypeName(layer) !== "text") throw H.err("Layer '" + layer.name + "' is not a text layer", "NOT_TEXT");
        var prop = layer.property("ADBE Text Document");
        if (H.bool(a.set_keyframe, false)) {
            var td = prop.value;
            td.text = String(a.text === undefined || a.text === null ? "" : a.text);
            prop.setValueAtTime(comp.time, td);
        } else {
            var td2 = prop.value;
            td2.text = String(a.text === undefined || a.text === null ? "" : a.text);
            prop.setValue(td2);
        }
        return { set: true, text: String(a.text), layer: String(layer.name) };
    };

    T["text_set_style"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        if (H.layerTypeName(layer) !== "text") throw H.err("Layer '" + layer.name + "' is not a text layer", "NOT_TEXT");
        var prop = layer.property("ADBE Text Document");
        var td = prop.value;
        td = H.textDocFromStyle(td, a);
        if (H.bool(a.set_keyframe, false)) prop.setValueAtTime(comp.time, td);
        else prop.setValue(td);
        var changed = [];
        if (a.font !== undefined) changed.push("font");
        if (a.font_size !== undefined) changed.push("font_size");
        if (a.fill_color !== undefined) changed.push("fill_color");
        if (a.stroke_color !== undefined || a.stroke_width !== undefined) changed.push("stroke");
        if (a.tracking !== undefined) changed.push("tracking");
        if (a.leading !== undefined) changed.push("leading");
        if (a.justification !== undefined) changed.push("justification");
        if (a.baseline_shift !== undefined) changed.push("baseline_shift");
        if ((a.box_width !== undefined || a.box_height !== undefined) && td.boxText) {
            var bs = td.boxTextSize;
            if (a.box_width !== undefined) bs[0] = Number(a.box_width);
            if (a.box_height !== undefined) bs[1] = Number(a.box_height);
            td.boxTextSize = bs;
            changed.push("box_size");
        }
        return { changed: changed, text: H.serializeTextDoc(td) };
    };

    T["text_list_fonts"] = function (a) {
        var contains = H.str(a.name_contains, null);
        if (contains) contains = contains.toLowerCase();
        var limit = Math.min(H.num(a.limit, 100), 500);
        var fonts = [];
        try {
            var server = app.fonts; // AE 2024+
            var list = null;
            try { list = server.allFonts; } catch (eAF) { list = null; }
            if (list === null || list === undefined) {
                // some builds expose app.fonts as the array itself
                if (server.length !== undefined) list = server;
            }
            if (list) {
                for (var i = 0; i < list.length && fonts.length < limit; i++) {
                    var f = list[i];
                    var row = {
                        post_script_name: String(f.postScriptName),
                        family: String(f.familyName),
                        style: String(f.styleName || f.style || "")
                    };
                    if (contains &&
                        String(row.family).toLowerCase().indexOf(contains) < 0 &&
                        String(row.post_script_name).toLowerCase().indexOf(contains) < 0) continue;
                    fonts.push(row);
                }
                return { source: "app.fonts", count: fonts.length, fonts: fonts };
            }
        } catch (eFonts) { }
        var common = [
            ["ArialMT", "Arial", "Regular"], ["Arial-BoldMT", "Arial", "Bold"], ["Arial-ItalicMT", "Arial", "Italic"],
            ["Arial-Black", "Arial", "Black"], ["ArialNarrow", "Arial Narrow", "Regular"],
            ["Calibri", "Calibri", "Regular"], ["Calibri-Bold", "Calibri", "Bold"],
            ["SegoeUI", "Segoe UI", "Regular"], ["SegoeUI-Bold", "Segoe UI", "Bold"], ["SegoeUI-Light", "Segoe UI", "Light"],
            ["Tahoma", "Tahoma", "Regular"], ["Tahoma-Bold", "Tahoma", "Bold"],
            ["Verdana", "Verdana", "Regular"], ["Verdana-Bold", "Verdana", "Bold"],
            ["TimesNewRomanPSMT", "Times New Roman", "Regular"], ["TimesNewRomanPS-BoldMT", "Times New Roman", "Bold"],
            ["Georgia", "Georgia", "Regular"], ["Georgia-Bold", "Georgia", "Bold"],
            ["Impact", "Impact", "Regular"], ["CourierNewPSMT", "Courier New", "Regular"],
            ["CourierNewPS-BoldMT", "Courier New", "Bold"], ["Consolas", "Consolas", "Regular"],
            ["TrebuchetMS", "Trebuchet MS", "Regular"], ["TrebuchetMS-Bold", "Trebuchet MS", "Bold"],
            ["Cambria", "Cambria", "Regular"], ["Candara", "Candara", "Regular"],
            ["FranklinGothic-Medium", "Franklin Gothic Medium", "Regular"],
            ["LucidaConsole", "Lucida Console", "Regular"], ["MicrosoftSansSerif", "Microsoft Sans Serif", "Regular"],
            ["PalatinoLinotype-Roman", "Palatino Linotype", "Regular"], ["Rockwell-Regular", "Rockwell", "Regular"]
        ];
        for (var k = 0; k < common.length && fonts.length < limit; k++) {
            var row2 = { post_script_name: common[k][0], family: common[k][1], style: common[k][2] };
            if (contains &&
                String(row2.family).toLowerCase().indexOf(contains) < 0 &&
                String(row2.post_script_name).toLowerCase().indexOf(contains) < 0) continue;
            fonts.push(row2);
        }
        return {
            source: "curated_common_list",
            count: fonts.length, fonts: fonts,
            note: "This AE build does not expose app.fonts - list contains universal Windows fonts. Pass the PostScript name as the 'font' argument."
        };
    };

    var TEXT_ANIMATOR_PROPS = {
        "opacity": "ADBE Text Animator Opacity",
        "position": "ADBE Text Animator Position",
        "rotation": "ADBE Text Rotation",
        "scale": "ADBE Text Scale",
        "tracking": "ADBE Text Tracking",
        "fill_color": "ADBE Text Fill Color",
        "stroke_color": "ADBE Text Stroke Color",
        "blur": "ADBE Text Blur"
    };

    T["text_add_animator"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        if (H.layerTypeName(layer) !== "text") throw H.err("Layer '" + layer.name + "' is not a text layer", "NOT_TEXT");
        if (!(a.properties instanceof Array) || a.properties.length === 0) {
            throw H.err("properties must be a non-empty array", "BAD_ARGS");
        }
        var animators = layer.property("ADBE Text Animators");
        var animator = animators.addProperty("ADBE Text Animator");
        animator.name = H.str(a.animator_name, "Animator " + animators.numProperties);
        var propsGroup = animator.property("ADBE Text Animator Properties");
        var values = (a.values && typeof a.values === "object") ? a.values : {};
        var added = [];
        for (var i = 0; i < a.properties.length; i++) {
            var key = String(a.properties[i]).toLowerCase();
            var mn = TEXT_ANIMATOR_PROPS[key];
            if (!mn) throw H.err("Unknown animator property '" + a.properties[i] + "'", "BAD_ARGS");
            var p = propsGroup.addProperty(mn);
            if (values[key] !== undefined) {
                try {
                    var vt = p.propertyValueType;
                    if (vt === PropertyValueType.COLOR) p.setValue(H.color(values[key]));
                    else if (vt === PropertyValueType.OneD) p.setValue(Number(values[key]));
                    else p.setValue(H.numArr(values[key]));
                } catch (eVal) { }
            }
            added.push(key);
        }
        var selector = animator.property("ADBE Text Selectors").addProperty("ADBE Text Selector");
        var rs = H.num(a.range_start, 0), re = H.num(a.range_end, 100), ro = H.num(a.range_offset, 0);
        try { selector.property("ADBE Text Range Start").setValue(rs); } catch (eS) { }
        try { selector.property("ADBE Text Range End").setValue(re); } catch (eE) { }
        try { selector.property("ADBE Text Range Offset").setValue(ro); } catch (eO) { }
        var shapeMap = {
            "square": 1, "ramp_up": 2, "ramp_down": 3, "triangle": 4, "round": 5, "smooth": 6
        };
        var shapeName = String(H.str(a.shape, "square")).toLowerCase();
        try {
            if (shapeMap[shapeName] !== undefined) {
                selector.property("ADBE Text Range Advanced").property("ADBE Text Range Advanced Shape").setValue(shapeMap[shapeName]);
            }
        } catch (eSh) { }
        return {
            added: true, animator: String(animator.name), properties: added,
            hint: "Keyframe range with keyframe_set path '" + animator.name + ".Range Selector.Start' (or .Offset)"
        };
    };

    // ------------------------------------------------------------------- shapes

    T["shape_add"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = null;
        if (a.layer !== undefined && a.layer !== null && a.layer !== "") {
            layer = H.layerBySel(comp, a.layer);
        } else {
            // first shape layer in the comp, else create one
            for (var i = 1; i <= comp.numLayers; i++) {
                if (comp.layer(i) instanceof ShapeLayer) { layer = comp.layer(i); break; }
            }
            if (!layer) {
                layer = comp.layers.addShape();
                if (a.name !== undefined && a.name !== null && a.name !== "") layer.name = String(a.name);
            }
        }
        var group = H.addShapeGroup(comp, a, layer);
        return { added: true, group: String(group.name), layer: H.layerSummary(layer) };
    };

    function shapeGroups(layer) {
        var root = layer.property("ADBE Root Vectors Group");
        var out = [];
        for (var i = 1; i <= root.numProperties; i++) {
            var p = root.property(i);
            if (String(p.matchName) === "ADBE Vector Group") out.push(p);
        }
        return out;
    }

    function resolveGroup(layer, sel) {
        var groups = shapeGroups(layer);
        if (groups.length === 0) throw H.err("Shape layer has no groups", "NOT_FOUND");
        if (sel === undefined || sel === null || sel === "") return groups; // all
        var one = (typeof sel === "number" || /^[0-9]+$/.test(String(sel)))
            ? groups[Number(sel) - 1] : null;
        if (!one) {
            for (var i = 0; i < groups.length; i++) {
                if (String(groups[i].name) === String(sel)) one = groups[i];
            }
        }
        if (!one) throw H.err("Group not found: " + sel, "NOT_FOUND");
        return [one];
    }

    T["shape_set_fill"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        var groups = resolveGroup(layer, a.group);
        var changed = [];
        for (var i = 0; i < groups.length; i++) {
            var contents = groups[i].property("ADBE Vectors Group");
            var fill = null;
            for (var j = 1; j <= contents.numProperties; j++) {
                if (String(contents.property(j).matchName) === "ADBE Vector Graphic - Fill") fill = contents.property(j);
            }
            if (!fill) {
                fill = contents.addProperty("ADBE Vector Graphic - Fill");
            }
            if (a.color !== undefined) fill.property("ADBE Vector Fill Color").setValue(H.color(a.color));
            if (a.opacity !== undefined) fill.property("ADBE Vector Fill Opacity").setValue(Number(a.opacity));
            changed.push(String(groups[i].name));
        }
        return { changed: changed };
    };

    T["shape_set_stroke"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        var groups = resolveGroup(layer, a.group);
        var changed = [];
        for (var i = 0; i < groups.length; i++) {
            var contents = groups[i].property("ADBE Vectors Group");
            var stroke = null;
            for (var j = 1; j <= contents.numProperties; j++) {
                if (String(contents.property(j).matchName) === "ADBE Vector Graphic - Stroke") stroke = contents.property(j);
            }
            if (!stroke) {
                if (a.width === undefined && a.color === undefined) continue; // nothing to create with
                stroke = contents.addProperty("ADBE Vector Graphic - Stroke");
            }
            if (a.color !== undefined) stroke.property("ADBE Vector Stroke Color").setValue(H.color(a.color));
            if (a.width !== undefined) stroke.property("ADBE Vector Stroke Width").setValue(Number(a.width));
            if (a.opacity !== undefined) stroke.property("ADBE Vector Stroke Opacity").setValue(Number(a.opacity));
            var capMap = { "butt": 1, "round": 2, "projecting": 3 };
            if (a.line_cap !== undefined && capMap[String(a.line_cap).toLowerCase()] !== undefined) {
                stroke.property("ADBE Vector Stroke Line Cap").setValue(capMap[String(a.line_cap).toLowerCase()]);
            }
            var joinMap = { "miter": 1, "round": 2, "bevel": 3 };
            if (a.line_join !== undefined && joinMap[String(a.line_join).toLowerCase()] !== undefined) {
                stroke.property("ADBE Vector Stroke Line Join").setValue(joinMap[String(a.line_join).toLowerCase()]);
            }
            if (a.dashes !== undefined) {
                try {
                    var dashes = a.dashes instanceof Array ? a.dashes : [];
                    var dashProp = stroke.property("ADBE Vector Stroke Dashes");
                    var want = dashes.length;
                    var have = dashProp.numProperties;
                    while (have < want) { dashProp.addProperty("ADBE Vector Stroke Dash"); have++; }
                    while (have > want) { dashProp.property(have).remove(); have--; }
                    for (var d = 1; d <= dashProp.numProperties; d++) {
                        dashProp.property(d).property("ADBE Vector Stroke Dash Size").setValue(Number(dashes[d - 1]));
                    }
                } catch (eD) { }
            }
            changed.push(String(groups[i].name));
        }
        return { changed: changed };
    };

    var SHAPE_MODIFIERS = {
        "trim_paths": "ADBE Vector Filter - Trim",
        "round_corners": "ADBE Vector Filter - RoundCorners",
        "repeater": "ADBE Vector Filter - Repeater",
        "wiggle_paths": "ADBE Vector Filter - Wiggle",
        "zig_zag": "ADBE Vector Filter - Zigzag",
        "offset_paths": "ADBE Vector Filter - Offset",
        "pucker_bloat": "ADBE Vector Filter - Pucker & Bloat",
        "twist": "ADBE Vector Filter - Twist",
        "merge_paths": "ADBE Vector Filter - Merge"
    };

    T["shape_add_modifier"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        var kind = String(H.str(a.modifier, "")).toLowerCase();
        var mn = SHAPE_MODIFIERS[kind];
        if (!mn) {
            var keys = [];
            for (var k in SHAPE_MODIFIERS) { if (SHAPE_MODIFIERS.hasOwnProperty(k)) keys.push(k); }
            throw H.err("Unknown modifier '" + kind + "'. Valid: " + keys.join(", "), "BAD_ARGS");
        }
        var parent = layer.property("ADBE Root Vectors Group");
        if (a.group !== undefined && a.group !== null && a.group !== "") {
            var gs = resolveGroup(layer, a.group);
            parent = gs[0].property("ADBE Vectors Group");
        }
        var mod = parent.addProperty(mn);
        if (a.params && typeof a.params === "object") {
            for (var key in a.params) {
                if (!a.params.hasOwnProperty(key)) continue;
                try {
                    var p = findEffectParam(mod, key);
                    if (p && (p.numProperties === undefined || p.numProperties === 0)) {
                        p.setValue(coerceParamValue(p, a.params[key]));
                    }
                } catch (eSet) { }
            }
        }
        return { added: true, modifier: kind, match_name: String(mod.matchName), name: String(mod.name) };
    };

    // -------------------------------------------------------------------- masks

    function maskShapeFromArgs(a) {
        var shape = new Shape();
        if (a.vertices instanceof Array && a.vertices.length >= 2) {
            var vs = [], ins = [], outs = [];
            for (var i = 0; i < a.vertices.length; i++) {
                vs.push([Number(a.vertices[i][0]), Number(a.vertices[i][1])]);
                var iv = (a.in_tangents instanceof Array && a.in_tangents[i]) ? [Number(a.in_tangents[i][0]), Number(a.in_tangents[i][1])] : [0, 0];
                var ov = (a.out_tangents instanceof Array && a.out_tangents[i]) ? [Number(a.out_tangents[i][0]), Number(a.out_tangents[i][1])] : [0, 0];
                ins.push(iv);
                outs.push(ov);
            }
            shape.vertices = vs;
            shape.inTangents = ins;
            shape.outTangents = outs;
            shape.closed = H.bool(a.closed, true);
        } else {
            var b = H.numArr(a.bounds !== undefined ? a.bounds : [0, 0, 100, 100]);
            var left = b[0], top = b[1], w = b[2], h = b[3];
            var kind = String(H.str(a.shape_type, "rect")).toLowerCase();
            shape.vertices = [[left, top], [left + w, top], [left + w, top + h], [left, top + h]];
            shape.inTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
            shape.outTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
            shape.closed = true;
            if (kind === "ellipse") {
                // approximate ellipse with 4 bezier arcs (standard kappa handles)
                var kx = w * 0.5523 / 2, ky = h * 0.5523 / 2;
                var cx = left + w / 2, cy = top + h / 2;
                shape.vertices = [[cx, top], [left + w, cy], [cx, top + h], [left, cy]];
                shape.inTangents = [[-kx, 0], [0, -ky], [kx, 0], [0, ky]];
                shape.outTangents = [[kx, 0], [0, ky], [-kx, 0], [0, -ky]];
            }
        }
        return shape;
    }

    function applyMaskProps(mask, a) {
        var modeMap = {
            "add": MaskMode.ADD, "subtract": MaskMode.SUBTRACT, "intersect": MaskMode.INTERSECT,
            "lighten": MaskMode.LIGHTEN, "darken": MaskMode.DARKEN, "difference": MaskMode.DIFFERENCE,
            "none": MaskMode.NONE
        };
        if (a.mask_mode !== undefined) {
            var mm = modeMap[String(a.mask_mode).toLowerCase()];
            if (mm !== undefined) mask.maskMode = mm;
        }
        if (a.inverted !== undefined) mask.inverted = H.bool(a.inverted);
        if (a.mask_name !== undefined && a.mask_name !== null && a.mask_name !== "") mask.name = String(a.mask_name);
        try {
            if (a.feather !== undefined) mask.property("ADBE Mask Feather").setValue(H.numArr(a.feather));
            if (a.opacity !== undefined) mask.property("ADBE Mask Opacity").setValue(Number(a.opacity));
            if (a.expansion !== undefined) mask.property("ADBE Mask Offset").setValue(Number(a.expansion));
        } catch (eProps) { }
    }

    T["mask_add"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        var parade = layer.property("ADBE Mask Parade");
        var mask = parade.addProperty("Mask");
        var shape = maskShapeFromArgs(a);
        mask.property("ADBE Mask Shape").setValue(shape);
        applyMaskProps(mask, a);
        return { added: true, mask: { index: mask.propertyIndex, name: String(mask.name) } };
    };

    T["mask_update"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        var parade = layer.property("ADBE Mask Parade");
        var mask;
        if (a.mask === undefined || a.mask === null || a.mask === "") {
            if (parade.numProperties === 0) throw H.err("Layer has no masks", "NOT_FOUND");
            mask = parade.property(1);
        } else if (typeof a.mask === "number" || /^[0-9]+$/.test(String(a.mask))) {
            var idx = Number(a.mask);
            if (idx < 1 || idx > parade.numProperties) throw H.err("Mask index out of range", "OUT_OF_RANGE");
            mask = parade.property(idx);
        } else {
            mask = findEffectParam(parade, String(a.mask));
        }
        if (!mask) throw H.err("Mask not found", "NOT_FOUND");
        if (a.bounds !== undefined || a.vertices !== undefined) {
            mask.property("ADBE Mask Shape").setValue(maskShapeFromArgs(a));
        }
        applyMaskProps(mask, a);
        return { updated: true, mask: { index: mask.propertyIndex, name: String(mask.name) } };
    };

    T["mask_remove"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        var parade = layer.property("ADBE Mask Parade");
        if (H.bool(a.all, false)) {
            var n = parade.numProperties;
            while (parade.numProperties > 0) parade.property(parade.numProperties).remove();
            return { removed: n };
        }
        if (a.mask === undefined || a.mask === null) throw H.err("mask or all=true is required", "BAD_ARGS");
        var mask = (typeof a.mask === "number" || /^[0-9]+$/.test(String(a.mask)))
            ? parade.property(Number(a.mask))
            : findEffectParam(parade, String(a.mask));
        if (!mask) throw H.err("Mask not found", "NOT_FOUND");
        var name = String(mask.name);
        mask.remove();
        return { removed: true, name: name };
    };

    // ------------------------------------------------------------------ markers

    function markerTarget(a) {
        var comp = H.compDefault(a.comp);
        if (String(H.str(a.target, "comp")).toLowerCase() === "layer") {
            var layer = H.layerDefault(comp, a.layer);
            return { prop: layer.property("ADBE Marker"), kind: "layer", layer: String(layer.name) };
        }
        return { prop: comp.markerProperty, kind: "comp", layer: null };
    }

    T["marker_add"] = function (a) {
        var tgt = markerTarget(a);
        var mv = new MarkerValue(String(H.str(a.comment, "")));
        try { if (a.chapter !== undefined) mv.chapter = String(a.chapter); } catch (e1) { }
        try { if (a.url !== undefined) mv.url = String(a.url); } catch (e2) { }
        try { if (a.duration_s !== undefined) mv.duration = Number(a.duration_s); } catch (e3) { }
        try { if (a.cue_point_name !== undefined) mv.cuePointName = String(a.cue_point_name); } catch (e4) { }
        var t = (a.time_s !== undefined) ? Number(a.time_s) : 0;
        tgt.prop.setValueAtTime(t, mv);
        return { added: true, target: tgt.kind, layer: tgt.layer, time_s: t, num_markers: tgt.prop.numKeys };
    };

    T["marker_list"] = function (a) {
        var comp = H.compDefault(a.comp);
        var out = { comp: H.compSummary(comp), comp_markers: H.serializeMarkers(comp.markerProperty), layer_markers: {} };
        if (H.bool(a.include_layers, false)) {
            for (var i = 1; i <= comp.numLayers; i++) {
                var layer = comp.layer(i);
                var ms = H.serializeMarkers(layer.property("ADBE Marker"));
                if (ms.length > 0) out.layer_markers[String(layer.name)] = ms;
            }
        }
        return out;
    };

    T["marker_remove"] = function (a) {
        var tgt = markerTarget(a);
        var removed = 0;
        if (a.indices !== undefined && a.indices !== null) {
            var idxs = [];
            for (var i = 0; i < a.indices.length; i++) idxs.push(Math.round(Number(a.indices[i])));
            idxs.sort(function (x, y) { return y - x; });
            for (var j = 0; j < idxs.length; j++) {
                if (idxs[j] >= 1 && idxs[j] <= tgt.prop.numKeys) { tgt.prop.removeKey(idxs[j]); removed++; }
            }
        } else if (a.time_s !== undefined) {
            var t = Number(a.time_s);
            var half = 0.5 / 30;
            try { var comp = H.compDefault(a.comp); half = 0.5 / comp.frameRate; } catch (eC) { }
            for (var k = 1; k <= tgt.prop.numKeys; k++) {
                if (Math.abs(tgt.prop.keyTime(k) - t) <= half) { tgt.prop.removeKey(k); removed++; break; }
            }
            if (removed === 0) throw H.err("No marker near time " + t, "NOT_FOUND");
        } else if (a.comment_contains !== undefined && a.comment_contains !== null) {
            var want = String(a.comment_contains).toLowerCase();
            for (var m = tgt.prop.numKeys; m >= 1; m--) {
                var mv = tgt.prop.keyValue(m);
                if (String(mv.comment).toLowerCase().indexOf(want) >= 0) { tgt.prop.removeKey(m); removed++; }
            }
            if (removed === 0) throw H.err("No marker comment contains '" + a.comment_contains + "'", "NOT_FOUND");
        } else {
            throw H.err("Provide indices, time_s or comment_contains", "BAD_ARGS");
        }
        return { removed: removed, num_markers: tgt.prop.numKeys };
    };

    // -------------------------------------------------------------------- time

    T["time_remap_enable"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        if (layer.timeRemapEnabled) {
            return { already_enabled: true };
        }
        layer.timeRemapEnabled = true;
        var remap = layer.property("ADBE Time Remapping");
        var seeded = false;
        if (H.bool(a.seed_keyframes, true) && a.expression === undefined) {
            remap.setValueAtTime(layer.inPoint, layer.startTime);
            remap.setValueAtTime(layer.outPoint, layer.startTime + (layer.outPoint - layer.inPoint));
            seeded = true;
        }
        if (a.expression !== undefined && a.expression !== null && a.expression !== "") {
            remap.expression = String(a.expression);
        }
        return { enabled: true, seeded_keyframes: seeded };
    };

    T["time_stretch"] = function (a) {
        var comp = H.compDefault(a.comp);
        var layer = H.layerDefault(comp, a.layer);
        var old = Number(layer.stretch);
        if (a.stretch_percent !== undefined) {
            var st = Number(a.stretch_percent);
            if (st === 0) throw H.err("stretch_percent cannot be 0", "BAD_ARGS");
            layer.stretch = st;
        }
        if (a.new_in_point !== undefined) {
            layer.startTime = layer.startTime + (Number(a.new_in_point) - layer.inPoint);
            layer.inPoint = Number(a.new_in_point);
        }
        return { changed: true, old_stretch: old, new_stretch: Number(layer.stretch), in_point: Number(layer.inPoint), out_point: Number(layer.outPoint) };
    };

    // ------------------------------------------------------------------ render

    function resolveOutputModuleTemplate(om, a) {
        var tried = [];
        function tryTemplate(name) {
            if (!name) return false;
            try { om.applyTemplate(name); tried.push(name); return true; } catch (eT) { return false; }
        }
        if (a.output_template !== undefined && a.output_template !== null && a.output_template !== "") {
            if (tryTemplate(String(a.output_template))) return { template: String(a.output_template), tried: tried };
        }
        var fmt = String(H.str(a.format, "")).toLowerCase();
        var candidates = {
            "png": ["PNG", "PNG Sequence"],
            "exr": ["EXR", "OpenEXR", "EXR Sequence"],
            "jpg": ["JPEG", "JPEG Sequence", "Photoshop JPEG"],
            "tiff": ["TIFF", "TIFF Sequence", "TIFF with Alpha"],
            "prores": ["ProRes 422", "ProRes 422 HQ", "Apple ProRes 422", "QuickTime - ProRes 422 HQ"],
            "h264": ["H.264", "H264", "QuickTime - H.264"],
            "lossless": ["Lossless", "Lossless with Alpha", "QuickTime - Lossless"]
        };
        var list = candidates[fmt] || [];
        for (var i = 0; i < list.length; i++) {
            if (tryTemplate(list[i])) return { template: list[i], tried: tried };
        }
        return { template: null, tried: tried };
    }

    function rqItemSummary(rqi, i) {
        var o = { index: i, comp: String(rqi.comp.name), comp_id: rqi.comp.id, status: String(rqi.status) };
        try { o.status = rqStatusName(rqi.status); } catch (eS) { }
        try { o.elapsed_s = Number(rqi.elapsedSeconds); } catch (eE) { }
        try {
            o.outputs = [];
            for (var m = 1; m <= rqi.outputModules.numItems; m++) {
                var om = rqi.outputModule(m);
                o.outputs.push({ file: om.file ? H.fwd(om.file.fsName) : null, template: String(om.name) });
            }
        } catch (eO) { }
        return o;
    }

    function rqStatusName(st) {
        var names = {};
        try {
            names[RQItemStatus.NEEDS_OUTPUT] = "needs_output";
            names[RQItemStatus.UNQUEUED] = "unqueued";
            names[RQItemStatus.QUEUED] = "queued";
            names[RQItemStatus.RENDERING] = "rendering";
            names[RQItemStatus.DONE] = "done";
            names[RQItemStatus.STOPPED] = "stopped";
            names[RQItemStatus.ERR] = "error";
        } catch (eR) { }
        return names[st] || String(st);
    }

    function queueComp(a) {
        var comp = H.compDefault(a.comp);
        if (a.output_path === undefined || a.output_path === null || a.output_path === "") {
            throw H.err("output_path is required", "BAD_ARGS");
        }
        var rq = app.project.renderQueue;
        var rqi = rq.items.add(comp);
        try {
            if (a.start_time_s !== undefined) rqi.startTime = Number(a.start_time_s);
            if (a.end_time_s !== undefined) rqi.endTime = Number(a.end_time_s);
        } catch (eTime) { }
        var om = rqi.outputModule(1);
        var tpl = resolveOutputModuleTemplate(om, a);
        om.file = new File(H.norm(String(a.output_path)));
        return { item: rqi, comp: comp, template_info: tpl };
    }

    T["render_queue_add"] = function (a) {
        var q = queueComp(a);
        var idx = 1;
        try { idx = app.project.renderQueue.items.length; } catch (eI) { }
        var out = { queued: true, item_index: idx, output_template: q.template_info.template, templates_tried: q.template_info.tried, item: rqItemSummary(q.item, idx) };
        if (H.bool(a.start_render, false)) {
            app.project.renderQueue.render();
            out.rendered = true;
            out.item = rqItemSummary(q.item, idx);
        }
        return out;
    };

    T["render_queue_list"] = function (a) {
        var rq = app.project.renderQueue;
        var out = [];
        for (var i = 1; i <= rq.items.length; i++) {
            out.push(rqItemSummary(rq.item(i), i));
        }
        return { count: out.length, items: out };
    };

    T["render_queue_control"] = function (a) {
        var rq = app.project.renderQueue;
        var action = String(H.str(a.action, "")).toLowerCase();
        if (action === "start") {
            rq.render();
            return { action: "start", finished: true };
        }
        if (action === "pause") {
            rq.pauseRendering(true);
            return { action: "pause" };
        }
        if (action === "resume") {
            rq.pauseRendering(false);
            return { action: "resume" };
        }
        if (action === "stop") {
            rq.stopRendering();
            return { action: "stop" };
        }
        if (action === "remove_item") {
            var idx = Math.round(H.num(a.item_index, 0));
            if (idx < 1 || idx > rq.items.length) throw H.err("item_index out of range", "OUT_OF_RANGE");
            // AE has no direct delete API; unqueue instead so it never renders
            rq.item(idx).render = false;
            return { action: "remove_item", note: "AE scripting cannot delete a queue item; it was unqueued (render=false) instead", item_index: idx };
        }
        throw H.err("Unknown action '" + action + "'", "BAD_ARGS");
    };

    T["render_start"] = function (a) {
        var q = queueComp(a);
        app.project.renderQueue.render();
        var idx = 1;
        try { idx = app.project.renderQueue.items.length; } catch (eI) { }
        var summary = rqItemSummary(q.item, idx);
        var ok = summary.status === "done";
        var out = {
            rendered: true,
            success: ok,
            status: summary.status,
            elapsed_s: summary.elapsed_s || null,
            outputs: summary.outputs,
            output_template: q.template_info.template,
            templates_tried: q.template_info.tried
        };
        if (!ok) out.warning = "Render queue finished with status '" + summary.status + "' - check outputs and bridge.log";
        return out;
    };

    T["frame_render"] = function (a) {
        var comp = H.compDefault(a.comp);
        if (typeof comp.saveFrameToPng !== "function") {
            throw H.err("This AE version has no comp.saveFrameToPng (needs AE 2023+). Use render_start instead.", "NOT_SUPPORTED");
        }
        var times = (a.times_s instanceof Array && a.times_s.length > 0) ? a.times_s : [H.timeArg(comp, a)];
        var dir = H.str(a.output_dir, null) || ($.global.AE_MCP_BRIDGE.state.runtimeDir + "/previews");
        if (!new Folder(dir).exists) {
            var parts = dir.replace(/\\/g, "/").split("/");
            var cur = "";
            for (var p = 0; p < parts.length; p++) {
                if (parts[p].length === 0 && p > 0) continue;
                cur = (p === 0) ? parts[p] : cur + "/" + parts[p];
                if (cur.length === 0 || /^[A-Za-z]:$/.test(cur)) continue;
                var fo = new Folder(cur);
                if (!fo.exists) fo.create();
            }
        }
        var files = [];
        var stamp = new Date().getTime();
        for (var i = 0; i < times.length; i++) {
            var f = new File(dir + "/" + String(comp.name).replace(/[^\w\-]+/g, "_") + "-f" + i + "-" + stamp + ".png");
            comp.saveFrameToPng(Number(times[i]), f);
            files.push(H.fwd(f.fsName));
        }
        return { rendered_frames: files.length, files: files, comp: String(comp.name) };
    };

    // ----------------------------------------------------------------- footage

    T["footage_info"] = function (a) {
        var item = H.itemByIdOrName(a.item);
        if (!(item instanceof FootageItem)) throw H.err("Item '" + a.item + "' is not footage", "NOT_FOOTAGE");
        var out = H.footageSummary(item);
        out.id = item.id;
        out.name = String(item.name);
        try {
            var ms = item.mainSource;
            out.source_type = String(ms.constructor === undefined ? "unknown" : (ms instanceof SolidSource ? "solid" : (ms instanceof FileSource ? "file" : (ms instanceof PlaceholderSource ? "placeholder" : "av"))));
            if (ms instanceof FileSource && ms.file) out.path = H.fwd(ms.file.fsName);
            try { out.alpha_mode = String(ms.alphaMode); } catch (eA) { }
            try { out.alpha_inverted = !!ms.invertAlpha; } catch (eI) { }
            try { if (ms.conformFrameRate !== undefined) out.conform_fps = Number(ms.conformFrameRate); } catch (eC) { }
        } catch (eS) { }
        // usage count
        var used = 0;
        var p = H.requireProject();
        for (var i = 1; i <= p.numItems; i++) {
            var it = p.item(i);
            if (!(it instanceof CompItem)) continue;
            for (var L = 1; L <= it.numLayers; L++) {
                try { if (it.layer(L).source === item) used++; } catch (eU) { }
            }
        }
        out.used_by_layers = used;
        return out;
    };

    T["footage_replace"] = function (a) {
        var item = H.itemByIdOrName(a.item);
        if (!(item instanceof FootageItem)) throw H.err("Item '" + a.item + "' is not footage", "NOT_FOOTAGE");
        var f = new File(H.norm(H.str(a.path, "")));
        if (!f.exists) throw H.err("File not found: " + a.path, "NOT_FOUND");
        if (H.bool(a.sequence, false)) item.replaceWithSequence(f, false);
        else item.replace(f);
        return { replaced: true, name: String(item.name), new_path: item.file ? H.fwd(item.file.fsName) : null };
    };

    T["footage_reload"] = function (a) {
        var item = H.itemByIdOrName(a.item);
        if (!(item instanceof FootageItem)) throw H.err("Item '" + a.item + "' is not footage", "NOT_FOOTAGE");
        try { item.mainSource.reload(); } catch (e1) {
            try { item.reload(); } catch (e2) {
                throw H.err("Reload is not supported for this footage: " + String(e2.message || e2), "NOT_SUPPORTED");
            }
        }
        return { reloaded: true, name: String(item.name) };
    };

    T["footage_interpret"] = function (a) {
        var item = H.itemByIdOrName(a.item);
        if (!(item instanceof FootageItem)) throw H.err("Item '" + a.item + "' is not footage", "NOT_FOOTAGE");
        var ms = item.mainSource;
        var applied = [], failed = [];
        function tryApply(key, fn) {
            try { fn(); applied.push(key); } catch (eT) { failed.push({ field: key, reason: String(eT.message || eT) }); }
        }
        if (a.guess_frame_rate && a.conform_fps === undefined) {
            // no scripting API for "guess" - report it
            failed.push({ field: "guess_frame_rate", reason: "no scripting API; set conform_fps explicitly" });
        }
        if (a.conform_fps !== undefined && Number(a.conform_fps) > 0) {
            tryApply("conform_fps", function () { ms.conformFrameRate = Number(a.conform_fps); });
        }
        if (a.loops !== undefined) {
            tryApply("loops", function () { ms.loops = Math.round(Number(a.loops)); });
        }
        if (a.alpha_mode !== undefined) {
            var amap = {
                "ignore": AlphaMode.IGNORE, "straight": AlphaMode.STRAIGHT,
                "premultiplied": AlphaMode.PREMULTIPLIED, "guess": AlphaMode.GUESS
            };
            var am = amap[String(a.alpha_mode).toLowerCase()];
            if (am === undefined) throw H.err("Unknown alpha_mode '" + a.alpha_mode + "'", "BAD_ARGS");
            tryApply("alpha_mode", function () { ms.alphaMode = am; });
        }
        if (a.premultiplied_color !== undefined) {
            tryApply("premultiplied_color", function () { ms.premultipliedColor = H.color(a.premultiplied_color); });
        }
        if (a.field_order !== undefined) {
            var fmap = { "off": FieldSeparationType.OFF, "upper_first": FieldSeparationType.UPPER_FIELD_FIRST, "lower_first": FieldSeparationType.LOWER_FIELD_FIRST };
            var fo = fmap[String(a.field_order).toLowerCase()];
            if (fo === undefined) throw H.err("Unknown field_order '" + a.field_order + "'", "BAD_ARGS");
            tryApply("field_order", function () { ms.fieldSeparationType = fo; });
        }
        return { applied: applied, failed: failed };
    };

    // ------------------------------------------------------------------- batch

    T["layers_batch"] = function (a) {
        if (!(a.operations instanceof Array) || a.operations.length === 0) {
            throw H.err("operations must be a non-empty array of {tool, args}", "BAD_ARGS");
        }
        if (a.operations.length > 200) throw H.err("Too many operations in one batch (max 200)", "BAD_ARGS");
        var continueOnError = H.bool(a.continue_on_error, true);
        var results = [];
        var okCount = 0, errCount = 0;
        for (var i = 0; i < a.operations.length; i++) {
            var op = a.operations[i];
            var rec = { index: i, tool: op ? String(op.tool || "") : "" };
            if (!op || !rec.tool) {
                rec.ok = false;
                rec.error = { code: "BAD_ARGS", message: "Missing 'tool'" };
                errCount++;
                results.push(rec);
                if (!continueOnError) break;
                continue;
            }
            var handler = $.global.AE_MCP_TOOLS[rec.tool];
            if (!handler) {
                rec.ok = false;
                rec.error = { code: "UNKNOWN_TOOL", message: "No tool named '" + rec.tool + "'" };
                errCount++;
                results.push(rec);
                if (!continueOnError) break;
                continue;
            }
            try {
                rec.result = handler(op.args || {});
                rec.ok = true;
                okCount++;
            } catch (eOp) {
                rec.ok = false;
                rec.error = { code: "TOOL_ERROR", message: String(eOp.message || eOp) };
                errCount++;
            }
            results.push(rec);
            if (!continueOnError && errCount > 0) break;
        }
        return { total: a.operations.length, ok: okCount, failed: errCount, results: results };
    };

    T["undo"] = function (a) {
        var id = 0;
        try { id = app.findMenuCommandId("Undo"); } catch (eF) { id = 0; }
        if (!id) id = 16; // canonical Undo command id
        app.executeCommand(id);
        return { undone: true, command_id: id };
    };
})();
