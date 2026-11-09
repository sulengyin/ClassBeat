/* 配置向导（P5）。
 *
 * 解决的不是"改一个时间"（作息页早就能改），是"从空白到这个班的屏"：
 * 别的老师拿到包，屏上是别人的班、别人的作息、别人的课表。
 *
 * 四步：班级 → 作息 → 课表 → 岗位 / 文案。每一步都能跳过，改完立刻生效，
 * 不用重新打包、不用命令行。产出仍是 localStorage 里的本机配置，
 * 换电脑时用「导出设置」把整份带走。
 *
 * 第四步只做最小编辑：岗位能改名称和职责，文案能改常用的那几组。
 * 人员名单、执行频率、轮换规则一律原样保留——那些不是改字能解决的，
 * 硬改只会让屏上出现一半新一半旧的岗位。
 *
 * 岗位表可以粘贴进来做辅助识别：拆出岗位名 / 职责 / 人员，姓名拿本班名册
 * 比一次（精确 / 疑似错字 / 未找到 / 同名）。识别记录只留在草稿里，
 * 绝不写进 roles.json；未识别的姓名不会写入，也不会自动新增学生。
 * 表上的数字编号一律不解释（"1 沈亦然" 只当带编号的姓名，不当周几）。
 *
 * 为什么不在这里生成 zip：file:// 页面没有写磁盘的权限，硬做只能把
 * 整个 server/ 当字符串塞进网页再用 JSZip 拼包，体积和维护都不划算。
 */
(function (root) {
  "use strict";

  var KEY = "rhythm.setup.draft.v1";
  var DRAFT_DAYS = 7;
  var STEP_NAMES = ["班级", "作息", "课表", "岗位 / 文案"];

  /* 文案字段与 edit.js 完全同一套键：不新建存储，也不另造一套命名。 */
  var STAGES = [
    { key: "before",  label: "到校（打铃前）", title: "早上好",     note: "到校后先交作业、整理书包" },
    { key: "closed",  label: "放学以后",       title: "放学了",     note: "整理好书包，路上注意安全" },
    { key: "holiday", label: "休息日",         title: "今天不上学", note: "好好休息，明天见" }
  ];
  var WEEKDAYS = [
    { n: 1, label: "周一" }, { n: 2, label: "周二" }, { n: 3, label: "周三" },
    { n: 4, label: "周四" }, { n: 5, label: "周五" }
  ];
  var TEXT_GROUPS = ["stage", "reminders", "reading", "prep", "tips"];

  var state = null;
  var box = null;

  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function cfg() {
    return (root.Runtime && root.Runtime.config) ? (root.Runtime.config() || {}) : {};
  }

  function localStore() { return root.Store || {}; }

  /* 当前生效文案（包内默认 + 本机改动）。第四步改的就是这一份。 */
  function effectiveTexts() {
    return localStore().texts ? (localStore().texts() || {}) : ((root.RHYTHM_DATA && root.RHYTHM_DATA.texts) || {});
  }

  function same(a, b) { return JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b); }

  /* 文案按“组”比较：edit.js 存的就是这些顶层键，没有更细的补丁接口。 */
  function buildTextPatch(cur, base) {
    cur = cur || {};
    base = base || {};
    var patch = {};
    TEXT_GROUPS.forEach(function (g) {
      if (same(cur[g], base[g])) return;
      patch[g] = (cur[g] && Object.keys(cur[g]).length) ? clone(cur[g]) : null;
    });
    ["breakTitle", "prepLabel"].forEach(function (k) {
      if ((cur[k] || "") === (base[k] || "")) return;
      patch[k] = (cur[k] && String(cur[k]).trim()) ? cur[k] : null;
    });
    if (!same(cur.breakActions, base.breakActions)) {
      patch.breakActions = (cur.breakActions && cur.breakActions.length) ? cur.breakActions.slice() : null;
    }
    return patch;
  }

  /* 岗位只改 name / duty，按 id 定位，其余字段整对象保留。 */
  function editRole(set, id, field, value) {
    var out = clone(set);
    (out && out.roles || []).forEach(function (r) {
      if (r.id === id) r[field] = value;
    });
    return out;
  }

  /* 执行频率里的时间也能改：只换 freq.times，kind / event / 人员原样保留。 */
  function editRoleFreqTimes(set, id, times) {
    var out = clone(set);
    (out && out.roles || []).forEach(function (r) {
      if (r.id !== id) return;
      var f = clone(r.freq || {});
      f.times = times.slice();
      r.freq = f;
    });
    return out;
  }

  function freqText(freq) {
    if (!freq || freq.kind === "unset") return "尚未设置执行频率，不产生提醒。";
    if (freq.kind === "daily") {
      return "每天" + (freq.times && freq.times.length ? " " + freq.times.join("、") : "");
    }
    if (freq.kind === "event") return "事件：" + (freq.event || "未写");
    if (freq.kind === "each") return "每节课";
    if (freq.kind === "task") return "跟着「" + (freq.task || "任务") + "」";
    if (freq.kind === "cycle") {
      return "按 A/B 组轮换" + (freq.times && freq.times.length ? " " + freq.times.join("、") : "");
    }
    return "时间安排未识别";
  }

  function roleChangedCount(cur, base) {
    var n = 0;
    var byId = {};
    ((base && base.roles) || []).forEach(function (r) { byId[r.id] = r; });
    ((cur && cur.roles) || []).forEach(function (r) {
      var b = byId[r.id];
      if (!b) return;
      if (b.name !== r.name) n++;
      if (b.duty !== r.duty) n++;
      var bt = (b.freq && b.freq.times) || [];
      var rt = (r.freq && r.freq.times) || [];
      if (bt.join("|") !== rt.join("|")) n++;
    });
    return n;
  }

  function addedRoleCount(cur, base) {
    var before = {};
    ((base && base.roles) || []).forEach(function (r) { before[r.id] = 1; });
    var n = 0;
    ((cur && cur.roles) || []).forEach(function (r) { if (!before[r.id]) n++; });
    return n;
  }

  /* ---------- B4b：岗位表导入与辅助识别 ----------
     目标不是“替老师填表”，是把粘贴进来的表拆成能核对的行：
     岗位名 / 职责 / 人员。人员一律拿本班名册比一次，
     差异列出来让老师点一次（PLAN 2.17 / 2.11），不静默新增。
     识别结果只放草稿，合并时也只写岗位的名称、职责和人员名单。 */
  function tidy(s) {
    return String(s == null ? "" : s).replace(/\u00a0/g, " ").replace(/[ \t\r\n]+/g, " ").trim();
  }

  /* 老师在面板里修正过的名单，只用于姓名核对，不写回班级数据。
     存在 Store 的 config.students 里，跟作息、岗位一样属于本机配置。 */
  function rosterOverride() {
    var cfg = root.Store && root.Store.config ? root.Store.config() : null;
    var d = cfg && cfg.students;
    return Array.isArray(d) && d.length ? d : null;
  }

  function rosterNames() {
    var d = rosterOverride() || (root.RHYTHM_DATA && root.RHYTHM_DATA.students);
    var list = [];
    if (Array.isArray(d)) list = d;
    else if (d && Array.isArray(d.students)) list = d.students;
    var out = [];
    list.forEach(function (s) {
      if (!s) return;
      if (typeof s === "string") { out.push(s); return; }
      if (s.active === false) return;
      if (s.name) out.push(tidy(s.name));
    });
    return out.filter(function (n) { return n; });
  }

  /* 把「一行一个姓名」写进本机配置。原来的 id / alias 尽量保留；
     新补的姓名只用于核对，不带学籍信息，也绝不进 roles.json。 */
  function saveRoster(text) {
    var src = [];
    var d = root.RHYTHM_DATA && root.RHYTHM_DATA.students;
    if (Array.isArray(d)) src = d;
    else if (d && Array.isArray(d.students)) src = d.students;
    var byName = {};
    src.forEach(function (s) {
      if (s && typeof s === "object" && s.name) byName[tidy(s.name)] = s;
    });

    var list = [];
    String(text == null ? "" : text).split(/[\r\n、,，;；]+/).forEach(function (raw) {
      var name = stripLeadingNumber(raw).text;
      if (!name || /^\d+$/.test(name)) return;
      var keep = byName[name];
      list.push(keep
        ? { id: keep.id, name: name, active: true, alias: keep.alias }
        : { name: name, active: true });
    });
    if (!list.length) return { ok: false, why: "名单里至少要留一个姓名。" };
    root.Store.patchConfig({ students: list });
    return { ok: true, n: list.length };
  }

  function decodeEntities(s) {
    return String(s == null ? "" : s)
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(+d); })
      .replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/&amp;/gi, "&");
  }

  function splitPeople(text) {
    var out = [];
    String(text == null ? "" : text).split(/[\/／、,，;；|｜]+/).forEach(function (part) {
      var p = tidy(part);
      if (!p) return;
      /* "1 沈亦然" 是一个带编号的姓名，不能把 1 和姓名拆开 */
      var buf = "";
      p.split(/\s+/).forEach(function (ch) {
        if (/^\d{1,3}[.、,，)）:：\-]?$/.test(ch)) { buf += ch; return; }
        if (buf) { out.push(buf + " " + ch); buf = ""; }
        else out.push(ch);
      });
      if (buf) out.push(buf);
    });
    return out;
  }

  /* 表上的数字只当编号剥掉，不解释成周几或组号（PLAN 2.11）。 */
  function stripLeadingNumber(s) {
    var m = String(s == null ? "" : s).match(/^(\d{1,3})\s*[.、,，)）:：\-]?\s*(?!\d)(.+)$/);
    if (m && !/^\d+$/.test(m[2])) return { text: tidy(m[2]), numbered: true };
    return { text: tidy(s), numbered: false };
  }

  function personToken(raw) {
    var s = tidy(raw);
    var note = "";
    s = s.replace(/[（(]([^）)]*)[）)]/g, function (m, inner) { note = tidy(inner); return ""; });
    var st = stripLeadingNumber(s);
    s = st.text.replace(/^["“”'‘’\-—·•*]+|["“”'‘’]+$/g, "").trim();
    if (!s || /^\d+$/.test(s)) return null;
    return { name: s, note: note, numbered: st.numbered };
  }

  function editDistance(a, b) {
    a = String(a || ""); b = String(b || "");
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var prev = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      var cur = [i];
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1)
        );
      }
      prev = cur;
    }
    return prev[b.length];
  }

  /* 四态：精确 / 疑似错字 / 未找到 / 同名。
     同名不动——两个同名学生在名单里，靠姓名分不出是谁。 */
  function matchOne(raw, roster) {
    var t = personToken(raw);
    if (!t) return null;
    var base = {
      raw: tidy(raw), name: t.name, note: t.note, numbered: t.numbered,
      suggestion: "", resolved: "", accepted: false, state: "missing"
    };
    var hits = roster.filter(function (n) { return n === t.name; });
    if (hits.length > 1) { base.state = "same"; return base; }
    if (hits.length === 1) { base.state = "exact"; base.resolved = t.name; return base; }

    var best = [], bestD = 99;
    roster.forEach(function (n) {
      var d = editDistance(t.name, n);
      if (d < bestD) { bestD = d; best = [n]; }
      else if (d === bestD) best.push(n);
    });
    var lenOk = t.name.length >= 3
      || (t.name.length === 2 && best[0] && best[0].charAt(0) === t.name.charAt(0));
    if (bestD <= 1 && best.length === 1 && lenOk) {
      base.state = "typo";
      base.suggestion = best[0];
      return base;
    }
    return base;
  }

  function matchPeople(text, roster) {
    var out = [];
    splitPeople(text).forEach(function (raw) {
      var m = matchOne(raw, roster);
      if (m) out.push(m);
    });
    return out;
  }

  function countPeopleStates(rows) {
    var c = { exact: 0, typo: 0, missing: 0, same: 0 };
    (rows || []).forEach(function (r) {
      (r.people || []).forEach(function (p) { c[p.state] = (c[p.state] || 0) + 1; });
    });
    return c;
  }

  function formatLabel(f) {
    return { html: "Word / Excel 表格", markdown: "Markdown 表格", csv: "CSV", tsv: "TSV", json: "JSON", text: "纯文本" }[f] || "文本";
  }

  function htmlRows(text) {
    var out = [];
    var tr = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    var m;
    while ((m = tr.exec(text))) {
      var cells = [];
      var td = /<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi;
      var c;
      while ((c = td.exec(m[1]))) {
        cells.push(tidy(decodeEntities(c[2].replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, ""))));
      }
      if (cells.length) out.push(cells);
    }
    return out;
  }

  function isMdSep(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.indexOf("|") >= 0;
  }

  function mdRows(text) {
    var out = [];
    text.split(/\r?\n/).forEach(function (line) {
      var l = line.trim();
      if (!l || l.indexOf("|") < 0 || isMdSep(l)) return;
      out.push(l.replace(/^\|/, "").replace(/\|$/, "").split("|").map(tidy));
    });
    return out;
  }

  function splitCsvLine(line, delim) {
    var out = [], cur = "", q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (ch === '"') {
        if (q && line.charAt(i + 1) === '"') { cur += '"'; i++; }
        else q = !q;
      } else if (ch === delim && !q) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(tidy);
  }

  function csvRows(text, delim) {
    return text.split(/\r?\n/).filter(function (l) { return l.trim(); })
      .map(function (l) { return splitCsvLine(l, delim); });
  }

  function looksCsv(text) {
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (lines.length < 2) return false;
    var n = splitCsvLine(lines[0], ",").length;
    if (n < 2) return false;
    return lines.every(function (l) { return splitCsvLine(l, ",").length === n; });
  }

  function hasMdTable(text) {
    var lines = text.split(/\r?\n/);
    for (var i = 1; i < lines.length; i++) if (isMdSep(lines[i])) return true;
    return false;
  }

  function jsonRows(obj) {
    var arr = null;
    if (Array.isArray(obj)) arr = obj;
    else if (obj && typeof obj === "object") {
      if (Array.isArray(obj.roles)) arr = obj.roles;
      else if (Array.isArray(obj.rows)) arr = obj.rows;
      else if (Array.isArray(obj.items)) arr = obj.items;
    }
    if (arr) {
      return arr.map(function (it) {
        if (typeof it === "string") return [it, "", ""];
        if (!it || typeof it !== "object") return [];
        var name = it.name || it["岗位"] || it["名称"] || it.role || it["项目"] || it.title || "";
        var duty = it.duty || it["职责"] || it["内容"] || it.desc || "";
        var people = it.people || it["人员"] || it["负责人"] || it["姓名"] || it.members;
        if (people == null && it.peopleMap) people = Object.keys(it.peopleMap).map(function (k) { return it.peopleMap[k]; });
        if (people == null && it.groups) people = Object.keys(it.groups).map(function (k) { return it.groups[k]; });
        if (Array.isArray(people)) people = people.join("、");
        return [String(name == null ? "" : name), String(duty == null ? "" : duty),
                String(people == null ? "" : people)];
      }).filter(function (r) { return r.length && tidy(r[0]); });
    }
    var out = [];
    Object.keys(obj || {}).forEach(function (k) {
      if (typeof obj[k] === "string") out.push([k, obj[k], ""]);
      else if (Array.isArray(obj[k])) out.push([k, "", obj[k].join("、")]);
    });
    return out;
  }

  /* ---------- .xlsx / .docx 文件直读（零依赖） ----------
     两种文件都是 ZIP + XML。用浏览器自带的 DecompressionStream 解压，
     再用正则读工作表 / 表格，不引入 SheetJS、mammoth 这类库。
     老式 .xls / .doc 是二进制格式，不做，提示另存为新格式。 */
  function bytesToText(bytes) {
    return new TextDecoder("utf-8").decode(bytes);
  }

  function zipEntries(data) {
    var u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var u32 = function (o) { return dv.getUint32(o, true); };
    var u16 = function (o) { return dv.getUint16(o, true); };

    var eocd = -1;
    var min = Math.max(0, u8.length - 22 - 65536);
    for (var i = u8.length - 22; i >= min; i--) {
      if (u32(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("不是有效的 .xlsx / .docx 文件（ZIP 结构不完整）");

    var count = u16(eocd + 10);
    var p = u32(eocd + 16);
    var map = {};
    for (var n = 0; n < count; n++) {
      if (p + 46 > u8.length || u32(p) !== 0x02014b50) break;
      var method = u16(p + 10);
      var csize = u32(p + 20);
      var nameLen = u16(p + 28);
      var extraLen = u16(p + 30);
      var commentLen = u16(p + 32);
      var local = u32(p + 42);
      var name = bytesToText(u8.subarray(p + 46, p + 46 + nameLen));
      var lName = u16(local + 26);
      var lExtra = u16(local + 28);
      map[name] = { method: method, size: csize, offset: local + 30 + lName + lExtra };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { map: map, u8: u8 };
  }

  async function inflateBytes(bytes) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("这个浏览器不支持直接解压，请在 Word / Excel 里复制表格后粘贴");
    }
    var ds = new DecompressionStream("deflate-raw");
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    var buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  async function zipText(zip, name) {
    var e = zip.map[name];
    if (!e) return null;
    var raw = zip.u8.subarray(e.offset, e.offset + e.size);
    var data = e.method === 0 ? raw : await inflateBytes(raw);
    return bytesToText(data);
  }

  function attrOf(tag, name) {
    var m = new RegExp(name + '="([^"]*)"').exec(tag);
    return m ? decodeEntities(m[1]) : "";
  }

  function colIndex(letters) {
    var n = 0;
    for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n - 1;
  }

  function xlsxT(s) {
    var out = "";
    var re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    var m;
    while ((m = re.exec(s))) out += decodeEntities(m[1]);
    return out;
  }

  function xlsxShared(xml) {
    var out = [];
    var re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
    var m;
    while ((m = re.exec(xml))) out.push(xlsxT(m[1]));
    return out;
  }

  function xlsxRows(xml, shared) {
    var rows = [];
    var rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    var rm;
    while ((rm = rowRe.exec(xml))) {
      var cells = [], next = 0;
      var cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      var cm;
      while ((cm = cRe.exec(rm[1]))) {
        var attrs = cm[1] || "";
        var inner = cm[2] || "";
        var ref = /r="([A-Z]+)\d+"/.exec(attrs);
        var col = ref ? colIndex(ref[1]) : next;
        next = col + 1;
        var type = /t="([^"]+)"/.exec(attrs);
        type = type ? type[1] : "n";
        var text = "";
        var v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (type === "s") text = v ? (shared[+decodeEntities(v[1])] || "") : "";
        else if (type === "inlineStr") text = xlsxT(inner);
        else text = v ? decodeEntities(v[1]) : "";
        while (cells.length < col) cells.push("");
        cells[col] = text;
      }
      rows.push(cells);
    }
    return rows;
  }

  function rowsToTsv(rows) {
    return rows.filter(function (r) {
      return r.some(function (c) { return tidy(c); });
    }).map(function (r) {
      return r.map(function (c) { return tidy(c).replace(/\t/g, " "); }).join("\t");
    }).join("\n");
  }

  function resolvePath(baseFile, target) {
    if (!target) return "";
    if (target.charAt(0) === "/") return target.replace(/^\/+/, "").replace(/\\/g, "/");
    var base = baseFile.split("/");
    base.pop();
    target.replace(/\\/g, "/").split("/").forEach(function (p) {
      if (!p || p === ".") return;
      if (p === "..") base.pop();
      else base.push(p);
    });
    return base.join("/");
  }

  async function xlsxFileText(zip) {
    var shared = [];
    var sharedXml = await zipText(zip, "xl/sharedStrings.xml");
    if (sharedXml) shared = xlsxShared(sharedXml);

    var sheetPath = "";
    var sheetName = "";
    var wb = await zipText(zip, "xl/workbook.xml");
    if (wb) {
      var sm = /<sheet\b[^>]*>/.exec(wb);
      if (sm) {
        sheetName = attrOf(sm[0], "name");
        var rid = attrOf(sm[0], "r:id");
        var rels = await zipText(zip, "xl/_rels/workbook.xml.rels");
        if (rid && rels) {
          var relRe = /<Relationship\b[^>]*>/g;
          var rm;
          while ((rm = relRe.exec(rels))) {
            if (attrOf(rm[0], "Id") === rid) {
              sheetPath = resolvePath("xl/workbook.xml", attrOf(rm[0], "Target"));
              break;
            }
          }
        }
      }
    }
    if (!sheetPath) {
      var keys = Object.keys(zip.map).filter(function (k) { return /^xl\/worksheets\/[^/]+\.xml$/.test(k); });
      sheetPath = keys[0] || "";
    }
    var xml = sheetPath ? await zipText(zip, sheetPath) : null;
    if (!xml) throw new Error("这个 .xlsx 里没有工作表");
    return { text: rowsToTsv(xlsxRows(xml, shared)), sheetName: sheetName };
  }

  function docxTextOf(s, tabChar) {
    var out = "";
    var re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g;
    var m;
    while ((m = re.exec(s))) {
      if (m[1] !== undefined) out += decodeEntities(m[1]);
      else if (tabChar) out += (m[0].indexOf("w:tab") >= 0 ? tabChar : " ");
    }
    return out;
  }

  function docxCellText(inner) {
    var paras = [];
    var pRe = /<w:p\b[\s\S]*?<\/w:p>/g;
    var pm;
    while ((pm = pRe.exec(inner))) paras.push(docxTextOf(pm[0], " "));
    if (paras.length) return tidy(paras.join(" "));
    return tidy(docxTextOf(inner, " "));
  }

  function docxTables(xml) {
    var tables = [];
    var tRe = /<w:tbl\b[\s\S]*?<\/w:tbl>/g;
    var tm;
    while ((tm = tRe.exec(xml))) {
      var rows = [];
      var rRe = /<w:tr\b[\s\S]*?<\/w:tr>/g;
      var rm;
      while ((rm = rRe.exec(tm[0]))) {
        var cells = [];
        var cRe = /<w:tc\b[\s\S]*?<\/w:tc>/g;
        var cm;
        while ((cm = cRe.exec(rm[0]))) cells.push(docxCellText(cm[0]));
        if (cells.length) rows.push(cells);
      }
      if (rows.length) tables.push(rows);
    }
    return tables;
  }

  /* docx 没有表格时按段落读。段落里的 <w:tab/> 是列分隔，必须保留，
     不能像正文那样压成空格，否则姓名列会被吞进岗位名。 */
  function tidyKeepTabs(s) {
    return String(s == null ? "" : s).replace(/\u00a0/g, " ")
      .replace(/ +/g, " ").replace(/\t+/g, "\t").trim();
  }

  async function docxFileText(zip) {
    var xml = await zipText(zip, "word/document.xml");
    if (!xml) throw new Error("这个 .docx 里没有正文");
    var tables = docxTables(xml);
    if (tables.length) {
      var best = tables[0];
      tables.forEach(function (t) { if (t.length > best.length) best = t; });
      return rowsToTsv(best);
    }
    var lines = [];
    var pRe = /<w:p\b[\s\S]*?<\/w:p>/g;
    var pm;
    while ((pm = pRe.exec(xml))) lines.push(tidyKeepTabs(docxTextOf(pm[0], "\t")));
    return lines.filter(Boolean).join("\n");
  }

  async function readOfficeFile(data, filename) {
    var name = String(filename || "").toLowerCase();
    var zip = zipEntries(data);
    if (/\.(xlsx|xlsm)$/.test(name)) {
      var x = await xlsxFileText(zip);
      return { format: "xlsx", text: x.text, sheetName: x.sheetName };
    }
    if (/\.docx$/.test(name)) {
      return { format: "docx", text: await docxFileText(zip) };
    }
    throw new Error("只支持 .xlsx / .docx；老的 .xls / .doc 请另存为新格式");
  }

  /* 面板里的文件选择：读到多少算多少，交给调用方决定怎么用。 */
  function readPickedFile(input) {
    var f = input && input.files && input.files[0];
    if (!f) return Promise.resolve(null);
    var p = f.arrayBuffer ? f.arrayBuffer()
      : Promise.reject(new Error("这个浏览器不支持读文件，请把表格粘贴进来"));
    return p.then(function (buf) {
      return readOfficeFile(buf, f.name || "");
    }).then(function (res) {
      res.name = f.name || "";
      return res;
    });
  }

  /* ---------- 作息表 / 班级课表识别 ---------- */
  var CN_DIGIT = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };

  function cnNum(s) {
    if (!s) return 0;
    if (/^\d+$/.test(s)) return +s;
    if (s.length === 1) return CN_DIGIT[s] || 0;
    if (s.charAt(0) === "十") return 10 + (CN_DIGIT[s.charAt(1)] || 0);
    if (s.length === 2 && s.charAt(1) === "十") return (CN_DIGIT[s.charAt(0)] || 0) * 10;
    return 0;
  }

  function hmMin(t) {
    var m = String(t || "").match(/(\d{1,2})[:：](\d{2})/);
    if (!m) return -1;
    var h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return -1;
    return h * 60 + mi;
  }

  function minHm(n) {
    return ("0" + Math.floor(n / 60)).slice(-2) + ":" + ("0" + (n % 60)).slice(-2);
  }

  function normHm(t) {
    var n = hmMin(t);
    return n < 0 ? "" : minHm(n);
  }

  /* 一行一对时间 + 内容，例如「8:20—9:00　第一节」「午餐、午休：11:40-12:50」。 */
  function parseTimeRows(text) {
    var out = [];
    String(text == null ? "" : text).split(/\r?\n/).forEach(function (line) {
      var raw = line.replace(/\t/g, " ");
      var times = raw.match(/\d{1,2}[:：]\d{2}/g) || [];
      if (times.length < 2) return;
      var label = raw.replace(/\d{1,2}[:：]\d{2}/g, " ")
        .replace(/[—–~～\-－：:、，,。至到]/g, "").replace(/\s+/g, "").trim();
      out.push({ start: normHm(times[0]), end: normHm(times[1]), label: label });
    });
    return out;
  }

  function timeSlotOf(label) {
    var s = label || "";
    var m = s.match(/第([一二三四五六七八九十]|\d+)节/);
    if (m) return { type: "class", periodNo: cnNum(m[1]) };
    if (s.indexOf("午餐") >= 0 && s.indexOf("午休") >= 0) return { type: "lunchboth" };
    if (s.indexOf("午餐") >= 0) return { type: "meal" };
    if (s.indexOf("午休") >= 0) return { type: "noon" };
    if (s.indexOf("课后") >= 0) {
      m = s.match(/第([一二三四五六七八九十]|\d+)时段/);
      return { type: "after", name: "课后服务 · 第" + (m ? cnNum(m[1]) : 1) + "时段" };
    }
    if (s.indexOf("大课间") >= 0) return { type: "ritual", name: "大课间", tip: "活动前先热身，出汗及时擦" };
    if (s.indexOf("眼保健操") >= 0) return { type: "ritual", name: "眼保健操", tip: "闭眼，按节拍，坐姿端正" };
    if (s.indexOf("早读") >= 0) return { type: "reading", name: "早读" };
    if (s.indexOf("课间") >= 0) return { type: "break", name: "课间" };
    return null;
  }

  /* 表里的空档自动补成课间：作息必须首尾相接，屏上才不会出现"没安排的时段"。 */
  function blocksFromTimeRows(rows) {
    var kept = [], skipped = [];
    (rows || []).forEach(function (r) {
      var s = hmMin(r.start), e = hmMin(r.end);
      var slot = timeSlotOf(r.label);
      if (s < 0 || e < 0 || e <= s || !slot) { skipped.push(r.label || "（没认出内容）"); return; }
      kept.push({ start: s, end: e, slot: slot });
    });
    kept.sort(function (a, b) { return a.start - b.start; });

    var out = [], prevEnd = -1, overlapped = false;
    kept.forEach(function (r) {
      if (r.start < prevEnd) {
        overlapped = true;
        return;
      }
      if (prevEnd >= 0 && r.start > prevEnd) {
        out.push({ start: minHm(prevEnd), end: minHm(r.start), type: "break", name: "课间" });
      }
      if (r.slot.type === "lunchboth") {
        /* 表上把午餐、午休写成一个区间就照抄一整段，不替它拆时间；
           表上分成两行，就各是一段。 */
        out.push({ start: minHm(r.start), end: minHm(r.end), type: "meal", name: "午餐、午休",
          tip: "排队取餐，不推挤；饭后把桌面擦干净" });
      } else if (r.slot.type === "meal") {
        out.push({ start: minHm(r.start), end: minHm(r.end), type: "meal", name: "午餐",
          tip: "排队取餐，不推挤；饭后把桌面擦干净" });
      } else if (r.slot.type === "noon") {
        out.push({ start: minHm(r.start), end: minHm(r.end), type: "noon", name: "午间" });
      } else {
        var slot = r.slot;
        var b = { start: minHm(r.start), end: minHm(r.end), type: slot.type };
        if (slot.periodNo) b.periodNo = slot.periodNo;
        if (slot.name) b.name = slot.name;
        if (slot.tip) b.tip = slot.tip;
        out.push(b);
      }
      prevEnd = r.end;
    });

    out.forEach(function (b, i) { b.seq = i + 1; });
    var classes = out.filter(function (b) { return b.type === "class"; });
    var bad = "";
    if (overlapped) bad = "表里有重叠的时间段，整表没有应用";
    if (!out.length) bad = "没读到时间段：每行要有「8:20—9:00」和「第一节」这样的内容";
    else if (!classes.length) bad = "表里没有「第 N 节」，不敢当作息用";
    return { blocks: out, skipped: skipped, bad: bad };
  }

  function noonBandOf(blocks) {
    var meal = null, noon = null;
    (blocks || []).forEach(function (b) {
      if (b.type === "meal") meal = b;
      if (b.type === "noon") noon = b;
    });
    if (!meal) return null;
    /* 表上只有「午餐、午休」一整段时，分界点就落在段尾：
       屏上显示的就是表上写的起止，不替老师编一个午休起点。 */
    if (!noon || noon.end <= noon.start) {
      return { lunchEnd: meal.end, bell: meal.end, noonEnd: meal.end };
    }
    return { lunchEnd: meal.end, bell: noon.start, noonEnd: noon.end };
  }

  function weekdayOf(cell) {
    var s = tidy(cell).replace(/\s/g, "").replace(/星期|礼拜/g, "周");
    var m = s.match(/^周([一二三四五六日天])/);
    if (!m) return 0;
    return ({ "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 7, "天": 7 })[m[1]] || 0;
  }

  function periodOfCell(cell) {
    var s = tidy(cell).replace(/\s/g, "");
    var m = s.match(/第([一二三四五六七八九十]|\d+)节/) || s.match(/^([一二三四五六七八九十]|\d+)$/);
    return m ? cnNum(m[1]) : 0;
  }

  function gridCellRows(text) {
    var out = [];
    String(text == null ? "" : text).split(/\r?\n/).forEach(function (line) {
      if (!line.trim()) return;
      var cells = line.indexOf("\t") >= 0 ? line.split("\t") : line.split(/\s{2,}/);
      out.push(cells.map(tidy));
    });
    return out;
  }

  /* 只认「周一…周五」列和「第 N 节」行；格子里第一段是科目，其余是任课老师。 */
  function gridFromRows(rows) {
    var weekCols = {}, headerAt = -1;
    rows.forEach(function (cells, ri) {
      if (headerAt >= 0) return;
      var map = {}, n = 0;
      cells.forEach(function (c, ci) {
        var w = weekdayOf(c);
        if (w >= 1 && w <= 5) { map[w] = ci; n += 1; }
      });
      if (n >= 3) { weekCols = map; headerAt = ri; }
    });
    if (weekCols[1] === undefined) return { entries: [], skipped: [], bad: "没找到「周一…周五」表头" };
    var firstWeekCol = Math.min.apply(Math, [1, 2, 3, 4, 5].map(function (w) {
      return weekCols[w] === undefined ? 99 : weekCols[w];
    }));

    var entries = [], skipped = [];
    for (var i = headerAt + 1; i < rows.length; i++) {
      var cells = rows[i], p = 0, labelCol = 0;
      for (var ci = 0; ci < cells.length; ci++) {
        p = periodOfCell(cells[ci]);
        if (p) { labelCol = ci; break; }
      }
      if (!p) {
        if (cells.join("").trim()) skipped.push(cells[0] || "（空行）");
        continue;
      }
      /* 表头可能从「周一」开始，也可能先有一列"节次"；数据行的列号跟着错开。 */
      var shift = labelCol + 1 - firstWeekCol;
      [1, 2, 3, 4, 5].forEach(function (w) {
        var idx = weekCols[w];
        var text = idx === undefined ? "" : tidy(cells[idx + shift] || "");
        if (!text || /^[—\-－–~]+$/.test(text)) return;
        var bits = text.split(/\s+/);
        var e = { weekday: w, periodNo: p, subject: bits[0] };
        /* 任课老师只跟着这格走，不按老师身份推科目；轮流的两位老师原样留着。 */
        if (bits.length > 1) e.teacher = bits.slice(1).join(" ");
        entries.push(e);
      });
    }
    return {
      entries: entries,
      skipped: skipped,
      bad: entries.length ? "" : "没读到任何科目"
    };
  }

  function headerMap(cells) {
    var map = { name: -1, duty: -1, people: -1, groupA: -1, groupB: -1, mapped: 0 };
    cells.forEach(function (cell, i) {
      var c = tidy(cell).replace(/\s/g, "");
      if (c.length > 10) return;
      if (map.name < 0 && /^(岗位|项目|名称|任务|岗位名称)$/.test(c)) map.name = i;
      else if (map.duty < 0 && /^(职责|内容|说明|要求|工作内容|职责要求)$/.test(c)) map.duty = i;
      else if (map.people < 0 && /^(负责人|人员|姓名|学生|组员|成员|责任人|负责人姓名)$/.test(c)) map.people = i;
      else if (map.groupA < 0 && /^(A组|甲组|A)$/i.test(c)) map.groupA = i;
      else if (map.groupB < 0 && /^(B组|乙组|B)$/i.test(c)) map.groupB = i;
    });
    map.mapped = [map.name, map.duty, map.people, map.groupA, map.groupB].filter(function (i) { return i >= 0; }).length;
    return map;
  }

  function peopleScore(cell, roster) {
    var n = 0;
    splitPeople(cell).forEach(function (t) {
      var m = matchOne(t, roster);
      if (m && m.state !== "missing") n++;
    });
    return n;
  }

  function rowsFromCells(cellsRows, roster) {
    var out = [];
    if (!cellsRows.length) return out;

    var headerAt = -1, map = null;
    for (var i = 0; i < cellsRows.length; i++) {
      if (!cellsRows[i].length || cellsRows[i].every(function (c) { return !tidy(c); })) continue;
      var hm = headerMap(cellsRows[i]);
      if (hm.mapped >= 2) { headerAt = i; map = hm; }
      break;
    }
    var hasHeader = !!map;
    var nameAt = hasHeader && map.name >= 0 ? map.name : 0;

    /* 没有表头时，整列都是 1 / 2 / 3 的序号列不当作岗位名 */
    if (!hasHeader) {
      var nums = 0, total = 0;
      cellsRows.forEach(function (r) {
        if (!r.length) return;
        total++;
        if (/^\d{1,3}$/.test(tidy(r[0]))) nums++;
      });
      if (total >= 2 && nums >= Math.ceil(total / 2) && cellsRows[0].length >= 2) nameAt = 1;
    }

    cellsRows.forEach(function (cells, idx) {
      if (!cells || !cells.length) return;
      if (cells.every(function (c) { return !tidy(c); })) return;
      if (hasHeader && idx === headerAt) return;

      var nm = stripLeadingNumber(cells[nameAt]);
      if (!nm.text || /^\d{1,3}$/.test(nm.text)) return;

      var duty = "", peopleText = "", peopleCols = [], groupHint = false;
      if (hasHeader) {
        if (map.people >= 0) peopleText = cells[map.people] || "";
        var groups = [];
        if (map.groupA >= 0 && tidy(cells[map.groupA])) groups.push(tidy(cells[map.groupA]));
        if (map.groupB >= 0 && tidy(cells[map.groupB])) groups.push(tidy(cells[map.groupB]));
        if (groups.length) {
          peopleText = (peopleText ? peopleText + "、" : "") + groups.join("、");
          groupHint = true;
        }
        if (map.duty >= 0) duty = tidy(cells[map.duty]);
      } else {
        var best = 0;
        for (var c = 0; c < cells.length; c++) {
          if (c === nameAt) continue;
          var sc = peopleScore(cells[c], roster);
          if (sc <= 0) continue;
          if (sc > best) { best = sc; peopleCols = [c]; }
          else if (sc === best) peopleCols.push(c);
        }
        if (peopleCols.length) {
          peopleText = peopleCols.map(function (c) { return tidy(cells[c]); }).join("、");
          groupHint = peopleCols.length > 1;
        }
        var used = {};
        used[nameAt] = 1;
        peopleCols.forEach(function (c) { used[c] = 1; });
        for (var d = 0; d < cells.length; d++) {
          if (used[d]) continue;
          if (tidy(cells[d])) { duty = tidy(cells[d]); break; }
        }
      }

      var people = matchPeople(peopleText, roster);
      var pending = [];
      if (nm.numbered || people.some(function (p) { return p.numbered; })) pending.push("编号未解释");
      if (groupHint) pending.push("A/B 组未拆分");
      if (!hasHeader) pending.push("列按位置推断，请核对");
      if (people.some(function (p) { return p.note; })) pending.push("含（替补）备注");

      out.push({
        name: nm.text, duty: duty, people: people, raw: cells.join(" ｜ "),
        confidence: hasHeader ? "高" : (peopleText ? "中" : "低"),
        pending: pending, selected: true
      });
    });
    return out;
  }

  function plainRows(text, roster, warnings) {
    var out = [];
    text.split(/\r?\n/).forEach(function (line) {
      var rawLine = tidy(line);
      if (!rawLine) return;
      if (/^[-—_=*#·•]+$/.test(rawLine)) return;
      if (/^\d{1,3}[.、,，)）:：]?$/.test(rawLine)) return;

      var s = rawLine;
      var numbered = false;
      var st = stripLeadingNumber(s);
      if (st.numbered) { s = st.text; numbered = true; }

      var name = "", duty = "", peopleText = "";
      var pm = s.match(/^(.+?)[（(]([^）)]*)[）)](.*)$/);
      if (pm) {
        name = tidy(pm[1]);
        duty = tidy(pm[2]);
        peopleText = tidy(pm[3].replace(/^[：:]/, ""));
      } else {
        var ci = s.search(/[：:]/);
        if (ci >= 0) {
          name = tidy(s.slice(0, ci));
          var rest = tidy(s.slice(ci + 1));
          var bar = rest.split(/[｜|]/);
          if (bar.length >= 2) { duty = tidy(bar[0]); peopleText = tidy(bar.slice(1).join("、")); }
          else peopleText = rest;
        } else {
          var sp = s.search(/[\s、，,;；]/);
          if (sp >= 0) { name = tidy(s.slice(0, sp)); peopleText = tidy(s.slice(sp + 1)); }
          else name = s;
        }
      }

      if (!name || /^(岗位|岗位名称|项目|职责|负责人|人员|姓名)$/.test(name)) return;
      var people = matchPeople(peopleText, roster);
      var pending = [];
      if (numbered || people.some(function (p) { return p.numbered; })) pending.push("编号未解释");
      if (people.some(function (p) { return p.note; })) pending.push("含（替补）备注");

      out.push({
        name: name, duty: duty, people: people, raw: rawLine,
        confidence: people.length ? "中" : "低", pending: pending, selected: true
      });
    });
    if (!out.length) warnings.push("没有识别到岗位行");
    return out;
  }

  function findRoleIdByName(set, name) {
    var n = tidy(name), id = null;
    ((set && set.roles) || []).forEach(function (r) { if (!id && tidy(r.name) === n) id = r.id; });
    return id;
  }

  /* 解析 + 核对。返回 { format, rows, warnings }，rows 里的识别元数据只用于草稿。 */
  function parseRoleTable(text, roster) {
    roster = roster || rosterNames();
    var src = String(text == null ? "" : text);
    var warnings = [];
    var format = "text";
    var t = src.trim();

    if (t) {
      if (/^[\[{]/.test(t)) {
        try { JSON.parse(t); format = "json"; } catch (e) {}
      }
      if (format !== "json") {
        if (/<table\b/i.test(t)) format = "html";
        else if (hasMdTable(t)) format = "markdown";
        else if (/\t/.test(t)) format = "tsv";
        else if (looksCsv(t)) format = "csv";
      }
    }

    var rows = [];
    if (format === "json") {
      try { rows = rowsFromCells(jsonRows(JSON.parse(t)), roster); }
      catch (e) { warnings.push("JSON 读不出来，按纯文本处理"); format = "text"; }
    } else if (format === "html") {
      rows = rowsFromCells(htmlRows(src), roster);
    } else if (format === "markdown") {
      rows = rowsFromCells(mdRows(src), roster);
    } else if (format === "tsv") {
      rows = rowsFromCells(csvRows(src, "\t"), roster);
    } else if (format === "csv") {
      rows = rowsFromCells(csvRows(src, ","), roster);
    }
    if (format === "text") {
      rows = plainRows(src, roster, warnings);
    } else if (!rows.length && (format === "csv" || format === "tsv" || format === "markdown")) {
      warnings.push("表格里没读到岗位行，按纯文本再试一次");
      rows = plainRows(src, roster, warnings);
    } else if (!rows.length) {
      warnings.push("表格里没读到岗位行");
    }
    return { format: format, rows: rows, warnings: warnings };
  }

  function parseImport(text, roster, rolesSet) {
    var res = parseRoleTable(text, roster);
    res.rows.forEach(function (row) {
      row.targetId = findRoleIdByName(rolesSet, row.name);
      if (row.selected === undefined) row.selected = true;
    });
    return res;
  }

  /* 只把选中的行并进草稿：命中现有岗位只改名称/职责，
     其余字段（人员、频率、轮换、顺序）整对象保留；
     新岗位一律 freq=unset——表上没写频率，不猜（PLAN 2.10）。 */
  function mergeRoleImport(roleSet, rows) {
    var out = roleSet && Array.isArray(roleSet.roles) ? clone(roleSet) : { roles: [] };
    if (!Array.isArray(out.roles)) out.roles = [];

    var ids = {};
    out.roles.forEach(function (r) { ids[r.id] = 1; });
    var maxOrder = 0;
    out.roles.forEach(function (r) { if (+r.order > maxOrder) maxOrder = +r.order; });

    var stats = { updated: 0, added: 0, skipped: 0 };
    (rows || []).forEach(function (row) {
      if (!row || row.selected === false || row.applied === true) { stats.skipped++; return; }
      var name = tidy(row.name);
      if (!name) { stats.skipped++; return; }

      var hit = null;
      if (row.targetId) {
        out.roles.forEach(function (r) { if (!hit && r.id === row.targetId) hit = r; });
      }
      if (hit) {
        hit.name = name;
        if (tidy(row.duty)) hit.duty = tidy(row.duty);
        stats.updated++;
        return;
      }

      var people = [];
      (row.people || []).forEach(function (p) {
        var n = "";
        if (p.state === "exact") n = p.resolved || p.name;
        else if (p.state === "typo" && p.accepted) n = p.suggestion || p.resolved;
        if (n && people.indexOf(n) < 0) people.push(n);
      });

      var k = 1, id = "";
      do { id = "imp" + k; k++; } while (ids[id]);
      ids[id] = 1;
      maxOrder += 10;
      out.roles.push({
        id: id, name: name, duty: tidy(row.duty),
        freq: { kind: "unset" }, people: people,
        order: maxOrder, assign: "fixed", grp: null
      });
      stats.added++;
    });
    return { roles: out, updated: stats.updated, added: stats.added, skipped: stats.skipped };
  }

  /* ---------- 草稿：中途关掉不用重填 ---------- */
  function saveDraft() {
    if (!state) return;
    state.ts = Date.now();
    try { root.localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  function readDraft() {
    try {
      var d = JSON.parse(root.localStorage.getItem(KEY) || "null");
      if (!d || !d.blocks || !d.blocks.length) return null;
      if (Date.now() - (d.ts || 0) > DRAFT_DAYS * 864e5) return null;
      return d;
    } catch (e) { return null; }
  }

  function clearDraft() {
    try { root.localStorage.removeItem(KEY); } catch (e) {}
  }

  /* ---------- 从当前生效配置起步 ---------- */
  function loadCurrent() {
    var c = cfg();
    var m = c.meta || {};
    var tt = c.timetable || {};
    var sc = c.schedule || {};
    var roles = clone(c.roles || null);
    var texts = clone(effectiveTexts());

    /* 空包没有作息可改：先套第一套模板，老师只改不一样的地方。
       不这么做，第二步是一张空表，第三个「下一步」也照样能点过去，
       最后得到一张没有段的屏。 */
    var tpl = (!(tt.blocks && tt.blocks.length) && root.RHYTHM_TEMPLATES && root.RHYTHM_TEMPLATES[0]) || null;

    return {
      step: 0,
      school: m.school || tt.school || sc.school || "",
      klass: m.klass || sc.class || "",
      head: m.headTeacher || sc.headTeacher || "",
      term: sc.termStart || "",
      tplId: tpl ? tpl.id : "",
      blocks: clone(tpl ? tpl.blocks : (tt.blocks || [])),
      noonBand: clone(tpl ? tpl.noonBand : (tt.noonBand || null)),
      marks: clone(tpl ? tpl.marks : (tt.marks || [])),
      entries: clone(sc.entries || []),
      roles: roles,
      rolesBase: clone(roles),
      texts: texts,
      textsBase: clone(texts),
      importOpen: false,
      importText: "",
      importHtml: "",
      importRows: [],
      importFlash: "",
      rosterOk: false,
      rosterEdit: false,
      timeText: "",
      timeRows: [],
      timeFlash: "",
      gridText: "",
      gridRows: [],
      gridFlash: "",
      applied: false
    };
  }

  /* 草稿是不是已经和屏上一致。重开向导时，别把昨天已经应用的配置
     说成「还没生效」；只比向导能改的几块，不去比文案的细节。 */
  function draftLive() {
    var c = cfg();
    var m = c.meta || {};
    if ((m.klass || "") !== (state.klass || "")) return false;
    if ((m.school || "") !== (state.school || "")) return false;
    if ((m.headTeacher || "") !== (state.head || "")) return false;
    if (!same((c.timetable || {}).blocks, state.blocks)) return false;
    var cur = ((c.schedule || {}).entries || []).filter(function (e) { return e.subject; });
    var draft = (state.entries || []).filter(function (e) { return e.subject; });
    if (!same(cur, draft)) return false;
    /* 第四步改的文案/岗位还没写回去，也不能算“已生效”，
       否则右下角给一个「完成」，一关就把改动丢了。 */
    if (Object.keys(buildTextPatch(state.texts, state.textsBase)).length) return false;
    return same(c.roles, state.roles);
  }

  function isLive() { return state.applied || draftLive(); }

  /* 旧草稿是 B4 之前存的，没有 roles / texts。补上当前生效值，
     不要把 undefined 当成“老师清空了岗位和文案”。 */
  function fillState(s) {
    if (!s) return s;
    if (!("roles" in s)) s.roles = clone(cfg().roles || null);
    if (!("rolesBase" in s)) s.rolesBase = clone(s.roles);
    if (!("texts" in s)) s.texts = clone(effectiveTexts());
    if (!("textsBase" in s)) s.textsBase = clone(s.texts);
    if (!("importOpen" in s)) s.importOpen = false;
    if (!("importText" in s)) s.importText = "";
    if (!("importHtml" in s)) s.importHtml = "";
    if (!("importRows" in s)) s.importRows = [];
    if (!("importFlash" in s)) s.importFlash = "";
    if (!("rosterOk" in s)) s.rosterOk = false;
    if (!("rosterEdit" in s)) s.rosterEdit = false;
    if (!("timeText" in s)) s.timeText = "";
    if (!("timeRows" in s)) s.timeRows = [];
    if (!("timeFlash" in s)) s.timeFlash = "";
    if (!("gridText" in s)) s.gridText = "";
    if (!("gridRows" in s)) s.gridRows = [];
    if (!("gridFlash" in s)) s.gridFlash = "";
    return s;
  }

  function periodCount() {
    var n = 0;
    (state.blocks || []).forEach(function (b) {
      if (b.type === "class" && +b.periodNo > n) n = +b.periodNo;
    });
    return Math.max(n, 7);
  }

  /* ---------- 校验 ---------- */
  /* 首尾必须相接：留缝会在屏上变成"没有安排的时段"，
     引擎只能跳过，老师却以为那段时间还在上课。 */
  function blockErrors(blocks) {
    var bad = {};
    var prev = null;
    (blocks || state.blocks || []).forEach(function (b, i) {
      if (!b.start || !b.end || b.start >= b.end) bad[i] = "结束要晚于开始";
      else if (prev && b.start !== prev) bad[i] = "和上一段之间有空隙或重叠";
      prev = b.end;
    });
    return bad;
  }

  /* ---------- 渲染 ---------- */
  function render() {
    if (!box) return;
    box.innerHTML = "";
    var panel = el("div", "setup-panel");

    var head = el("div", "setup-head");
    head.appendChild(el("div", "setup-title", "配置这个班"));
    head.appendChild(el("div", "setup-sub", "四步，随时可以关掉，下次接着填"));
    var x = el("button", "setup-x", "×");
    x.type = "button";
    x.setAttribute("aria-label", "关闭");
    x.addEventListener("click", close);
    head.appendChild(x);
    panel.appendChild(head);

    panel.appendChild(steps());

    var body = el("div", "setup-body");
    body.appendChild(state.step === 0 ? pageClass()
      : state.step === 1 ? pageTime()
      : state.step === 2 ? pageGrid()
      : pageDone());
    panel.appendChild(body);

    panel.appendChild(foot());
    box.appendChild(panel);
  }

  function steps() {
    var wrap = el("div", "setup-steps");
    STEP_NAMES.forEach(function (name, i) {
      if (i) wrap.appendChild(el("i"));
      var s = el("div", "setup-step" + (i === state.step ? " on" : (i < state.step ? " done" : "")));
      s.appendChild(el("b", null, String(i + 1)));
      s.appendChild(el("span", null, name));
      wrap.appendChild(s);
    });
    return wrap;
  }

  function field(label, value, onInput, type, placeholder) {
    var row = el("div", "setup-field");
    row.appendChild(el("label", null, label));
    var input = el("input");
    input.type = type || "text";
    input.value = value || "";
    if (placeholder) input.placeholder = placeholder;
    input.addEventListener("input", function () { onInput(input.value.trim()); saveDraft(); });
    row.appendChild(input);
    return row;
  }

  function pageClass() {
    var p = el("div", "setup-page on");
    p.appendChild(el("h3", "setup-h", "先告诉屏，这是哪个班"));
    p.appendChild(el("p", "setup-p", "这两行会出现在左上角、页面标题和消息服务里。以后想改，从「⋯ → 配置班级」再进来。"));
    p.appendChild(field("学校", state.school, function (v) { state.school = v; }, "text", "例如：春江中心小学"));
    p.appendChild(field("班级", state.klass, function (v) { state.klass = v; }, "text", "例如：五（1）班"));
    p.appendChild(field("班主任", state.head, function (v) { state.head = v; }, "text", "可以不填"));
    p.appendChild(field("开学日", state.term, function (v) { state.term = v; }, "date"));
    p.appendChild(el("p", "setup-p", "开学日用来算单双周和值日轮次；填错了只影响单双周课程，不影响作息。"));
    return p;
  }

  function pageTime() {
    var p = el("div", "setup-page on");
    p.appendChild(el("h3", "setup-h", "作息：先套一套相近的，再改不一样的地方"));
    p.appendChild(el("p", "setup-p", "下面每一段的开始和结束都能改。相邻两段必须首尾相接，中间不能留空。"));

    var tpls = el("div", "setup-tpls");
    (root.RHYTHM_TEMPLATES || []).forEach(function (t) {
      var b = el("button", "setup-tpl" + (state.tplId === t.id ? " on" : ""));
      b.type = "button";
      b.appendChild(el("b", null, t.label));
      b.appendChild(el("span", null, t.note));
      b.addEventListener("click", function () {
        if (!root.confirm || root.confirm("套用「" + t.label + "」会覆盖下面已经改过的时间，继续？")) {
          state.tplId = t.id;
          state.blocks = clone(t.blocks);
          state.noonBand = clone(t.noonBand);
          state.marks = clone(t.marks);
          saveDraft();
          render();
        }
      });
      tpls.appendChild(b);
    });
    p.appendChild(tpls);

    var bad = blockErrors();
    var list = el("div", "setup-blocks");
    var head = el("div", "setup-row head");
    ["段", "内容", "开始", "结束"].forEach(function (t) { head.appendChild(el("span", null, t)); });
    list.appendChild(head);

    state.blocks.forEach(function (b, i) {
      var row = el("div", "setup-row" + (bad[i] ? " bad" : ""));
      row.appendChild(el("span", "k", String(i + 1)));

      var name = b.type === "class" ? ("第 " + b.periodNo + " 节")
        : (b.name || b.type);
      row.appendChild(el("span", null, name));

      ["start", "end"].forEach(function (k) {
        var cell = el("span", "t");
        var inp = el("input");
        inp.type = "time";
        inp.value = b[k] || "";
        inp.addEventListener("change", function () {
          b[k] = inp.value;
          saveDraft();
          render();
        });
        cell.appendChild(inp);
        row.appendChild(cell);
      });
      list.appendChild(row);
    });
    p.appendChild(list);

    if (Object.keys(bad).length) {
      p.appendChild(el("p", "setup-msg", "有 " + Object.keys(bad).length + " 段时间不对，红色那几行改好才能继续。"));
    }
    p.appendChild(timeImportBox());
    return p;
  }

  /* 作息表导入：只改上面这张表里的时间，不改文件结构，也不猜表里没写的段。 */
  function timeImportBox() {
    var box = el("div", "setup-import");
    box.appendChild(el("p", "setup-p",
      "也可以直接读学校的作息表（.xlsx / .docx），或把表复制粘贴进来。"
      + "表里只写节次时间也行：空档会补成课间；午餐、午休按表上写的区间原样保留。"));

    var ta = el("textarea", "setup-import-text");
    ta.rows = 6;
    ta.value = state.timeText || "";
    ta.placeholder = "8:20—9:00\t第 一 节\n9:00—9:30\t大课间（升旗仪式）";
    ta.addEventListener("input", function () { state.timeText = ta.value; saveDraft(); });
    box.appendChild(ta);

    var row = el("div", "setup-import-file-row");
    row.appendChild(el("span", "setup-import-file-tip", "或直接选文件："));
    var f = el("input", "setup-time-file");
    f.type = "file";
    f.accept = ".xlsx,.docx";
    f.addEventListener("change", function () { pickTimeFile(f); });
    row.appendChild(f);
    box.appendChild(row);

    var acts = el("div", "setup-actions");
    var run = el("button", "setup-btn setup-time-run", "识别作息表");
    run.type = "button";
    run.addEventListener("click", runTimeImport);
    acts.appendChild(run);

    var use = el("button", "setup-btn primary setup-time-apply", "套用到作息");
    use.type = "button";
    use.disabled = !(state.timeRows && state.timeRows.length);
    use.addEventListener("click", applyTimeImport);
    acts.appendChild(use);
    box.appendChild(acts);

    if (state.timeFlash) {
      box.appendChild(el("p", "setup-msg", state.timeFlash));
    }
    return box;
  }

  function pickTimeFile(input) {
    readPickedFile(input).then(function (res) {
      if (!res) return;
      state.timeText = res.text;
      state.timeRows = parseTimeRows(res.text);
      var r = blocksFromTimeRows(state.timeRows);
      state.timeFlash = "「" + res.name + "」读到 " + state.timeRows.length + " 行"
        + (r.bad ? "；" + r.bad : "；确认后点「套用到作息」");
      saveDraft();
      render();
    }).catch(function (err) {
      state.timeFlash = "读不了这个文件：" + (err && err.message ? err.message : "格式不对");
      saveDraft();
      render();
    });
    input.value = "";
  }

  function runTimeImport() {
    state.timeRows = parseTimeRows(state.timeText);
    state.timeFlash = state.timeRows.length
      ? "读到 " + state.timeRows.length + " 行，确认后点「套用到作息」"
      : "没读到「8:20—9:00」这样的时间行";
    saveDraft();
    render();
  }

  function applyTimeImport() {
    var r = blocksFromTimeRows(state.timeRows);
    if (r.bad) {
      state.timeFlash = r.bad;
      saveDraft();
      render();
      return;
    }
    state.blocks = r.blocks;
    state.noonBand = noonBandOf(r.blocks) || state.noonBand;
    state.tplId = "";
    state.timeFlash = "已套用作息：共 " + r.blocks.length + " 段"
      + (r.skipped.length ? "；跳过 " + r.skipped.length + " 行（" + r.skipped.join("、") + "）" : "");
    saveDraft();
    render();
  }

  function pageGrid() {
    var p = el("div", "setup-page on");
    p.appendChild(el("h3", "setup-h", "课表：5 天 × " + periodCount() + " 节"));
    p.appendChild(el("p", "setup-p", "只填科目就行，任课老师可以以后再说。空着的格子屏上显示「—」，不会报错。"));

    var subjects = {};
    var content = cfg().content;
    ((content && content.subjects) || []).forEach(function (s) {
      (s.labels || [s.key]).forEach(function (l) { subjects[l] = 1; });
    });
    ["语文", "数学", "英语", "体育", "音乐", "美术", "科学", "信息", "书法", "劳综"].forEach(function (s) { subjects[s] = 1; });

    var dl = el("datalist");
    dl.id = "setup-subjects";
    Object.keys(subjects).forEach(function (s) {
      var o = el("option"); o.value = s; dl.appendChild(o);
    });
    p.appendChild(dl);

    var grid = el("div", "setup-grid");
    var head = el("div", "setup-grid-row head");
    head.appendChild(el("span", null, "节"));
    ["周一", "周二", "周三", "周四", "周五"].forEach(function (d) {
      head.appendChild(el("span", null, d));
    });
    grid.appendChild(head);

    for (var n = 1; n <= periodCount(); n++) {
      var row = el("div", "setup-grid-row");
      row.appendChild(el("span", "no", String(n)));
      for (var w = 1; w <= 5; w++) {
        (function (w, n) {
          var cell = el("span");
          var inp = el("input");
          inp.type = "text";
          inp.setAttribute("list", "setup-subjects");
          var hit = state.entries.filter(function (e) {
            return +e.weekday === w && +e.periodNo === n;
          })[0];
          inp.value = (hit && hit.subject) || "";
          inp.addEventListener("input", function () {
            setEntry(w, n, inp.value.trim());
            saveDraft();
          });
          cell.appendChild(inp);
          row.appendChild(cell);
        })(w, n);
      }
      grid.appendChild(row);
    }
    p.appendChild(grid);

    if (!state.blocks.length) {
      p.appendChild(el("p", "setup-msg", "还没套用作息模板，课表排不进时间。先回上一步。"));
    }
    p.appendChild(gridImportBox());
    return p;
  }

  /* 班级课表导入：认「周一…周五」列和「第 N 节」行，老师名跟着格子存。 */
  function gridImportBox() {
    var box = el("div", "setup-import");
    box.appendChild(el("p", "setup-p",
      "也可以直接读班级课表（.xlsx / .docx），或把表复制粘贴进来。"
      + "只认「周一…周五」和「第 N 节」；格子里第二行的任课老师会跟着这一格存下来（本次不显示），"
      + "单双周轮流的两位老师原样保留。"));

    var ta = el("textarea", "setup-import-text");
    ta.rows = 6;
    ta.value = state.gridText || "";
    ta.placeholder = "第 1 节\t英语\t语文\t语文\t语文\t数学";
    ta.addEventListener("input", function () { state.gridText = ta.value; saveDraft(); });
    box.appendChild(ta);

    var row = el("div", "setup-import-file-row");
    row.appendChild(el("span", "setup-import-file-tip", "或直接选文件："));
    var f = el("input", "setup-grid-file");
    f.type = "file";
    f.accept = ".xlsx,.docx";
    f.addEventListener("change", function () { pickGridFile(f); });
    row.appendChild(f);
    box.appendChild(row);

    var acts = el("div", "setup-actions");
    var run = el("button", "setup-btn setup-grid-run", "识别课表");
    run.type = "button";
    run.addEventListener("click", runGridImport);
    acts.appendChild(run);

    var use = el("button", "setup-btn primary setup-grid-apply", "填入课表");
    use.type = "button";
    use.disabled = !(state.gridRows && state.gridRows.length > 1);
    use.addEventListener("click", applyGridImport);
    acts.appendChild(use);
    box.appendChild(acts);

    if (state.gridFlash) {
      box.appendChild(el("p", "setup-msg", state.gridFlash));
    }
    return box;
  }

  function pickGridFile(input) {
    readPickedFile(input).then(function (res) {
      if (!res) return;
      state.gridText = res.text;
      state.gridRows = gridCellRows(res.text);
      var r = gridFromRows(state.gridRows);
      state.gridFlash = "「" + res.name + "」" + (r.bad
        ? r.bad
        : "识别到 " + r.entries.length + " 格，确认后点「填入课表」");
      saveDraft();
      render();
    }).catch(function (err) {
      state.gridFlash = "读不了这个文件：" + (err && err.message ? err.message : "格式不对");
      saveDraft();
      render();
    });
    input.value = "";
  }

  function runGridImport() {
    state.gridRows = gridCellRows(state.gridText);
    var r = gridFromRows(state.gridRows);
    state.gridFlash = r.bad || ("识别到 " + r.entries.length + " 格，确认后点「填入课表」");
    saveDraft();
    render();
  }

  function applyGridImport() {
    var r = gridFromRows(state.gridRows);
    if (r.bad) {
      state.gridFlash = r.bad;
      saveDraft();
      render();
      return;
    }
    state.entries = r.entries;
    state.gridFlash = "已填入 " + r.entries.length + " 格（覆盖原课表）"
      + (r.skipped.length ? "；跳过 " + r.skipped.length + " 行" : "");
    saveDraft();
    render();
  }

  function setEntry(w, n, subject) {
    var hit = null;
    state.entries.forEach(function (e) {
      if (+e.weekday === w && +e.periodNo === n) hit = e;
    });
    if (!subject) {
      if (hit) state.entries = state.entries.filter(function (e) { return e !== hit; });
      return;
    }
    if (hit) {
      /* 换了科目就不再认原来的任课老师；科目没动时老师照旧留着。 */
      if (hit.subject !== subject) delete hit.teacher;
      hit.subject = subject;
    } else state.entries.push({ weekday: w, periodNo: n, subject: subject });
  }

  /* ---------- 第四步：岗位 / 文案 ---------- */
  /* 只列课表里已经用到的科目：没排课的科目写了准备清单也不会出现在屏上。 */
  function usedSubjects() {
    var used = {}, out = [];
    (state.entries || []).forEach(function (e) { if (e.subject) used[e.subject] = 1; });
    ((cfg().content || {}).subjects || []).forEach(function (s) {
      (s.labels || [s.key]).forEach(function (l) {
        if (used[l] && out.indexOf(s.key) < 0) out.push(s.key);
      });
    });
    Object.keys(used).forEach(function (u) { if (out.indexOf(u) < 0) out.push(u); });
    return out;
  }

  /* 提示语只做作息里真有名字的时段；正课的名字来自课表，不在这里改。 */
  function tipBlocks() {
    var seen = {}, out = [];
    (state.blocks || []).forEach(function (b) {
      if (b.type === "class" || !b.name || seen[b.name]) return;
      seen[b.name] = 1;
      out.push({ name: b.name, tip: b.tip || "" });
    });
    return out;
  }

  function textAt(keys) {
    var n = state.texts || {};
    for (var i = 0; i < keys.length; i++) {
      if (n == null) return "";
      n = n[keys[i]];
    }
    return n == null ? "" : n;
  }

  function setText(keys, value) {
    if (!state.texts) state.texts = {};
    var parents = [state.texts];
    var n = state.texts;
    for (var i = 0; i < keys.length - 1; i++) {
      if (!n[keys[i]] || typeof n[keys[i]] !== "object") n[keys[i]] = {};
      n = n[keys[i]];
      parents.push(n);
    }
    var last = keys[keys.length - 1];
    var v = value == null ? "" : String(value).trim();
    if (v) n[last] = v;
    else delete n[last];
    /* 空父节点一起删：补丁里留空对象会分不清“没改”和“清空”。 */
    for (var j = keys.length - 2; j >= 0; j--) {
      if (parents[j][keys[j]] && Object.keys(parents[j][keys[j]]).length) break;
      delete parents[j][keys[j]];
    }
  }

  function setBreakActions(body) {
    if (!state.texts) state.texts = {};
    var list = String(body || "").split(/[,，、;；\s]+/)
      .map(function (s) { return s.trim(); }).filter(Boolean);
    if (list.length) state.texts.breakActions = list;
    else delete state.texts.breakActions;
  }

  function textSection(title, hint, rows, open) {
    var d = el("details", "setup-text-sec");
    if (open) d.setAttribute("open", "");
    var s = el("summary", "setup-text-head");
    s.appendChild(el("span", "setup-text-title", title));
    s.appendChild(el("span", "setup-text-hint", hint || ""));
    d.appendChild(s);
    rows.forEach(function (r) { d.appendChild(r); });
    return d;
  }

  function importField(label, value, onInput, cls, placeholder) {
    var row = el("div", "setup-import-field");
    row.appendChild(el("label", null, label));
    var input = el("input");
    input.className = cls;
    input.value = value || "";
    input.placeholder = placeholder || "";
    input.addEventListener("input", function () { onInput(input.value.trim()); saveDraft(); });
    row.appendChild(input);
    return row;
  }

  function roleNameOf(id) {
    var hit = null;
    ((state.roles && state.roles.roles) || []).forEach(function (r) { if (!hit && r.id === id) hit = r; });
    return hit ? hit.name : "";
  }

  function importStart(p) {
    var bar = el("div", "setup-import-bar");
    var btn = el("button", "setup-btn setup-import-open", state.importOpen ? "收起岗位表导入" : "从岗位表导入");
    btn.type = "button";
    btn.addEventListener("click", function () {
      state.importOpen = !state.importOpen;
      saveDraft();
      render();
    });
    bar.appendChild(btn);
    if (state.importRows && state.importRows.length && !state.importOpen) {
      var picked = state.importRows.filter(function (r) { return r.selected !== false; }).length;
      bar.appendChild(el("span", "setup-import-count",
        "上次识别到 " + state.importRows.length + " 行，已选 " + picked + " 行"));
    }
    p.appendChild(bar);
    if (state.importOpen) p.appendChild(importPanel());
  }

  function importPanel() {
    var wrap = el("div", "setup-import");
    wrap.appendChild(el("p", "setup-p",
      "岗位表里的姓名要按学生名单核对，所以分两步：先确认学生名单，再上传岗位表。一份一份来。"));

    wrap.appendChild(rosterBlock());

    if (state.rosterOk) wrap.appendChild(roleBlock());
    else wrap.appendChild(el("p", "setup-msg setup-import-gate",
      "确认学生名单后，「岗位表」这一步才会出现。"));

    var foot = el("div", "setup-actions");
    var cancel = el("button", "setup-btn ghost setup-import-cancel", "取消");
    cancel.type = "button";
    cancel.addEventListener("click", function () {
      state.importOpen = false;
      state.importFlash = "";
      saveDraft();
      render();
    });
    foot.appendChild(cancel);
    wrap.appendChild(foot);
    return wrap;
  }

  /* 第一步：学生名单。岗位表里的姓名只有这一份依据，
     名单还没确认就不让上传岗位表，避免对着空名册核对。 */
  function rosterBlock() {
    var box = el("div", "setup-import-block");
    var head = el("div", "setup-import-block-head");
    head.appendChild(el("span", "setup-import-step", "①"));
    head.appendChild(el("span", "setup-import-block-title", "学生名单"));
    if (state.rosterOk) head.appendChild(el("span", "setup-import-tag applied", "已确认"));
    box.appendChild(head);

    var names = rosterNames();
    if (!names.length) {
      box.appendChild(el("p", "setup-import-req",
        "名册是空的：没有可对照的姓名，岗位表里的姓名会全部变成「未找到」。"
        + "先让制作者把班级名单补进班级数据。"));
      return box;
    }

    box.appendChild(el("p", "setup-import-req",
      "名册 " + names.length + " 人" + (rosterOverride() ? "（本机修正过）" : "，来自班级数据")
      + "。岗位表里的姓名只按这份名单核对；对不上的会标「疑似错字 / 未找到 / 同名」，"
      + "不会自动改名册，也不会新增学生。"));
    box.appendChild(el("div", "setup-import-roster-names", names.join("、")));

    var tools = el("div", "setup-actions setup-roster-tools");
    var fix = el("button", "setup-btn setup-roster-fix",
      state.rosterEdit ? "正在修正…" : "修正名单");
    fix.type = "button";
    fix.addEventListener("click", function () {
      state.rosterEdit = true;
      render();
    });
    tools.appendChild(fix);

    if (rosterOverride()) {
      var back = el("button", "setup-btn ghost setup-roster-reset", "恢复班级名单");
      back.type = "button";
      back.addEventListener("click", function () {
        root.Store.patchConfig({ students: null });
        state.rosterEdit = false;
        state.rosterOk = false;
        state.importRows = [];
        state.importFlash = "已恢复班级数据里的名单。";
        saveDraft();
        render();
      });
      tools.appendChild(back);
    }
    box.appendChild(tools);

    if (state.rosterEdit) {
      var ed = el("textarea", "setup-import-text setup-roster-text");
      ed.rows = 8;
      ed.value = names.join("\n");
      box.appendChild(ed);
      box.appendChild(el("p", "setup-import-req",
        "一行一个姓名。修正只在本机生效、只用于核对姓名，不写回班级数据；"
        + "同名可以保留，核对时会标「同名」。保存后要重新确认名单。"));

      var edActs = el("div", "setup-actions setup-roster-edit-acts");
      var save = el("button", "setup-btn primary setup-roster-save", "保存修正");
      save.type = "button";
      save.addEventListener("click", function () {
        var r = saveRoster(ed.value);
        if (!r.ok) {
          state.importFlash = r.why;
          saveDraft();
          render();
          return;
        }
        state.rosterEdit = false;
        state.rosterOk = false;      /* 名单变了，之前的核对结果作废 */
        state.importRows = [];
        state.importFlash = "名单已修正为 " + r.n + " 人（本机生效，只用于核对）。";
        saveDraft();
        render();
      });
      edActs.appendChild(save);

      var drop = el("button", "setup-btn ghost setup-roster-cancel", "取消修正");
      drop.type = "button";
      drop.addEventListener("click", function () {
        state.rosterEdit = false;
        render();
      });
      edActs.appendChild(drop);
      box.appendChild(edActs);
    }

    if (!state.rosterOk) {
      var ok = el("button", "setup-btn primary setup-roster-ok", "名单没问题，下一步");
      ok.type = "button";
      ok.addEventListener("click", function () {
        state.rosterOk = true;
        saveDraft();
        render();
      });
      box.appendChild(ok);
    }
    return box;
  }

  /* 第二步：岗位表。整个面板只有这一个上传入口，且一次只读一个文件。 */
  function roleBlock() {
    var box = el("div", "setup-import-block");
    var head = el("div", "setup-import-block-head");
    head.appendChild(el("span", "setup-import-step", "②"));
    head.appendChild(el("span", "setup-import-block-title", "岗位表"));
    box.appendChild(head);

    [
      "表头含「岗位 / 项目」「职责 / 内容」「负责人 / 姓名」，一行一个岗位。",
      "多个姓名用「、」分隔；表上的数字编号只当编号，不当周几。",
      "支持 .xlsx / .docx（老的 .xls / .doc 请另存）；也能从 Excel / Word / 微信复制整张表粘贴。",
      "一次只上传一个文件，识别结果确认无误后再并入草稿。"
    ].forEach(function (t) {
      box.appendChild(el("p", "setup-import-req", t));
    });

    var ta = el("textarea", "setup-import-text");
    ta.rows = 5;
    ta.value = state.importText || "";
    ta.placeholder = "岗位\t职责\t负责人\n路队长\t提醒排队\t孙星野、孔子墨";
    /* 从 Word / Excel 直接粘贴时，剪贴板里除了纯文本还有一份 HTML 表格。
       textarea 只会插入纯文本，所以在这里把 HTML 结构也接住；
       识别时优先用它，读不到再退回纯文本。 */
    var pastedHtml = false;
    ta.addEventListener("paste", function (e) {
      var cd = e && (e.clipboardData || root.clipboardData);
      var html = "";
      try { html = cd && cd.getData ? cd.getData("text/html") : ""; } catch (err) { html = ""; }
      if (html && /<table\b/i.test(html)) {
        state.importHtml = html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
        pastedHtml = true;
      } else {
        state.importHtml = "";
      }
    });
    ta.addEventListener("input", function () {
      state.importText = ta.value;
      if (!pastedHtml) state.importHtml = "";
      pastedHtml = false;
      saveDraft();
    });
    box.appendChild(ta);

    var fileRow = el("div", "setup-import-file-row");
    fileRow.appendChild(el("span", "setup-import-file-tip", "或直接选文件："));
    var fileInput = el("input", "setup-import-file");
    fileInput.type = "file";
    fileInput.accept = ".xlsx,.docx";
    fileInput.addEventListener("change", function () { pickOfficeFile(fileInput); });
    fileRow.appendChild(fileInput);
    box.appendChild(fileRow);

    var acts = el("div", "setup-actions");
    var run = el("button", "setup-btn primary setup-import-run", "识别");
    run.type = "button";
    run.addEventListener("click", runImport);
    acts.appendChild(run);

    if (state.importRows && state.importRows.length) {
      var all = el("button", "setup-btn setup-import-all", "全部选中");
      all.type = "button";
      all.addEventListener("click", function () { setAllRows(true); });
      acts.appendChild(all);

      var none = el("button", "setup-btn setup-import-none", "全不选");
      none.type = "button";
      none.addEventListener("click", function () { setAllRows(false); });
      acts.appendChild(none);
    }
    box.appendChild(acts);

    if (state.importFlash) {
      box.appendChild(el("p", "setup-msg" + (state.importRows && state.importRows.length ? " ok" : ""),
        state.importFlash));
    }

    if (state.importRows && state.importRows.length) box.appendChild(importPreview());

    box.appendChild(el("p", "setup-p",
      "未找到和同名的姓名不会写入，也不会自动新增学生；识别记录只留在草稿里，"
      + "不会出现在 roles.json。表上的数字编号只当编号，不当周几。"));

    var foot = el("div", "setup-actions");
    var apply = el("button", "setup-btn primary setup-import-apply", "并入草稿（不保存大屏）");
    apply.type = "button";
    apply.addEventListener("click", applyImport);
    foot.appendChild(apply);
    box.appendChild(foot);
    return box;
  }

  function importPreview() {
    var wrap = el("div", "setup-import-preview");
    var st = countPeopleStates(state.importRows);
    wrap.appendChild(el("div", "setup-import-sum",
      "识别 " + state.importRows.length + " 个岗位 · 姓名精确 " + st.exact
      + " · 疑似错字 " + st.typo + " · 未找到 " + st.missing + " · 同名 " + st.same));

    state.importRows.forEach(function (row) {
      var card = el("div", "setup-import-row");

      var head = el("div", "setup-import-row-head");
      var pick = el("input");
      pick.type = "checkbox";
      pick.className = "setup-import-pick";
      pick.checked = row.selected !== false;
      pick.addEventListener("change", function () { row.selected = pick.checked; saveDraft(); });
      head.appendChild(pick);

      var name = el("input");
      name.className = "setup-import-name";
      name.value = row.name || "";
      name.placeholder = "岗位名";
      name.addEventListener("input", function () { row.name = name.value.trim(); saveDraft(); });
      head.appendChild(name);

      head.appendChild(el("span", "setup-import-tag " + (row.targetId ? "update" : "add"),
        row.targetId ? "更新「" + (roleNameOf(row.targetId) || row.name) + "」" : "新增岗位"));
      head.appendChild(el("span", "setup-import-conf", "置信度 " + (row.confidence || "中")));
      if (row.applied) head.appendChild(el("span", "setup-import-tag applied", "已并入草稿"));
      card.appendChild(head);

      card.appendChild(importField("职责", row.duty || "", function (v) { row.duty = v; },
        "setup-import-duty", "可以留空"));

      var people = el("div", "setup-import-people");
      if (!row.people || !row.people.length) {
        people.appendChild(el("span", "setup-import-person bad", "没有识别到人员"));
      }
      (row.people || []).forEach(function (p) {
        var chip = el("span", "setup-import-person " + p.state);
        if (p.state === "exact") {
          chip.textContent = "✓ " + (p.resolved || p.name);
        } else if (p.state === "typo") {
          if (p.accepted) {
            chip.textContent = "✓ " + p.suggestion + "（已采用）";
          } else {
            chip.appendChild(el("span", null, "疑似 " + p.name + " → " + p.suggestion));
            var use = el("button", "setup-import-use", "采用");
            use.type = "button";
            use.addEventListener("click", function () {
              p.accepted = true;
              p.resolved = p.suggestion;
              saveDraft();
              render();
            });
            chip.appendChild(use);
          }
        } else if (p.state === "same") {
          chip.textContent = "同名 " + p.name + "（不采用）";
        } else {
          chip.textContent = "未找到 " + p.name + "（不采用）";
        }
        people.appendChild(chip);
      });
      card.appendChild(people);

      if (row.pending && row.pending.length) {
        var pd = el("div", "setup-import-pending");
        row.pending.forEach(function (t) { pd.appendChild(el("span", null, t)); });
        card.appendChild(pd);
      }

      if (row.raw) card.appendChild(el("div", "setup-import-raw", "原文：" + row.raw));
      wrap.appendChild(card);
    });
    return wrap;
  }

  function setAllRows(v) {
    (state.importRows || []).forEach(function (r) { r.selected = v; });
    saveDraft();
    render();
  }

  function pickOfficeFile(input) {
    var f = input.files && input.files[0];
    if (!f) return;
    var filename = f.name || "";
    var p;
    try {
      p = f.arrayBuffer ? f.arrayBuffer() : Promise.reject(new Error("这个浏览器不支持读文件，请把表格粘贴进来"));
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(function (buf) { return readOfficeFile(buf, filename); })
      .then(function (res) {
        state.importText = res.text;
        state.importHtml = "";
        var parsed = parseImport(res.text, rosterNames(), state.roles);
        state.importRows = parsed.rows;
        state.importOpen = true;
        if (parsed.rows.length) {
          var where = res.format === "xlsx"
            ? "第一个工作表" + (res.sheetName ? "「" + res.sheetName + "」" : "")
            : "文档里最大的表格";
          state.importFlash = "从「" + filename + "」读到 " + parsed.rows.length
            + " 个岗位（" + where + "）。核对姓名后再并入草稿。";
        } else {
          state.importFlash = "从「" + filename + "」没读到岗位行；可以试试把表格复制粘贴进来。";
        }
        saveDraft();
        render();
      })
      .catch(function (err) {
        state.importFlash = "读不了「" + filename + "」："
          + (err && err.message ? err.message : "文件格式不对");
        saveDraft();
        render();
      });
    input.value = "";
  }

  function runImport() {
    var text = state.importText || "";
    var html = state.importHtml || "";
    if (!text.trim() && !html.trim()) {
      state.importRows = [];
      state.importFlash = "先粘贴岗位表，再点「识别」。";
      saveDraft();
      render();
      return;
    }
    var usedHtml = !!html && /<table\b/i.test(html);
    var res = parseImport(usedHtml ? html : text, rosterNames(), state.roles);
    if (!res.rows.length && usedHtml && text.trim()) res = parseImport(text, rosterNames(), state.roles);
    state.importRows = res.rows;
    state.importOpen = true;
    if (!res.rows.length) {
      state.importFlash = (res.warnings && res.warnings.length ? res.warnings[0] + "。" : "")
        + "支持表格、CSV / TSV、Markdown、JSON 和 Excel 复制出的表格。";
    } else {
      state.importFlash = "识别到 " + res.rows.length + " 个岗位（" + formatLabel(res.format)
        + "）。先核对姓名，再并入草稿。";
    }
    saveDraft();
    render();
  }

  function applyImport() {
    var picked = (state.importRows || []).filter(function (r) {
      return r.selected !== false && tidy(r.name);
    });
    if (!picked.length) {
      state.importFlash = "至少选一个岗位行。";
      saveDraft();
      render();
      return;
    }
    if (!picked.filter(function (r) { return r.applied !== true; }).length) {
      state.importFlash = "这些行已经并入过草稿；改表后请重新点「识别」。";
      saveDraft();
      render();
      return;
    }
    var m = mergeRoleImport(state.roles, state.importRows);
    picked.forEach(function (r) { r.applied = true; });
    state.roles = m.roles;
    state.importOpen = false;
    state.importFlash = "";
    state.flash = "已并入草稿：更新 " + m.updated + " 个，新增 " + m.added
      + " 个岗位（执行频率未设置，不会上屏）。点「应用到这台机器」才写进大屏。";
    saveDraft();
    render();
  }

  function roleSection(p) {
    var rs = state.roles;
    if (!rs || !Array.isArray(rs.roles) || !rs.roles.length) {
      p.appendChild(el("p", "setup-p",
        "这个包没有岗位表。可以粘贴一张岗位表，或跳过这一步——跳过不影响前面三步。"));
      importStart(p);
      return;
    }

    var src = el("div", "setup-src");
    if (rs.class && rs.class !== state.klass) {
      src.classList.add("warn");
      src.appendChild(el("b", null, "这些岗位来自打包来源班「" + rs.class + "」"));
      src.appendChild(el("span", null, "现在配的是「" + (state.klass || "未填") + "」。"
        + "可以只改名称、职责和执行频率里的时间；人员、轮换规则都原样保留。"
        + "不想用就跳过这一步——屏上不会写入任何岗位。"));
    } else {
      src.appendChild(el("b", null, "岗位清单：共 " + rs.roles.length + " 个"
        + (rs.class ? "（来源班「" + rs.class + "」）" : "")));
      src.appendChild(el("span", null, "只改名称、职责和执行频率里的时间；人员、轮换规则原样保留。"));
    }
    p.appendChild(src);
    importStart(p);

    var list = el("div", "setup-roles");
    rs.roles.forEach(function (r) {
      var card = el("div", "setup-role");

      var head = el("div", "setup-role-head");
      var f = r.freq || {};
      head.appendChild(el("span", "setup-role-id", r.id));
      var freqEl = el("span", "setup-role-freq" + (f.kind === "unset" ? " unset" : ""), freqText(f));
      head.appendChild(freqEl);
      card.appendChild(head);

      card.appendChild(field("名称", r.name, function (v) {
        state.roles = editRole(state.roles, r.id, "name", v);
      }));
      card.appendChild(field("职责", r.duty || "", function (v) {
        state.roles = editRole(state.roles, r.id, "duty", v);
      }, "text", "一句话写清要做什么"));

      /* 执行频率里的时间：有时间的岗位逐条给输入框，改一处只动这一处。
         kind 为 unset / each / task 的没有时间可填，保持只读说明。 */
      if (Array.isArray(f.times) && f.times.length) {
        f.times.forEach(function (t, i) {
          card.appendChild(field("时间", t, function (v) {
            var now = (state.roles.roles.filter(function (x) { return x.id === r.id; })[0] || {}).freq || {};
            var times = (now.times || []).slice();
            times[i] = v;
            state.roles = editRoleFreqTimes(state.roles, r.id, times);
            freqEl.textContent = freqText(now.kind ? { kind: now.kind, event: now.event,
              task: now.task, times: times } : { kind: "unset" });
          }, "time"));
        });
      }

      list.appendChild(card);
    });
    p.appendChild(list);
  }

  function textSectionList(p) {
    var T = state.texts || {};

    var d1 = textSection("每天提醒", "早读时黄色贴纸上的那句话", [
      field("每天提醒", textAt(["reminders", "default"]),
        function (v) { setText(["reminders", "default"], v); },
        "text", "带齐今天要用的书和作业，课前摆好。")
    ], true);
    p.appendChild(d1);

    var stageRows = [];
    STAGES.forEach(function (st) {
      stageRows.push(field(st.label + " · 大字",
        textAt(["stage", st.key, "title"]),
        function (v) { setText(["stage", st.key, "title"], v); },
        "text", st.title));
      stageRows.push(field(st.label + " · 一句话",
        textAt(["stage", st.key, "note"]),
        function (v) { setText(["stage", st.key, "note"], v); },
        "text", st.note));
    });
    p.appendChild(textSection("到校 · 放学 · 休息日", "这三句话不在作息里，是每天的两头", stageRows));

    var brRows = [
      field("课间 · 大字", textAt(["breakTitle"]),
        function (v) { setText(["breakTitle"], v); }, "text", "课间"),
      field("课间 · 第一行", (T.breakActions || []).join("，"),
        function (v) { setBreakActions(v); }, "text", "喝水，上厕所"),
      field("课间 · 第二行开头", textAt(["prepLabel"]),
        function (v) { setText(["prepLabel"], v); }, "text", "准备好")
    ];
    p.appendChild(textSection("课间这一屏", "大字一行，下面两行：先做什么、带什么", brRows));

    var readRows = [];
    WEEKDAYS.forEach(function (w) {
      var key = String(w.n);
      readRows.push(field(w.label + " · 科目", textAt(["reading", key, "subject"]),
        function (v) { setText(["reading", key, "subject"], v); }, "text", "语文"));
      readRows.push(field(w.label + " · 学习建议", textAt(["reading", key, "task"]),
        function (v) { setText(["reading", key, "task"], v); },
        "text", "今天读第 5 课，背《古诗三首》"));
    });
    p.appendChild(textSection("早读 5 天建议", "科目空着这一天就只显示「早读」，不猜", readRows));

    var prepRows = [];
    var subs = (cfg().content || {}).subjects || [];
    usedSubjects().forEach(function (key) {
      var s = subs.filter(function (x) { return x.key === key; })[0];
      prepRows.push(field(key + " · 要带什么", (textAt(["prep", key]) || []).join("，"),
        function (v) {
          if (!state.texts) state.texts = {};
          var list = String(v || "").split(/[,，、;；\s]+/)
            .map(function (x) { return x.trim(); }).filter(Boolean);
          if (!state.texts.prep) state.texts.prep = {};
          if (list.length) state.texts.prep[key] = list;
          else {
            delete state.texts.prep[key];
            if (!Object.keys(state.texts.prep).length) delete state.texts.prep;
          }
        },
        "text", s ? (s.items || []).join("，") : "用逗号隔开"));
    });
    if (prepRows.length) {
      p.appendChild(textSection("每科要带什么", "只列课表里已经排到的科目", prepRows));
    }

    var tipRows = [];
    tipBlocks().forEach(function (b) {
      tipRows.push(field(b.name, textAt(["tips", b.name]),
        function (v) { setText(["tips", b.name], v); },
        "text", b.tip || "（这一时段没有提示语）"));
    });
    if (tipRows.length) {
      p.appendChild(textSection("各时段的提示语", "只列有名字的时段；留空就是原来的话", tipRows));
    }
  }

  /* ---------- 完成页：时间线预览 ----------
     配完不用等到明天：用草稿里的作息和课表现算一天给老师看。
     不走 Runtime.day()，那份缓存读的是已保存的配置，看不到还没应用的改动。 */
  var TL_TYPE = {
    class: "上课", break: "课间", meal: "午餐", noon: "午间",
    ritual: "固定", after: "课后服务", closed: "放学"
  };

  function dayKeyShift(key, n) {
    var p = String(key).split("-");
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    d.setUTCDate(d.getUTCDate() + n);
    return d.getUTCFullYear() + "-" +
      (d.getUTCMonth() < 9 ? "0" : "") + (d.getUTCMonth() + 1) + "-" +
      (d.getUTCDate() < 10 ? "0" : "") + d.getUTCDate();
  }

  function draftConfig() {
    var c = cfg();
    var tt = clone(c.timetable || {});
    tt.blocks = clone(state.blocks || []);
    if (state.noonBand) tt.noonBand = clone(state.noonBand);
    var sc = clone(c.schedule || {});
    sc.entries = clone(state.entries || []);
    sc.class = state.klass;
    /* 空包没有午间规则；给一个最普通的，预览才不至于算不出来。
       这和 runtime.js 的 EMPTY_NOON 是同一份兜底。 */
    var noon = c.noon || {
      defaultPreset: "rest", weekRule: {},
      presets: {
        rest: { label: "午间", title: "午间休息", items: [], tip: "闭眼趴一会儿，不说话，不追跑" }
      }
    };
    return {
      meta: { school: state.school, klass: state.klass, headTeacher: state.head },
      timetable: tt,
      schedule: sc,
      content: c.content || [],
      roles: c.roles || { roles: [], dutyCycle: {} },
      noon: noon,
      calendar: c.calendar || { days: {} }
    };
  }

  /* 今天不上学（周末 / 节假日）就往后找，最多看两周：
     预览要回答「配完到底长什么样」，不能只甩一张「今天不上学」。 */
  function previewInfo() {
    if (!root.Schedule || !root.Schedule.buildDay) return null;
    var key = (root.Clock && root.Clock.dayKey) ? root.Clock.dayKey() : "";
    if (!key) return null;
    var conf = draftConfig(), day = null, moved = false;
    try {
      for (var i = 0; i < 15; i++) {
        var d = root.Schedule.buildDay(conf, dayKeyShift(key, i));
        if (d && d.inSchool) { day = d; moved = i > 0; break; }
        if (!day) day = d;
      }
    } catch (e) { return null; }
    if (!day || !day.inSchool) return { day: day, key: key, moved: false, empty: true };
    return { day: day, key: key, moved: moved };
  }

  function tlDetail(it) {
    if (it.type === "class") {
      var bits = [];
      if (it.periodNo) bits.push("第" + it.periodNo + "节");
      bits.push(it.subject || "—");
      if (it.teacher) bits.push(it.teacher);
      return bits.join("　");
    }
    if (it.items && it.items.length) return it.items.join("、");
    return it.tip || "";
  }

  function previewSection(live) {
    var pv = previewInfo();
    var box = el("div", "setup-preview");
    box.appendChild(el("div", "setup-preview-title", "配好之后，屏上是这样"));

    if (!pv) {
      box.appendChild(el("p", "setup-p", "这台机器的节律引擎没起来，暂时算不出时间线。"));
      return box;
    }
    if (pv.empty || !pv.day || !pv.day.inSchool) {
      box.appendChild(el("p", "setup-p", "接下来两周都是假期，先检查校历或开学日。"));
      return box;
    }

    var d = pv.day;
    var meta = [d.date, d.weekdayName];
    if (isFinite(d.weekNo)) meta.push("第 " + d.weekNo + " 周");
    if (d.calendar && d.calendar.label) meta.push(d.calendar.label);
    var head = el("div", "setup-preview-meta", meta.join("　·　"));
    box.appendChild(head);
    if (pv.moved) {
      box.appendChild(el("p", "setup-preview-note", "今天不上学，先看下一个上学日。"));
    }

    var list = el("div", "setup-timeline");
    (d.timeline || []).forEach(function (it) {
      var row = el("div", "tl-row tl-" + (it.type || "other"));
      row.appendChild(el("span", "tl-time", it.start + "–" + it.end));
      row.appendChild(el("span", "tl-name", it.name || TL_TYPE[it.type] || ""));
      row.appendChild(el("span", "tl-detail", tlDetail(it)));
      list.appendChild(row);
    });
    box.appendChild(list);

    var warn = (d.warnings || []).filter(function (w) {
      return w.code === "LESSON_MISSING";
    }).length;
    box.appendChild(el("p", "setup-p", live
      ? "上面就是屏上现在的内容。"
      : "这只是预览。" + (warn ? "课表里空着的 " + warn + " 节会显示「—」；" : "") +
        "点「应用到这台机器」后才会上屏。"));
    return box;
  }

  function pageDone() {
    var p = el("div", "setup-page on");
    var filled = state.entries.filter(function (e) { return e.subject; }).length;
    var classes = state.blocks.filter(function (b) { return b.type === "class"; }).length;

    /* 这一页最要紧的不是汇总，而是「现在到底生效没有」。
       以前「应用」按钮埋在滚动区底部，右下角只有一个「完成」，
       老师点完成就关掉了，屏上当然还是旧的。 */
    var live = isLive();
    if (live) {
      p.appendChild(el("h3", "setup-h", "已经生效"));
      p.appendChild(el("p", "setup-p", state.applied
        ? "屏上现在就是新班级、新作息、新课表。点右下角「完成」回到大屏。"
        : "这份设置已经在这台机器上生效。如果你又改了上面的内容，点右下角「重新应用」再写一次。"));
    } else {
      p.appendChild(el("h3", "setup-h", "还没生效"));
      p.appendChild(el("p", "setup-msg", "下面填的都还只是草稿，屏上不会变。点右下角「应用到这台机器」才会写进去。"));
    }
    if (state.flash) p.appendChild(el("p", "setup-msg ok", state.flash));

    var sum = el("div", "setup-sum");
    sum.appendChild(el("div", null, "班级：" + (state.klass || "我的班") + (state.school ? "　·　" + state.school : "")));
    sum.appendChild(el("div", null, "班主任：" + (state.head || "未填")));
    sum.appendChild(el("div", null, "作息：" + classes + " 节正课，" + state.blocks.length + " 段"));
    if (state.blocks.length) {
      sum.appendChild(el("div", null, "从 " + state.blocks[0].start + " 到 " + state.blocks[state.blocks.length - 1].end));
    }
    sum.appendChild(el("div", null, "课表：已填 " + filled + " 格 / " + (periodCount() * 5) + " 格"));
    p.appendChild(sum);

    p.appendChild(previewSection(live));

    roleSection(p);
    textSectionList(p);
    p.appendChild(el("p", "setup-p", "文案留空就是回到系统原来那句话。改动只存在这台机器上，不影响别人的班。"));

    var acts = el("div", "setup-actions");
    var snap = localStore().setupSnapshot ? localStore().setupSnapshot() : null;
    var restore = el("button", "setup-btn ghost", "恢复至修改前");
    restore.type = "button";
    restore.disabled = !snap;
    restore.addEventListener("click", restoreAll);
    acts.appendChild(restore);

    var discard = el("button", "setup-btn ghost", "放弃岗位 / 文案的修改");
    discard.type = "button";
    discard.addEventListener("click", function () {
      state.roles = clone(state.rolesBase);
      state.texts = clone(state.textsBase);
      saveDraft();
      render();
    });
    acts.appendChild(discard);

    var out = el("button", "setup-btn", "导出设置 JSON");
    out.type = "button";
    out.addEventListener("click", exportAll);
    acts.appendChild(out);

    var inp = el("button", "setup-btn", "导入设置 JSON");
    inp.type = "button";
    inp.addEventListener("click", pickImport);
    acts.appendChild(inp);
    p.appendChild(acts);

    p.appendChild(el("p", "setup-p", "导出的是整份设置（含岗位、文案和本机偏好）。换电脑后点「导入设置 JSON」，选对方给的这份文件，班级、作息、课表、岗位、文案一起搬过来。"));

    if (root.Runtime && root.Runtime.ready && !root.Runtime.ready()) {
      p.appendChild(el("p", "setup-msg", "提醒：这个包本身缺配置，应用后仍可能算不出全天。"));
    }
    return p;
  }

  function foot() {
    var f = el("div", "setup-foot");
    var back = el("button", "setup-btn ghost", "上一步");
    back.type = "button";
    back.disabled = state.step === 0;
    back.addEventListener("click", function () { state.step--; saveDraft(); render(); });
    f.appendChild(back);
    f.appendChild(el("span", "grow"));

    if (state.step < 3) {
      var next = el("button", "setup-btn primary", "下一步");
      next.type = "button";
      next.addEventListener("click", function () {
        if (state.step === 0 && !state.klass) {
          alertBox("先填班级名。「我的班」这种占位名屏上也能用，但家长会看到。");
          return;
        }
        if (state.step === 1) {
          var bad = blockErrors();
          if (Object.keys(bad).length) {
            alertBox("作息里有 " + Object.keys(bad).length + " 段时间不对，红色那几行先改好。");
            return;
          }
        }
        state.step++;
        saveDraft();
        render();
      });
      f.appendChild(next);
    } else {
      /* 最后一步按「有没有改动」决定主按钮：
         - 有草稿没写进去 → 只能「应用」，不给「完成」，免得一关就丢；
         - 已经和屏上一致 → 主按钮是「完成」，「重新应用」留作次要动作。 */
      if (isLive()) {
        var done = el("button", "setup-btn primary", "完成");
        done.type = "button";
        done.addEventListener("click", close);
        f.appendChild(done);

        var again = el("button", "setup-btn ghost", "重新应用");
        again.type = "button";
        again.addEventListener("click", applyAll);
        f.appendChild(again);
      } else {
        var apply = el("button", "setup-btn primary", "应用到这台机器");
        apply.type = "button";
        apply.addEventListener("click", applyAll);
        f.appendChild(apply);
      }
    }
    return f;
  }

  function alertBox(msg) {
    var p = box.querySelector(".setup-msg");
    if (p) { p.textContent = msg; return; }
    var body = box.querySelector(".setup-body");
    if (body) body.appendChild(el("p", "setup-msg", msg));
  }

  /* ---------- 保存 / 快照 / 恢复 ----------
     岗位和文案是本机配置的一部分，改坏了屏上会立刻多出别人的岗位。
     所以写之前先记一份原始快照，写完回读校验，对不上就自己退回去。 */
  function makeSnapshot() {
    var raw = (localStore().config && localStore().config()) || {};
    return {
      savedAt: new Date().toISOString(),
      roles: raw.roles !== undefined ? clone(raw.roles) : null,
      texts: (localStore().textsLocal && localStore().textsLocal()) || null
    };
  }

  function rollback(snap) {
    if (!snap) return;
    if (localStore().patchConfig) {
      localStore().patchConfig({ roles: snap.roles == null ? null : clone(snap.roles) });
    }
    if (localStore().setTextsLocal) {
      localStore().setTextsLocal(snap.texts ? clone(snap.texts) : {});
    }
    if (root.Runtime && root.Runtime.reload) root.Runtime.reload();
  }

  function verifyWrite(rolesNow, textPatch) {
    if (rolesNow) {
      var c = (localStore().config && localStore().config()) || {};
      if (!same(c.roles, rolesNow)) return false;
    }
    if (textPatch && Object.keys(textPatch).length) {
      var local = (localStore().textsLocal && localStore().textsLocal()) || {};
      var eff = effectiveTexts() || {};
      var bad = Object.keys(textPatch).some(function (k) {
        if (textPatch[k] == null) return k in local;
        return !same(eff[k], textPatch[k]);
      });
      if (bad) return false;
    }
    return true;
  }

  function confirmLayer(lines, onOk) {
    var layer = el("div", "setup-confirm");
    var card = el("div", "setup-confirm-card");
    card.appendChild(el("h4", "setup-confirm-h", "保存前确认"));
    lines.forEach(function (t) { card.appendChild(el("div", "setup-confirm-line", t)); });

    var acts = el("div", "setup-confirm-acts");
    var back = el("button", "setup-btn ghost", "返回修改");
    back.type = "button";
    back.addEventListener("click", function () { layer.remove(); });
    acts.appendChild(back);

    var ok = el("button", "setup-btn primary", "确认保存");
    ok.type = "button";
    ok.addEventListener("click", function () {
      layer.remove();
      onOk();
    });
    acts.appendChild(ok);
    card.appendChild(acts);

    layer.appendChild(card);
    box.appendChild(layer);
  }

  function applyAll() {
    if (!root.Runtime || !root.Runtime.patch) return;
    var rolesNow = (!same(state.roles, state.rolesBase) && state.roles) ? state.roles : null;
    var textPatch = buildTextPatch(state.texts, state.textsBase);
    var rc = roleChangedCount(state.roles, state.rolesBase);
    var ac = addedRoleCount(state.roles, state.rolesBase);
    var tk = Object.keys(textPatch).length;
    var roleBits = [];
    if (rc) roleBits.push("改了 " + rc + " 处名称、职责或时间");
    if (ac) roleBits.push("新增 " + ac + " 个岗位（执行频率未设置，不上屏）");

    var lines = [
      "班级 / 作息 / 课表：按前面三步的填写一起写入。",
      "岗位：" + (roleBits.length ? roleBits.join("，") + "，会写入。" : "没有改动，不会写入。"),
      "文案：" + (tk ? "改了 " + tk + " 组，会写入。" : "没有改动，不会写入。"),
      "写入前会自动记一份快照，改坏了可以点「恢复至修改前」。"
    ];
    confirmLayer(lines, function () { doApply(rolesNow, textPatch); });
  }

  /* 岗位和文案的写入本体：先快照，写后回读，失败就还原。
     不碰 DOM，便于 node 里模拟写入失败。 */
  function commitRolesTexts(rolesNow, textPatch) {
    var snap = makeSnapshot();
    if (localStore().setupSnapshot) localStore().setupSnapshot(snap);

    var broke = false;
    try {
      if (rolesNow) root.Runtime.patch({ roles: clone(rolesNow) });
      if (textPatch && Object.keys(textPatch).length) localStore().patchTexts(textPatch);
    } catch (e) { broke = true; }

    if (broke || !verifyWrite(rolesNow, textPatch)) {
      rollback(snap);
      return false;
    }
    return true;
  }

  function doApply(rolesNow, textPatch) {
    if (!root.Runtime || !root.Runtime.patch) return;
    if (!commitRolesTexts(rolesNow, textPatch)) {
      state.applied = false;
      render();
      alertBox("写入没有成功，已还原修改前的岗位和文案。可能是这台机器存储空间满了。");
      return;
    }

    var c = cfg();
    var timetable = clone(c.timetable || {});
    timetable.school = state.school;
    timetable.blocks = clone(state.blocks);
    if (state.noonBand) timetable.noonBand = clone(state.noonBand);
    if (state.marks && state.marks.length) timetable.marks = clone(state.marks);

    var schedule = clone(c.schedule || {});
    schedule.school = state.school;
    schedule.class = state.klass;
    schedule.headTeacher = state.head;
    if (state.term) schedule.termStart = state.term;
    schedule.entries = clone(state.entries).filter(function (e) { return e.subject; });

    root.Runtime.patch({
      meta: { school: state.school, klass: state.klass, headTeacher: state.head },
      timetable: timetable,
      schedule: schedule
    });

    state.rolesBase = clone(state.roles);
    state.textsBase = clone(state.texts);
    state.applied = true;
    state.flash = "已保存。屏上已经是这个班的岗位和文案了。";
    clearDraft();
    render();
  }

  function restoreAll() {
    var snap = localStore().setupSnapshot ? localStore().setupSnapshot() : null;
    if (!snap) {
      alertBox("还没有保存过，没有可恢复的快照。");
      return;
    }
    if (root.confirm && !root.confirm("只恢复岗位和文案，不改班级、作息、课表。继续？")) return;

    if (localStore().patchConfig) {
      localStore().patchConfig({ roles: snap.roles == null ? null : clone(snap.roles) });
    }
    if (localStore().setTextsLocal) {
      localStore().setTextsLocal(snap.texts ? clone(snap.texts) : {});
    }
    if (root.Runtime && root.Runtime.reload) root.Runtime.reload();
    if (root.Screen && root.Screen.render) root.Screen.render();

    state.roles = clone(cfg().roles || null);
    state.rolesBase = clone(state.roles);
    state.texts = clone(effectiveTexts());
    state.textsBase = clone(state.texts);
    state.flash = "已恢复到这轮修改前（只动了岗位和文案）。";
    saveDraft();
    render();
  }

  function exportAll() {
    if (!root.Store || !root.Store.exportAll) return;
    var data = root.Store.exportAll();
    var text = JSON.stringify(data, null, 2);
    try {
      var blob = new Blob([text], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = ((root.CFG && root.CFG.fileSlug()) || "我的班") + "-设置.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    } catch (e) {
      alertBox("这个浏览器不支持下载文件，可以先在电脑上打开再导出。");
    }
  }

  /* ---------- 导入 ----------
     老师之间传的是一个 JSON，不是一个 zip：文件更小，也不会带进
     别人包里的旧脚本。选完立刻生效，失败一个字都不改。 */
  function pickImport() {
    if (!root.Store || !root.Store.importAll) return;
    var file = document.createElement("input");
    file.type = "file";
    file.accept = ".json,application/json";
    file.style.cssText = "position:fixed;left:-200px;top:0;width:1px;height:1px;opacity:0";
    document.body.appendChild(file);

    function drop() {
      if (file.parentNode) file.parentNode.removeChild(file);
    }

    file.addEventListener("change", function () {
      var f = file.files && file.files[0];
      if (!f) { drop(); return; }
      if (f.size > 2 * 1024 * 1024) {
        alertBox("这个文件有 " + Math.round(f.size / 1024) + " KB，不像设置文件。");
        drop();
        return;
      }
      if (typeof root.FileReader === "undefined") {
        alertBox("这个浏览器不支持选文件，请在电脑上导入。");
        drop();
        return;
      }
      var fr = new root.FileReader();
      fr.onerror = function () {
        alertBox("文件读不出来，换一个再试。原有设置没有改动。");
        drop();
      };
      fr.onload = function () {
        drop();
        var obj = null;
        try { obj = JSON.parse(String(fr.result)); }
        catch (e) {
          alertBox("这个文件不是 JSON，可能选错了。原有设置没有改动。");
          return;
        }
        var r = root.Store.importAll(obj);
        if (!r.ok) {
          alertBox("导入失败：" + r.why + "。原有设置没有改动。");
          return;
        }
        state = fillState(loadCurrent());
        state.applied = true;
        state.flash = "已导入" + (r.klass ? "「" + r.klass + "」的" : "") + "整份设置，屏上已经换过来。";
        clearDraft();
        render();
      };
      fr.readAsText(f, "utf-8");
    });
    file.click();
  }

  /* 空配置：没有作息或课表就没法出屏，这时直接把向导打开，
     而不是让老师对着「配置还没生成」自己找入口。 */
  function needsSetup() {
    return !(root.Runtime && root.Runtime.ready && root.Runtime.ready());
  }

  /* ---------- 开关 ---------- */
  function open() {
    if (!box) return;
    state = fillState(readDraft() || loadCurrent());
    if (state.applied) state.applied = false;
    box.classList.add("open");
    box.setAttribute("aria-hidden", "false");
    /* 空包时主屏的「还没配置」提示也在，别让它盖住向导（CSS 里靠这个属性藏起来） */
    if (document.body) document.body.dataset.setup = "1";
    render();
  }

  function close() {
    saveDraft();
    if (document.body) document.body.dataset.setup = "";
    if (box) {
      box.classList.remove("open");
      box.setAttribute("aria-hidden", "true");
    }
  }

  function boot() {
    box = document.getElementById("setup");
    if (!box) return;
    var btn = document.getElementById("btn-setup");
    if (btn) btn.addEventListener("click", open);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && box.classList.contains("open")) close();
    });
    if (needsSetup()) open();
  }

  root.Setup = {
    open: open, close: close,
    _needsSetup: needsSetup,
    _loadCurrent: loadCurrent,
    _errors: function (blocks) { return blockErrors(blocks); },
    /* 纯函数给 node 测试用：不碰 DOM，也不读写 localStorage */
    _freqText: freqText,
    _editRole: editRole,
    _editRoleFreqTimes: editRoleFreqTimes,
    _textPatch: buildTextPatch,
    _roleChangedCount: roleChangedCount,
    _addedRoleCount: addedRoleCount,
    _parseImport: parseImport,
    _readOfficeFile: readOfficeFile,
    _matchPeople: function (text, roster) { return matchPeople(text, roster || rosterNames()); },
    _mergeRoleImport: mergeRoleImport,
    _rosterNames: rosterNames,
    _saveRoster: saveRoster,
    _parseTimeRows: parseTimeRows,
    _blocksFromTimeRows: blocksFromTimeRows,
    _noonBandOf: noonBandOf,
    _gridCellRows: gridCellRows,
    _gridFromRows: gridFromRows,
    _blockErrors: blockErrors,
    _commit: commitRolesTexts
  };

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }
})(typeof window !== "undefined" ? window : globalThis);
