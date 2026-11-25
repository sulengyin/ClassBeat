/* 配置向导（P5）。
 *
 * 解决的不是"改一个时间"（作息页早就能改），是"从空白到这个班的屏"：
 * 别的老师拿到包，屏上是别人的班、别人的作息、别人的课表。
 *
 * 五步：班级 → 名单 → 作息 → 课表 → 岗位 / 文案。每一步都能跳过（班级名除外），
 * 改完立刻生效，不用重新打包、不用命令行。产出仍是 localStorage 里的本机配置，
 * 换电脑时用「导出设置」把整份带走。
 *
 * 步骤表在 STEPS 里声明，加一步只改那张表：不要再写 state.step === 2 这样的序号，
 * 序号一散，加一步就会串页（名单当初就是因为没有位置，才被塞进导入面板的）。
 *
 * 最后一步只做两件事：把岗位表读进来、把常用的文案填上。
 * 岗位的名称、职责、执行频率、换人方式一律到编辑模式改——配置阶段不提供
 * 这些字段的编辑，否则同一个字段两处能改，改坏了不知道以哪边为准，
 * 一页也因此长得要滚很久（2026-11-25 反馈）。
 *
 * 岗位表就是本班的岗位清单：拆出岗位名 / 职责 / 人员，姓名拿本班名册
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

  /* 向导的每一步只在这里声明一次。
     以前是「一个名字数组 + 散在五处的 step === 0 / step < 3 / state.step = 3」：
     加一步要改六处，漏一处就静默走错页；草稿里存的还是 step 序号，
     加一步之后老师上次停的地方会整体错位（停在「作息」的人被带到「课表」）。
     现在：id 是稳定标识，草稿存 id 不存序号；canLeave 和步骤绑在一起，
     返回 true 或一句「为什么还不能走」，不再靠序号去认这是哪一步。 */
  var STEPS = [
    { id: "class", name: "班级", render: pageClass, canLeave: leaveClass },
    { id: "roster", name: "名单", render: pageRoster, canLeave: leaveRoster },
    { id: "time", name: "作息", render: pageTime, canLeave: leaveTime },
    { id: "grid", name: "课表", render: pageGrid, canLeave: null },
    { id: "done", name: "岗位 / 文案", render: pageDone, canLeave: null }
  ];

  function lastStep() { return STEPS.length - 1; }

  function stepIndexOf(id) {
    for (var i = 0; i < STEPS.length; i++) if (STEPS[i].id === id) return i;
    return 0;
  }

  /* 「早读」自 0.2.1 起改叫「晨间自主管理」。旧配置里块名存的还是「早读」，
     只在显示时换新名；草稿和已保存的数据都不改。 */
  var READING_NAME = "晨间自主管理";
  function blockName(b) {
    if (!b) return "";
    if (b.type === "reading" && (!b.name || b.name === "早读")) return READING_NAME;
    return b.name || "";
  }

  /* 文案字段与 edit.js 完全同一套键：不新建存储，也不另造一套命名。 */
  var STAGES = [
    { key: "before",  label: "晨间自主管理", title: "晨间自主管理", note: "先交作业、整理书包" },
    { key: "closed",  label: "放学以后",       title: "放学了",     note: "整理好书包，路上注意安全" },
    { key: "holiday", label: "休息日",         title: "今天不上学", note: "好好休息，明天见" }
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

  /* 当前生效文案（包内默认 + 本机改动）。最后一步改的就是这一份。 */
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

  /* 人名归一化只有 Store 一份实现（app/store.js 的 personNameOf）。
     这里以前自带第三套：它不递归、也不挡 [object Object]，
     `tidy(s.name)` 遇到对象就直接产出字符串 "[object Object]"，
     再当成一个「未找到的学生」一路走进核对结果。 */
  function nameOf(x) {
    if (root.Store && root.Store.personNameOf) return root.Store.personNameOf(x);
    return typeof x === "string" ? tidy(x) : "";
  }

  /* 本班名单的权威只有一份：Store 里的 config.students。
     班级数据（RHYTHM_DATA.students）里那份只是**初值**——打包来源班带的
     可能是别人的名单（2026-11-19 真机反馈②：模板包的样例名单被当成本班
     学生，换人候选里冒出别班的名字）。所以它只在老师还没有本机名单时
     当参考显示，点「保存名单」才真正写进本机。
     换人候选（edit.js 的 rosterStudents）只认本机这份，故意不回落：
     那儿一回落，别班的名单就会直接混进候选。 */
  function rosterOverride() {
    var cfg = root.Store && root.Store.config ? root.Store.config() : null;
    var d = cfg && cfg.students;
    /* 空数组也算「本机有名单，只是空的」——老师把人都删掉了，
       不能因此回落到班级数据里那 48 个人（那样删了等于没删）。 */
    return Array.isArray(d) ? d : null;
  }

  /* 能在屏上出现的学生（停用的不算）。
     一律从 rosterAll 派生，别在这儿另写一套过滤——两套过滤迟早给出两个答案。 */
  function rosterNames() {
    return rosterAll().filter(function (s) { return s.active !== false; })
      .map(function (s) { return s.name; });
  }

  /* 从任意文本里挑出姓名。见过的来源有三种：手打的一行一个、
     从 Excel 复制的整列（带「姓名」表头和序号）、Word 表格（tab 分列）。
     规则只有一条——看起来像个人名。
     不这么筛，表头会被当成一个叫「姓名」的学生写进名单，
     换人时候选里就多出两个字的假人；序号也会变成学号。 */
  var ROSTER_HEADER = /^(姓名|学生姓名|学生|名字|名单|序号|学号|编号|班级|性别|男|女|备注|联系电话|name|no\.?)$/i;

  /* 一张「班级信息表」里除了姓名，还常有「学校：…」「班级：…」「班主任：…」
     这样的字段行。它们的值（「五（1）班」「张老师」）都短得像人名，
     以前一律被当成学生加进名单——老师看到的就是「上传了文件，班主任没填上，
     名单里却多了个老师」。这里先把字段行认出来：值回填到对应字段，
     行本身不参与姓名提取。 */
  var META_LINE = /^\s*(学校|校区|班级|年级|班主任|任课教师|教师|老师)\s*[：:]/;

  function metaFromText(text) {
    var out = {};
    String(text == null ? "" : text).split(/[\r\n]+/).forEach(function (line) {
      var m = String(line).match(/^\s*([^\s：:]{1,6})\s*[：:]\s*(.+?)\s*$/);
      if (!m) return;
      var k = m[1].replace(/\s+/g, "");
      var v = m[2].trim();
      if (!v || v.length > 20) return;
      if (/^(学校|校区)$/.test(k)) out.school = v;
      else if (/^班级$/.test(k)) out.klass = v;
      else if (/^(班主任|任课教师|教师|老师)$/.test(k)) out.head = v;
    });
    return out;
  }

  function looksLikeName(s) {
    if (!s || s.length > 12) return false;
    if (ROSTER_HEADER.test(s)) return false;
    if (/^[\d\s.\-]+$/.test(s)) return false;
    /* 「张老师 / 李老师」这种是称呼不是学生。真有人名字最后一个字是「师」
       也只会是「王师」这类两个字的名字，不会以「老师」结尾。 */
    if (s.length <= 6 && /(老师|教师)$/.test(s)) return false;
    return true;
  }

  function extractNames(text) {
    var out = [];
    String(text == null ? "" : text).split(/[\r\n]+/).forEach(function (line) {
      /* 字段行整行跳过，它的值已经交给 metaFromText 了 */
      if (META_LINE.test(line)) return;
      /* 带 tab 就是表格行：一行里可能并排放着序号、姓名、性别，
         逐个单元格判，不像人名的直接丢。 */
      var cells = line.indexOf("\t") >= 0 ? line.split("\t") : [line];
      cells.forEach(function (cell) {
        String(cell).split(/[、,，;；]+/).forEach(function (raw) {
          var name = stripLeadingNumber(raw).text.trim();
          if (!looksLikeName(name)) return;
          /* 不去重：同一个班真可能有两个同名学生，合并掉就等于
             凭空少一个人，而且核对岗位表时会认错人。 */
          out.push(name);
        });
      });
    });
    return out;
  }

  /* ---------- 名单：一条路，一次确认 ----------

     2026-11-23 第二轮真机反馈之后的第二次改法。原来这一页是「一个大文本框 +
     保存名单」＝整份重写：老师想加三个转来的学生，也得把 45 个名字完整抄一遍，
     抄错一个就等于把人转走了。旁边那个「恢复成班级数据里的名单」是这种模型的
     补丁——它的存在恰好说明入口模型不对。

     现在：列表直接可点（增 / 删 / 全选），改动只落在草稿里，点保存或下一步时
     弹一次框，把「加了谁、删了谁、人数怎么变、删的人牵动几个组」写清楚。
     不另设「二次确认」「撤销」这些入口：框里说的就是后果，不是「真的要删吗」。

     几条定死的规则（不定死，后面一定会乱）：
       ① 姓名是唯一键。名单里不允许两条同名——分组、岗位人员、临时调课、
          大屏显示全按姓名索引，存两条同名，后半段全链路都分不清谁是谁。
          重复输入即合并；真有同名学生，请老师写成「张伟A / 张伟B」。
       ② 比较看人，不看顺序。同一批人换个顺序＝没变：不写库、不重排、不弹框。
       ③ 新加的人一律排在末尾，原有顺序不动（顺序≈学号/座位）。
       ④ 本机这份是权威。班级数据只在本机还没有名单时当初值，之后不再覆盖；
          「名单是空的」和「还没有名单」是两件事，前者照存空数组。 */

  /* 名单的全部条目，含已停用的（转走的学生）。
     停用的也得列出来：藏起来就会出现「名单 48 人、换人只显示 45」这种
     对不上的账，而老师没法在界面上修。 */
  function rosterAll() {
    var d = null;
    var cfg = root.Store && root.Store.config ? root.Store.config() : null;
    if (cfg && cfg.students !== undefined && cfg.students !== null) d = cfg.students;
    else d = root.RHYTHM_DATA && root.RHYTHM_DATA.students;
    var list = [];
    if (Array.isArray(d)) list = d;
    else if (d && Array.isArray(d.students)) list = d.students;

    var out = [], seen = {};
    list.forEach(function (s) {
      if (s == null) return;
      var o;
      if (typeof s === "string" || typeof s === "number") {
        o = { name: tidy(String(s)), active: true };
      } else {
        /* 走 nameOf 而不是 tidy：tidy 会把对象 String() 成 "[object Object]"，
           这串字再进核对流程就成了一个假的「未找到的学生」。 */
        o = { name: nameOf(s.name), active: s.active !== false };
        if (s.id != null && String(s.id) !== "") o.id = String(s.id);
        if (s.alias) o.alias = s.alias;
      }
      if (!o.name || o.name === "[object Object]") return;
      if (seen[o.name]) return;      /* 规则 ① */
      seen[o.name] = 1;
      out.push(o);
    });
    return out;
  }

  /* 老师正在改的那一份。null = 还没动过，显示当前名单；
     空数组是合法草稿（他把人都删了），所以不能用 [] 表示「没动过」。 */
  function rosterWorking() {
    var src = state.rosterDraft != null ? state.rosterDraft : rosterAll();
    return src.map(function (s) {
      return { name: s.name, active: s.active !== false };
    });
  }

  function rosterSetDraft(list) {
    state.rosterDraft = list.map(function (s) {
      return { name: s.name, active: s.active !== false };
    });
    saveDraft();
  }

  /* 姓名合并：重复的只留第一次出现的那条（顺序由老师给的那份决定）。 */
  function mergeNames(names) {
    var out = [], dup = [], seen = {};
    (names || []).forEach(function (n) {
      var nm = tidy(n);
      if (!nm) return;
      if (seen[nm]) { if (dup.indexOf(nm) < 0) dup.push(nm); return; }
      seen[nm] = 1;
      out.push(nm);
    });
    return { names: out, dup: dup };
  }

  /* 草稿和现状差在哪儿。只比人，不比顺序（规则 ②）。 */
  function rosterDiff(next) {
    var cur = rosterAll();
    var curNames = cur.map(function (s) { return s.name; });
    var nextNames = (next || []).map(function (s) { return s.name; });
    var curSet = {}, nextSet = {};
    curNames.forEach(function (n) { curSet[n] = 1; });
    nextNames.forEach(function (n) { nextSet[n] = 1; });
    var added = nextNames.filter(function (n) { return !curSet[n]; });
    var removed = curNames.filter(function (n) { return !nextSet[n]; });
    return {
      added: added,
      removed: removed,
      changed: !!(added.length || removed.length),
      orderOnly: !added.length && !removed.length
                 && curNames.join("\u0001") !== nextNames.join("\u0001")
    };
  }

  /* 这几个姓名在「排班」里被引用了几次：岗位人员 / 岗位分组 / 人群组 /
     当天临时调整。删名单本身可撤销（名字加回来，组就自动对上了），
     清掉分组不可撤销——所以要不要清，得老师自己勾，系统不替他决定。 */
  function rosterRefsOf(names) {
    var hit = {}, hitList = [];
    (names || []).forEach(function (n) { if (n) { hit[n] = 1; hitList.push(n); } });
    var out = { roles: [], groups: [], days: 0, people: hitList };
    if (!hitList.length) return out;
    var c = cfg();
    var doc = c.roles || {};
    (doc.roles || []).forEach(function (r) {
      if (!r) return;
      var n = 0;
      var pl = localStore().peopleList ? localStore().peopleList(r.people) : (r.people || []);
      pl.forEach(function (x) { if (hit[x]) n++; });
      if (r.peopleMap && typeof r.peopleMap === "object") {
        Object.keys(r.peopleMap).forEach(function (k) {
          var v = localStore().personNameOf ? localStore().personNameOf(r.peopleMap[k]) : r.peopleMap[k];
          if (hit[v]) n++;
        });
      }
      if (r.groups && typeof r.groups === "object") {
        Object.keys(r.groups).forEach(function (k) {
          var m = (r.groups[k] || []).filter(function (x) { return hit[x]; }).length;
          if (m) out.groups.push({ where: (r.name || k) + " · " + k, n: m });
        });
      }
      (Array.isArray(r.substitute) ? r.substitute : []).forEach(function (x) {
        var nm = x && typeof x === "object" ? x.name : x;
        if (hit[localStore().personNameOf ? localStore().personNameOf(nm) : nm]) n++;
      });
      if (n) out.roles.push({ id: r.id, name: r.name || "(未命名岗位)", n: n });
    });
    (c.peopleGroups || []).forEach(function (g) {
      if (!g) return;
      var m = (g.names || []).filter(function (x) { return hit[x]; }).length;
      if (m) out.groups.push({ where: "分组「" + (g.name || "未命名") + "」", n: m });
    });
    var ov = localStore().allOverrides ? localStore().allOverrides() : {};
    Object.keys(ov).forEach(function (k) {
      var o = ov[k] || {}, any = 0;
      if (o.roles && typeof o.roles === "object") {
        Object.keys(o.roles).forEach(function (id) {
          var r = o.roles[id];
          if (!r || !Array.isArray(r.people)) return;
          r.people.forEach(function (x) { if (hit[x]) any++; });
        });
      }
      if (any) out.days++;
    });
    return out;
  }

  /* 把「老师看到的这份名单」写进本机配置。空数组也照存（规则 ④）。 */
  function applyRosterList(list) {
    var keep = {};
    rosterAll().forEach(function (s) { keep[s.name] = s; });
    var out = list.map(function (s) {
      var old = keep[s.name];
      var o = { name: s.name, active: s.active !== false };
      /* 名字没变就把学号/别名留着；新加的人只带姓名，不带任何学籍信息 */
      if (old && old.id) o.id = old.id;
      if (old && old.alias) o.alias = old.alias;
      return o;
    });
    root.Store.patchConfig({ students: out });
    return { ok: true, n: out.length };
  }

  /* 名字多了截断显示：框里塞 45 个名字没人看得完，看前几个就够判断了。 */
  function shortList(names, max) {
    var n = names || [];
    var lim = max || 6;
    if (!n.length) return "";
    if (n.length <= lim) return n.join("、");
    return n.slice(0, lim).join("、") + " 等 " + n.length + " 人";
  }

  /* 只做一件事的弹框：把改动摆出来，让老师点一次。
     不做「真的要删吗」那种二次确认——框里写的必须是后果，不是重复一遍问题。 */
  function modal(opts) {
    var wrap = el("div", "setup-modal");
    var card = el("div", "setup-modal-card");
    card.appendChild(el("h4", "setup-modal-h", opts.title || ""));
    (opts.lines || []).forEach(function (ln) {
      if (!ln || !ln.text) return;
      card.appendChild(el("p", "setup-modal-line setup-modal-" + (ln.k || "info"), ln.text));
    });
    var checked = false;
    if (opts.check) {
      var lab = el("label", "setup-modal-check");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.addEventListener("change", function () { checked = cb.checked; });
      lab.appendChild(cb);
      lab.appendChild(el("span", "", opts.check.label));
      card.appendChild(lab);
      if (opts.check.note) card.appendChild(el("p", "setup-modal-note", opts.check.note));
    }
    var bar = el("div", "setup-modal-bar");
    (opts.choices || []).forEach(function (ch) {
      var b = el("button", "setup-btn " + (ch.primary ? "primary" : "ghost"), ch.label);
      b.type = "button";
      b.addEventListener("click", function () {
        close();
        if (ch.act) ch.act(checked);
      });
      bar.appendChild(b);
    });
    card.appendChild(bar);
    wrap.appendChild(card);
    box.appendChild(wrap);
    function close() {
      /* 优先 Element.remove()：老一体机的 Chromium 也支持，
         比 parentNode.removeChild 少一次判空（测试桩也只实现了 remove）。 */
      if (typeof wrap.remove === "function") { wrap.remove(); return; }
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    }
    return { close: close };
  }

  /* 提交名单：没变就直接过；变了就弹框，说清 +N / −M / 人数，删的人牵动几个组。 */
  function commitRoster(after) {
    var next = rosterWorking();
    var d = rosterDiff(next);
    if (!d.changed) {
      state.rosterDraft = null;
      state.rosterPick = [];
      state.rosterFlash = d.orderOnly
        ? "名单没变，只是顺序不同——按原来的顺序用。"
        : "名单没变。";
      saveDraft();
      render();
      if (after) after();
      return true;
    }

    var refs = rosterRefsOf(d.removed);
    var hitRoles = refs.roles.filter(function (r) { return r.n; });
    var lines = [];
    if (d.added.length) {
      lines.push({ k: "add", text: "加上 " + d.added.length + " 人：" + shortList(d.added) });
    }
    if (d.removed.length) {
      lines.push({ k: "del", text: "删掉 " + d.removed.length + " 人：" + shortList(d.removed) });
    }
    lines.push({ k: "info", text: rosterAll().length + " 人 → " + next.length + " 人" });

    var used = hitRoles.length;
    var check = null;
    if (used) {
      var where = hitRoles.map(function (r) { return r.name; }).slice(0, 4).join("、");
      check = {
        label: "同时把他们从岗位和分组里清掉（" + used + " 个岗位/组）",
        note: "不勾：这些岗位留着原样，换人时会标「缺 N」，名字加回来就自动对上。"
              + "勾上：直接从「" + where + (used > 4 ? " 等" : "") + "」里删掉，删了加回名字也回不到原来的位置。"
      };
    }

    var saveOne = function (prune) {
      var list = next;
      applyRosterList(list);
      if (prune && d.removed.length && root.Store.prunePeople) {
        root.Store.prunePeople(d.removed);
      }
      state.rosterDraft = null;
      state.rosterPick = [];
      state.rosterFlash = "已保存 " + list.length + " 人。"
        + (prune ? "相关岗位和分组里也一并清掉了。" : "");
      saveDraft();
      render();
      if (after) after();
    };

    /* 取消在左、确定在右；勾选项只影响确定那一下。 */
    modal({
      title: "确认一下这份名单",
      lines: lines,
      check: check,
      choices: [{ label: "先不改" }, { label: "确定保存", primary: true, act: saveOne }]
    });
    return false;
  }

  /* 导入一批名字。规则：先对比，再决定要不要问老师。
     表里盖住了现有全部人 → 只是补人，直接并入，不打扰；
     否则（有人不在表里）→ 可能是「补几个」也可能是「换一整班」，
     这两种后果差 45 个人，必须让老师看一眼再定。 */
  /* 导入前先算清楚：这次是「只补人」还是「表比名单少」。
     direct＝表里盖住了现有全部人（有增无减），并进去信息无损，不用问；
     否则可能是「补几个」也可能是「换一整班」，两种后果差几十个人，
     必须把差异摆出来让老师定——这就是「先对比，再决策」。 */
  function rosterImportPlan(picked, list) {
    var curNames = (list || []).map(function (s) { return s.name; });
    var curSet = {}, pickSet = {};
    curNames.forEach(function (n) { curSet[n] = 1; });
    picked.forEach(function (n) { pickSet[n] = 1; });
    var extra = [];
    picked.forEach(function (n) { if (!curSet[n] && extra.indexOf(n) < 0) extra.push(n); });
    var missing = curNames.filter(function (n) { return !pickSet[n]; });
    return {
      extra: extra,
      missing: missing,
      direct: !missing.length,
      curCount: curNames.length,
      pickCount: picked.length
    };
  }

  function importNames(picked, sourceLabel) {
    var list = rosterWorking();
    var plan = rosterImportPlan(picked, list);
    var extra = plan.extra;
    var missing = plan.missing;
    var label = sourceLabel || "这份表";

    if (plan.direct) {
      if (!extra.length) {
        state.rosterFlash = "「" + label + "」里的人名单里都有，没有新增。";
        saveDraft();
        render();
        return;
      }
      rosterSetDraft(list.concat(extra.map(function (n) { return { name: n, active: true }; })));
      state.rosterFlash = "从「" + label + "」加入 " + extra.length + " 人。点「保存名单」才算数。";
      saveDraft();
      render();
      return;
    }

    var curCount = plan.curCount;
    modal({
      title: "这份表和现在的名单不一样",
      lines: [
        { k: "info", text: "表里 " + plan.pickCount + " 人；名单里现在 " + curCount + " 人。" },
        { k: "add", text: "只有表里有的 " + extra.length + " 人"
                         + (extra.length ? "：" + shortList(extra) : "") },
        { k: "del", text: "表里没有、名单里有的 " + missing.length + " 人"
                         + (missing.length ? "：" + shortList(missing) : "") }
      ],
      choices: [
        { label: "先不导入" },
        {
          label: "并进去（" + curCount + " → " + (curCount + extra.length) + "）",
          primary: true,
          act: function () {
            rosterSetDraft(list.concat(extra.map(function (n) { return { name: n, active: true }; })));
            state.rosterFlash = "从「" + label + "」加入 " + extra.length + " 人。点「保存名单」才算数。";
            saveDraft();
            render();
          }
        },
        {
          label: "换成导入的 " + plan.pickCount + " 人",
          act: function () {
            rosterSetDraft(picked.map(function (n) { return { name: n, active: true }; }));
            state.rosterFlash = "已换成「" + label + "」里的 " + plan.pickCount + " 人。点「保存名单」才算数。";
            saveDraft();
            render();
          }
        }
      ]
    });
  }

  /* 整份替换（内部用）：导入面板与测试走它，界面上的增删不直接调。
     重复姓名按规则 ① 合并，并把合并掉的名字报回去。 */
  function saveRoster(text) {
    var m = mergeNames(extractNames(text));
    if (!m.names.length) return { ok: false, why: "至少要有一个姓名。" };
    var r = applyRosterList(m.names.map(function (n) { return { name: n, active: true }; }));
    return { ok: true, n: r.n, merged: m.dup };
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
        var name = nameOf(it.name || it["岗位"] || it["名称"] || it.role || it["项目"] || it.title);
        var duty = nameOf(it.duty || it["职责"] || it["内容"] || it.desc);
        var people = it.people || it["人员"] || it["负责人"] || it["姓名"] || it.members;
        if (people == null && it.peopleMap) people = Object.keys(it.peopleMap).map(function (k) { return it.peopleMap[k]; });
        if (people == null && it.groups) people = Object.keys(it.groups).map(function (k) { return it.groups[k]; });
        /* 数组元素可能是对象（[{name:"张三"}]）：逐个取名字再拼，
           直接 join 会得到一串 [object Object]。 */
        if (Array.isArray(people)) {
          people = people.map(nameOf).filter(function (n) { return !!n; }).join("、");
        }
        return [name, duty, nameOf(people)];
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
      throw new Error("这里解不开这个文件，请在 Word / Excel 里复制表格后粘贴");
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
    if (s.indexOf("早读") >= 0 || s.indexOf("晨间") >= 0) return { type: "reading", name: READING_NAME };
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

  /* 一个格子里可能挤着科目和任课老师，写法五花八门：
       「语文 王老师」「语文/王老师」「王老师 语文」
       「语文\n王老师」（Excel 单元格内换行）
       「语文王老师」（富文本被拼接、中间没有分隔符）
     以前只按空白切、且认定第一段是科目：碰到「语文王老师」就把整串当科目，
     下拉里多出一个假科目、还带不出老师；碰到「王老师 语文」就把老师当科目。
     现在不猜位置，而是认内容：能认出科目的段是科目，剩下的才是老师。
     「认识哪些科目」由 Subjects 一份词典决定（setup / edit 共用），
     课表里已经出现过的本校叫法也会临时登记进去。 */
  function splitSubjectTeacher(raw, pool) {
    var s = tidy(raw);
    if (!s) return { subject: "", teacher: "" };
    if (/^[—\-－–~]+$/.test(s)) return { subject: "", teacher: "" };
    var Sub = root.Subjects;
    var extra = pool || [];
    if (!Sub) return { subject: s, teacher: "" };

    function isSubj(x) { return Sub.isSubject(x, extra); }

    var parts = s.split(/[\s\/／、|｜]+/).filter(function (x) { return !!x; });

    if (parts.length > 1) {
      var subjects = parts.filter(isSubj);
      if (subjects.length) {
        var teachers = parts.filter(function (p) { return !isSubj(p); });
        return {
          subject: subjects.join("/"),
          /* 老师之间保留原来的「/」写法：课表里「孙丽（双周）/李强」是两个人 */
          teacher: teachers.join("/")
        };
      }
      /* 一段科目都认不出：可能是被空格拆开的同一个科目名（「语 文」），
         合起来正好是已知科目就合回去，别把一个科目拆成科目+老师 */
      var joined = parts.join("");
      if (Sub.isSubject(joined, extra)) return { subject: joined, teacher: "" };
      /* 还是认不出：按旧规矩，第一段当科目、其余当老师，
         但第一段本身像人名（「王老师 语文」）时不能这么切 */
      if (!/[\u4e00-\u9fa5]{1,4}老师$/.test(parts[0])) {
        return { subject: parts[0], teacher: parts.slice(1).join("/") };
      }
      return { subject: s, teacher: "" };
    }

    /* 单段粘连：先用已知科目名认前缀（「语文王老师」→ 语文 + 王老师） */
    var pre = Sub.prefixOf(s, extra);
    if (pre && pre.length < s.length) {
      return { subject: pre, teacher: s.slice(pre.length).replace(/^[\s\/／·]+/, "") };
    }
    /* 老师写在前面（「王老师语文」） */
    var m2 = /^([\u4e00-\u9fa5]{1,4}老师)(.+)$/.exec(s);
    if (m2 && m2[2]) return { subject: m2[2], teacher: m2[1] };

    return { subject: s, teacher: "" };
  }

  function gridFromRows(rows, pool) {
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
        var text = idx === undefined ? "" : (cells[idx + shift] || "");
        var st = splitSubjectTeacher(text, pool);
        if (!st.subject) return;
        var e = { weekday: w, periodNo: p, subject: st.subject };
        /* 任课老师只跟着这格走，不按老师身份推科目；轮流的两位老师原样留着。 */
        if (st.teacher) e.teacher = st.teacher;
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
      catch (e) { warnings.push("这段不像表格，按纯文本处理"); format = "text"; }
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
  /* 这一行点了名、并且能在本班名册里对上的那些人。
     typo 必须老师点过「采用」才算——猜出来的名字不能直接写进屏。 */
  function rowPeople(row) {
    var out = [];
    ((row && row.people) || []).forEach(function (p) {
      var n = "";
      if (p.state === "exact") n = p.resolved || p.name;
      else if (p.state === "typo" && p.accepted) n = p.suggestion || p.resolved;
      if (n && out.indexOf(n) < 0) out.push(n);
    });
    return out;
  }

  /* 把岗位表并成草稿里的岗位清单。
     语义是「这份表就是本班的岗位」，不是「在原有清单上补几条」：
     以前是后者，于是老师上传了自己的表，包里的来源班岗位（路队长、
     节能小队长……）照样留在屏上，岗位名称和数量都不听老师的
     （2026-11-25 反馈：岗位名称不能写死）。
     对得上的旧岗位（同名或 id 命中）沿用它的显示时间、轮换方式、顺序，
     只把名称、职责、人员换成表里的——这样屏上表现不会因为一次上传而变样。
     对不上的作为新岗位加入；新岗位没有显示时间，先在草稿里存着，
     由老师到编辑模式里定（PLAN 2.10：表上没写的时间，不猜）。 */
  function mergeRoleImport(roleSet, rows) {
    var base = roleSet && Array.isArray(roleSet.roles) ? clone(roleSet) : { roles: [] };
    if (!Array.isArray(base.roles)) base.roles = [];

    var picked = (rows || []).filter(function (row) {
      return row && row.selected !== false && row.applied !== true && tidy(row.name);
    });

    /* 一行都没选（或全并过了）：原样退回，绝不能把清单清空——
       「没有改动」和「把岗位全删了」是两件事。 */
    if (!picked.length) {
      return { roles: base, updated: 0, added: 0, skipped: (rows || []).length,
               peopleUpdated: 0, removed: 0, noFreq: 0 };
    }

    var ids = {};
    base.roles.forEach(function (r) { ids[r.id] = 1; });
    var order = 0;
    base.roles.forEach(function (r) { if (+r.order > order) order = +r.order; });

    var stats = { updated: 0, added: 0, skipped: (rows || []).length - picked.length,
                  peopleUpdated: 0, removed: 0, noFreq: 0 };
    var used = {};
    var next = [];

    picked.forEach(function (row) {
      var name = tidy(row.name);
      var hit = null;
      if (row.targetId) {
        base.roles.forEach(function (r) { if (!hit && r.id === row.targetId) hit = r; });
      }
      if (!hit) {
        base.roles.forEach(function (r) { if (!hit && !used[r.id] && tidy(r.name) === name) hit = r; });
      }

      var people = rowPeople(row);

      if (hit) {
        used[hit.id] = 1;
        hit.name = name;
        if (tidy(row.duty)) hit.duty = tidy(row.duty);
        /* 表里点了名，就以表为准。以前这里人员「原样保留」，而包里的
           岗位带着来源班的人名，于是屏上值日的还是「孙星野、孔子墨」。
           mode 一并钉成 fixed：原来是 A/B 组轮换的岗位，不钉就会继续
           按 groups 出人，people 写了也看不见；groups / peopleMap 数据
           都留着，老师切回轮流就能原样用。
           表里没写负责人（或一个都没对上名册）时不动 people。 */
        if (people.length) {
          hit.people = people;
          hit.mode = "fixed";
          stats.peopleUpdated++;
        }
        next.push(hit);
        stats.updated++;
        return;
      }

      var k = 1, id = "";
      do { id = "imp" + k; k++; } while (ids[id]);
      ids[id] = 1;
      order += 10;
      next.push({
        id: id, name: name, duty: tidy(row.duty),
        freq: { kind: "unset" }, people: people,
        order: order, assign: "fixed", grp: null
      });
      stats.added++;
      stats.noFreq++;
    });

    /* 表里没有的旧岗位不再保留：它们是来源班的清单，不是这个班的。 */
    base.roles.forEach(function (r) { if (!used[r.id]) stats.removed++; });
    base.roles = next;
    return { roles: base, updated: stats.updated, added: stats.added,
             skipped: stats.skipped, peopleUpdated: stats.peopleUpdated,
             removed: stats.removed, noFreq: stats.noFreq };
  }

  /* ---------- 草稿：中途关掉不用重填 ---------- */
  function saveDraft() {
    if (!state) return;
    state.ts = Date.now();
    /* 存步骤的 id，不存序号：加一步或调一次顺序，老师上次停的地方
       还在原来那一步，而不是被带到隔壁。 */
    state.stepId = (STEPS[state.step] || STEPS[0]).id;
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
      /* null = 老师还没动过名单，页面显示当前名单；
         有数组 = 改了还没保存（草稿）。空数组是合法草稿（他把人都删了），
         所以不能用 [] 表示「没动过」。 */
      rosterDraft: null,
      rosterPick: [],
      rosterFlash: "",
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
    /* 最后一步改的文案/岗位还没写回去，也不能算“已生效”，
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
    /* 老草稿存的是整段文本（rosterText），换成列表；不再需要那个字段。 */
    if (!Array.isArray(s.rosterDraft)) {
      s.rosterDraft = typeof s.rosterText === "string"
        ? mergeNames(extractNames(s.rosterText)).names.map(function (n) {
            return { name: n, active: true };
          })
        : null;
    }
    delete s.rosterText;
    if (!Array.isArray(s.rosterPick)) s.rosterPick = [];
    if (!("rosterFlash" in s)) s.rosterFlash = "";
    if (!("timeText" in s)) s.timeText = "";
    if (!("timeRows" in s)) s.timeRows = [];
    if (!("timeFlash" in s)) s.timeFlash = "";
    if (!("gridText" in s)) s.gridText = "";
    if (!("gridRows" in s)) s.gridRows = [];
    if (!("gridFlash" in s)) s.gridFlash = "";
    /* 草稿里存的是步骤 id（老草稿存的是序号）。按 id 还原，
       同时把序号夹回合法范围——老的 step=3 在加了一步之后不再等于「最后一页」。 */
    if (s.stepId) s.step = stepIndexOf(s.stepId);
    if (typeof s.step !== "number" || s.step < 0 || s.step > lastStep()) s.step = 0;
    delete s.stepId;
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
     引擎只能跳过，老师却以为那段时间还在上课。
     比较分钟数而不是字符串——"9:50" 和 "09:50" 是同一个时间；
     报错把两段的时间带上，老师一眼看到差在哪（真机反馈 2026-11-19 ②）。 */
  function blockErrors(blocks) {
    var bad = {};
    var prev = null;
    (blocks || state.blocks || []).forEach(function (b, i) {
      if (!b.start || !b.end || b.start >= b.end) bad[i] = "结束要晚于开始";
      else if (prev && hmMin(b.start) !== hmMin(prev)) {
        bad[i] = "和上一段没接上（上一段到 " + prev + "，这一段从 " + b.start + " 开始）";
      }
      prev = b.end;
    });
    return bad;
  }

  /* ---------- 渲染 ---------- */
  /* 这一页是整块重建的（box.innerHTML = ""），重建后 .setup-body 的
     scrollTop 天然归 0。岗位表那一步内容多，老师在中间点一下勾选、
     点一下「全不选」，眼前就跳回最上面，得自己再滚回来——触摸屏上
     等于没法连续操作（2026-11-25 真机反馈）。
     名单页早就用「就地更新、不整页重画」躲过去了，这里改不了那么细：
     重建时把滚动位置和展开的折叠区记下来，重建完原样放回去。 */
  function render() {
    if (!box) return;
    var old = box.querySelector(".setup-body");
    var keepTop = old ? old.scrollTop : 0;
    var keepOpen = [];
    if (old) {
      Array.prototype.forEach.call(old.querySelectorAll("details.setup-text-sec"), function (d, i) {
        if (d.open) keepOpen.push(i);
      });
    }

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
    var cur = STEPS[state.step] || STEPS[0];
    body.appendChild(cur.render());
    panel.appendChild(body);

    panel.appendChild(foot());
    box.appendChild(panel);

    /* 位置必须在挂进文档之后再还原：没挂载的元素没有布局，
       这时候写 scrollTop 等于没写（实测会老老实实停在 0）。
       折叠区先恢复展开态，再放滚动位置——展开会让内容变长。 */
    if (keepOpen.length) {
      Array.prototype.forEach.call(body.querySelectorAll("details.setup-text-sec"), function (d, i) {
        if (keepOpen.indexOf(i) >= 0) d.setAttribute("open", "");
      });
    }
    if (keepTop) body.scrollTop = keepTop;
  }

  function steps() {
    var wrap = el("div", "setup-steps");
    STEPS.forEach(function (step, i) {
      if (i) wrap.appendChild(el("i"));
      var s = el("div", "setup-step" + (i === state.step ? " on" : (i < state.step ? " done" : "")));
      s.appendChild(el("b", null, String(i + 1)));
      s.appendChild(el("span", null, step.name));
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

  /* 第一步只留四个格子。
     2026-11-24 删掉了这里原来的「以前用网页版（0.3.x）？导出成 JSON 再导进来」
     一整块：它把版本号和技术词汇摆在老师第一眼看到的地方，而它做的事
     （从文件导入一份设置）末页「换电脑时用 → 从文件导入」本来就有，
     同一个能力写两处、两套措辞。需要迁移的老师按文档走末页那个入口。
     这段说明故意留在函数外面：test_dom 会扫函数体，里面不许再出现这些词。 */
  function pageClass() {
    var p = el("div", "setup-page on");
    p.appendChild(el("h3", "setup-h", "先告诉屏，这是哪个班"));

    p.appendChild(field("学校", state.school, function (v) { state.school = v; }, "text", "例如：春江中心小学"));
    p.appendChild(field("班级", state.klass, function (v) { state.klass = v; }, "text", "例如：五（1）班"));
    p.appendChild(field("班主任", state.head, function (v) { state.head = v; }, "text", "可以不填"));
    p.appendChild(field("开学日", state.term, function (v) { state.term = v; }, "date"));
    return p;
  }

  /* 第二步：学生名单。
     名单不是「核对岗位表用的一张对照表」，它就是这班的学生——
     换人时的候选、大屏上学号对应的姓名，都从它来。所以它单独占一步，
     而不是藏在「从岗位表导入」的第①块里：那条路要走六层，
     而且入口叫「从岗位表导入」，没人会想到名单在里面。 */
  function pageRoster() {
    var p = el("div", "setup-page on");
    var list = rosterWorking();
    var cur = rosterAll();
    var d = rosterDiff(list);
    var live = list.filter(function (s) { return s.active !== false; });

    p.appendChild(el("h3", "setup-h", "这个班的学生"));
    p.appendChild(el("p", "setup-p",
      !cur.length
        ? "还没有名单，在下面加第一个。"
        : "点一下选中；新名字打在下面回车。"));

    /* 状态行：改了什么必须看得见，不能指望老师自己记。 */
    var status = el("div", "setup-roster-status");
    var countEl = el("span", "setup-roster-count", "");
    var pickEl = el("span", "setup-roster-picked", "");
    status.appendChild(countEl);
    status.appendChild(pickEl);
    /* 改了又不想改的出口。它不是「防误操作的二次确认」，
       而是任何可编辑列表都该有的「回到现状」——没有它，删错了
       只能一个个把名字重新打回去。 */
    if (d.changed) {
      var undoBtn = el("button", "setup-roster-undo", "放弃改动");
      undoBtn.type = "button";
      undoBtn.addEventListener("click", function () {
        state.rosterDraft = null;
        state.rosterPick = [];
        state.rosterFlash = "已回到原来的名单，什么都没改。";
        saveDraft();
        render();
      });
      status.appendChild(undoBtn);
    }
    p.appendChild(status);

    var tools = el("div", "setup-roster-tools");
    var allBtn = el("button", "setup-btn ghost setup-roster-all", "全选");
    allBtn.type = "button";
    var delBtn = el("button", "setup-btn ghost setup-roster-del", "删除选中");
    delBtn.type = "button";
    tools.appendChild(allBtn);
    tools.appendChild(delBtn);
    p.appendChild(tools);

    var board = el("div", "setup-roster-list");
    var items = [];
    if (!list.length) board.appendChild(el("p", "setup-note", "名单是空的。"));
    list.forEach(function (s) {
      var b = el("button", "setup-roster-item" + (s.active === false ? " off" : ""), s.name);
      b.type = "button";
      if (s.active === false) b.appendChild(el("span", "setup-roster-tag", "已停用"));
      b.addEventListener("click", function () {
        var i = state.rosterPick.indexOf(s.name);
        if (i >= 0) state.rosterPick.splice(i, 1);
        else state.rosterPick.push(s.name);
        b.classList.toggle("on", state.rosterPick.indexOf(s.name) >= 0);
        paintSel();
      });
      items.push({ name: s.name, el: b });
      board.appendChild(b);
    });
    p.appendChild(board);

    /* 选中状态就地更新，不整页重画：48 人的列表每次点一下都跳回顶部，
       在触摸屏上等于没法多选。 */
    function paintSel() {
      var picked = state.rosterPick.length;
      countEl.textContent = d.changed
        ? "未保存（" + [d.added.length ? "+" + d.added.length : "",
                        d.removed.length ? "−" + d.removed.length : ""]
            .filter(function (x) { return !!x; }).join(" ") + " 人）"
        : "现在 " + live.length + " 人";
      pickEl.textContent = picked ? "已选 " + picked + " 人" : "";
      allBtn.textContent = picked && picked === list.length ? "取消全选" : "全选";
      delBtn.textContent = picked ? "删除选中 " + picked + " 人" : "删除选中";
      delBtn.disabled = !picked;
    }

    allBtn.addEventListener("click", function () {
      var allOn = list.length > 0 && state.rosterPick.length === list.length;
      state.rosterPick = allOn ? [] : list.map(function (s) { return s.name; });
      items.forEach(function (it) {
        it.el.classList.toggle("on", state.rosterPick.indexOf(it.name) >= 0);
      });
      paintSel();
    });

    delBtn.addEventListener("click", function () {
      var kill = {}, n = state.rosterPick.length;
      state.rosterPick.forEach(function (x) { kill[x] = 1; });
      rosterSetDraft(list.filter(function (s) { return !kill[s.name]; }));
      state.rosterPick = [];
      state.rosterFlash = "已从待保存名单里移除 " + n + " 人。点「保存名单」才算数。";
      render();
    });

    var msgEl = el("p", "setup-msg ok", state.rosterFlash || "");

    /* 加人：打名字回车就加，也可以一次粘一列。加进来的永远排在末尾，
       原有顺序不动（顺序≈学号/座位，重排一次老师就得重新认一遍）。 */
    var addBox = el("div", "setup-roster-add");
    var input = document.createElement("input");
    input.className = "setup-input setup-roster-new";
    input.type = "text";
    input.placeholder = "打一个姓名，回车加入；也可一次粘多个";
    var addBtn = el("button", "setup-btn setup-roster-addbtn", "加入");
    addBtn.type = "button";
    function doAdd() {
      var m = mergeNames(extractNames(input.value));
      if (!m.names.length) {
        input.value = "";
        msgEl.textContent = "没读出名来——一行一个，或从表格里整列复制过来。";
        return;
      }
      var have = {};
      list.forEach(function (s) { have[s.name] = 1; });
      var fresh = m.names.filter(function (n) { return !have[n]; });
      if (!fresh.length) {
        input.value = "";
        msgEl.textContent = "「" + shortList(m.names, 3) + "」已经在名单里了。";
        return;
      }
      rosterSetDraft(list.concat(fresh.map(function (n) { return { name: n, active: true }; })));
      state.rosterFlash = "加入 " + fresh.length + " 人"
        + (m.dup.length ? "（「" + shortList(m.dup, 2) + "」重复，按一个人算）" : "")
        + "。点「保存名单」才算数。";
      render();
    }
    addBtn.addEventListener("click", doAdd);
    input.addEventListener("keydown", function (e) {
      if (e && e.key === "Enter") {
        if (e.preventDefault) e.preventDefault();
        doAdd();
      }
    });
    addBox.appendChild(input);
    addBox.appendChild(addBtn);

    /* 传文件：读进来先跟现在这份比，比完才决定并入还是问老师。
       不当场写库——万一把隔壁班的表读进来，老师还有机会发现。
       它和「加入」是同一件事的两种输入方式，所以并在一行里，
       不单独占一行贴到页脚边上（1366×768 上那一行正好被页脚切掉）。 */
    var file = document.createElement("input");
    file.type = "file";
    file.accept = ".xlsx,.xlsm,.docx";
    file.className = "setup-roster-file";
    file.addEventListener("change", function () {
      readPickedFile(file).then(function (res) {
        if (!res) return;
        /* 表头里的学校 / 班级 / 班主任顺手填上：老师传一份班级信息表，
           本来图的就是不用再手打一遍。已经有值的不覆盖——手填的优先。 */
        var meta = metaFromText(res.text);
        var filled = [];
        if (meta.school && !state.school) { state.school = meta.school; filled.push("学校"); }
        if (meta.klass && !state.klass) { state.klass = meta.klass; filled.push("班级"); }
        if (meta.head && !state.head) { state.head = meta.head; filled.push("班主任"); }
        var filledHint = filled.length
          ? "顺手填了：" + filled.join("、") + "（第一步可以再改）。"
          : "";

        var m = mergeNames(extractNames(res.text));
        if (!m.names.length) {
          state.rosterFlash = "「" + res.name + "」里没读到姓名，换个文件或直接粘贴。"
            + (filledHint ? filledHint : "");
          saveDraft();
          render();
          return;
        }
        importNames(m.names, res.name);
        if (filledHint) {
          state.rosterFlash = (state.rosterFlash || "") + filledHint;
          saveDraft();
          render();
        }
      }).catch(function (err) {
        state.rosterFlash = "读不了这个文件：" + (err && err.message ? err.message : "格式不对");
        saveDraft();
        render();
      });
      file.value = "";
    });
    var pick = el("button", "setup-btn setup-btn-line setup-roster-pick", "从表格文件导入");
    pick.type = "button";
    pick.addEventListener("click", function () { file.click(); });
    addBox.appendChild(pick);
    addBox.appendChild(file);
    p.appendChild(addBox);

    var bar = el("div", "setup-actions setup-roster-bar");
    if (d.changed) {
      var save = el("button", "setup-btn primary setup-roster-save", "保存名单（" + list.length + " 人）");
      save.type = "button";
      save.addEventListener("click", function () { commitRoster(); });
      bar.appendChild(save);
      p.appendChild(bar);
    }
    p.appendChild(msgEl);

    paintSel();
    return p;
  }

  /* 从这一步往下走。有改动就弹框核对（return false 让底部别自己跳页），
     没改动就直接过；只差顺序的草稿直接丢掉——顺序不同不算改动（规则 ②）。 */
  function leaveRoster() {
    var d = rosterDiff(rosterWorking());
    if (!d.changed) {
      if (state.rosterDraft) {
        state.rosterDraft = null;
        state.rosterPick = [];
        saveDraft();
      }
      return true;
    }
    commitRoster(function () {
      state.step++;
      saveDraft();
      render();
    });
    return false;
  }

  function pageTime() {
    var p = el("div", "setup-page on");
    p.appendChild(el("h3", "setup-h", "作息：先套一套相近的，再改不一样的地方"));
    p.appendChild(el("p", "setup-p", "相邻两段必须首尾相接，中间不能留空。"));

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
        : (blockName(b) || b.type);
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
      "也可以读学校的作息表，或把表粘进来。"));

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
    p.appendChild(el("p", "setup-p", "只填科目就行；空着的格子显示「—」。"));

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
      p.appendChild(el("p", "setup-msg", "先回上一步套用作息。"));
    }
    p.appendChild(gridImportBox());
    return p;
  }

  /* 识别课表格子时能用上的科目池：常见科目 + 课表里已经排到的科目。
     本校自己起的名字（「劳综短课」「五年级选修」）只要已经填过一格，
     下一格粘着老师也能认出来。 */
  function gridSubjectPool() {
    var extra = [];
    (state.entries || []).forEach(function (e) {
      if (e && e.subject && extra.indexOf(e.subject) < 0) extra.push(e.subject);
    });
    return root.Subjects ? root.Subjects.all(extra) : extra;
  }

  /* 班级课表导入：认「周一…周五」列和「第 N 节」行，老师名跟着格子存。 */
  function gridImportBox() {
    var box = el("div", "setup-import");
    box.appendChild(el("p", "setup-p",
      "也可以读班级课表，或把表粘进来。"));

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
      var r = gridFromRows(state.gridRows, gridSubjectPool());
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
    var r = gridFromRows(state.gridRows, gridSubjectPool());
    state.gridFlash = r.bad || ("识别到 " + r.entries.length + " 格，确认后点「填入课表」");
    saveDraft();
    render();
  }

  function applyGridImport() {
    var r = gridFromRows(state.gridRows, gridSubjectPool());
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

  /* ---------- 最后一步：岗位 / 文案 ---------- */
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

  /* 提示语只做作息里真有名字的时段；正课的名字来自课表，不在这里改。
     显示用 blockName(b)（见文件顶部），改字仍按原来的 b.name 存。 */
  function tipBlocks() {
    var seen = {}, out = [];
    (state.blocks || []).forEach(function (b) {
      if (b.type === "class" || !b.name || seen[b.name]) return;
      seen[b.name] = 1;
      out.push({ name: b.name, label: blockName(b), tip: b.tip || "" });
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

  /* 只做一件事：把岗位表并进来。
     名单以前也挂在这一块里当「①」，结果名单成了「上传岗位表」的子步骤，
     老师被指到这儿却看不见名单的入口。名单现在自己一步，这里只核对岗位表。 */
  function importPanel() {
    var wrap = el("div", "setup-import");

    if (rosterNames().length) {
      wrap.appendChild(roleBlock());
    } else {
      /* 没有名单就核对不了姓名。别只写一句「先去补名单」——
         给一个能点的按钮，直接跳到那一步，老师不用自己找路。 */
      var gate = el("div", "setup-import-gate");
      gate.appendChild(el("p", "setup-msg",
        "还没有班级名单，岗位表里的姓名没法核对。"));
      var go = el("button", "setup-btn setup-import-goroster", "去录入名单");
      go.type = "button";
      go.addEventListener("click", function () {
        state.importOpen = false;
        state.step = stepIndexOf("roster");
        saveDraft();
        render();
      });
      gate.appendChild(go);
      wrap.appendChild(gate);
    }

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

  /* 岗位表。整个面板只有这一个上传入口，且一次只读一个文件。 */
  function roleBlock() {
    var box = el("div", "setup-import-block");
    var head = el("div", "setup-import-block-head");
    head.appendChild(el("span", "setup-import-block-title", "岗位表"));
    box.appendChild(head);

    [
      "表头含「岗位 / 项目」「职责 / 内容」「负责人 / 姓名」，一行一个岗位。",
      "多个姓名用「、」分隔；表上的数字编号只当编号，不当周几。",
      "老的 .xls / .doc 请先另存成 .xlsx / .docx。",
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
      "这份表就是本班的岗位清单：表里有几个，屏上就有几个；"
      + "表里没有的岗位会从本班移除。名单里没有的名字不会写入，也不会自动加学生。"));

    var foot = el("div", "setup-actions");
    var apply = el("button", "setup-btn primary setup-import-apply", "用这张表作岗位清单（先存草稿）");
    apply.type = "button";
    apply.addEventListener("click", applyImport);
    foot.appendChild(apply);
    box.appendChild(foot);
    return box;
  }

  /* 识别结果只回答一件事：这几行是不是我要的岗位。
     以前每一行还摊开「姓名精确 / 疑似错字 / 未找到」「置信度 高 / 中 / 低」，
     岗位名和职责都是输入框，外加「+ 加人」——那是编辑模式，而且一屏放不下，
     老师滚到一半点一下又弹回顶部（2026-11-25 反馈）。姓名核对仍然照做
     （见 matchPeople / mergeRoleImport），只是不再摊在配置流程里：
     对不上的岗位，屏上先显示「待定」，去编辑模式点一下就能选人。 */
  function importPreview() {
    var wrap = el("div", "setup-import-preview");
    var rows = state.importRows || [];
    var picked = rows.filter(function (r) { return r.selected !== false; }).length;
    wrap.appendChild(el("div", "setup-import-sum",
      "识别到 " + rows.length + " 行，已选 " + picked + " 行"));

    rows.forEach(function (row) {
      var card = el("div", "setup-import-row");

      var head = el("div", "setup-import-row-head");
      var pick = el("input");
      pick.type = "checkbox";
      pick.className = "setup-import-pick";
      pick.checked = row.selected !== false;
      pick.addEventListener("change", function () { row.selected = pick.checked; saveDraft(); });
      head.appendChild(pick);

      head.appendChild(el("span", "setup-import-name-text", row.name || "（未命名岗位）"));
      head.appendChild(el("span", "setup-import-tag " + (row.targetId ? "update" : "add"),
        row.targetId ? "更新「" + (roleNameOf(row.targetId) || row.name) + "」" : "新增岗位"));
      if (row.applied) head.appendChild(el("span", "setup-import-tag applied", "已并入草稿"));
      card.appendChild(head);

      if (row.duty) card.appendChild(el("div", "setup-import-duty-text", row.duty));
      wrap.appendChild(card);
    });

    /* 只报数量，不报名字：老师要知道「有岗位没人」，但不需要在配置阶段
       逐个人核对——那是编辑模式里换人那一步的事。 */
    var st = countPeopleStates(rows);
    var noPeople = st.missing + st.typo + st.same;
    if (noPeople) {
      wrap.appendChild(el("p", "setup-p",
        "其中 " + noPeople + " 个岗位没在名单里对上负责人。屏上会先显示「待定」，"
        + "之后在编辑模式里点一下就能选人。"));
    }
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
            + " 个岗位（" + where + "）。确认这几行是你要的岗位，再并入草稿。";
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
        + "试试直接把表格粘进来。";
    } else {
      state.importFlash = "识别到 " + res.rows.length + " 个岗位，确认后并入草稿。";
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
    /* 结果要说清三件事：现在有几个岗位、哪些还上不了屏、哪些被移除了。
       「没显示时间」不能只写一句「不会上屏」——老师会以为上传失败了。 */
    var bits = ["已按你的表设成 " + (m.updated + m.added) + " 个岗位"];
    if (m.updated) bits.push(m.updated + " 个沿用了原来的显示时间");
    if (m.added) bits.push(m.added + " 个是新的，还没有显示时间，屏上暂时不显示（到编辑模式设一下）");
    if (m.removed) bits.push("表里没有的 " + m.removed + " 个已移除");
    state.flash = bits.join("；") + "。点「应用到这台机器」才写进大屏。";
    saveDraft();
    render();
  }

  /* 岗位这一块只做一件事：把老师手上的岗位表读进来。
     以前这里把每个岗位摊成一叠卡片，名称 / 职责 / 时间都是输入框，
     等于在「配置」里开了一份编辑模式的副本——同样的字段两处能改，
     改坏了不知道以哪边为准，一页也因此长得要滚很久
     （2026-11-25 反馈）。改岗位去编辑模式，那里字段更全、还有换人。 */
  function roleSection(p) {
    var rs = state.roles;
    if (!rs || !Array.isArray(rs.roles) || !rs.roles.length) {
      p.appendChild(el("p", "setup-p",
        "这个包没有岗位表，可以粘贴，也可以跳过。"));
      importStart(p);
      p.appendChild(el("p", "setup-p",
        "岗位的名称、职责和换人方式，在编辑模式里改。"));
      return;
    }

    var src = el("div", "setup-src");
    if (rs.class && rs.class !== state.klass) {
      /* 不能叫 .warn：主屏那条「还没配置」的全屏提示就是 .warn，
         它带着 display:none，套上去等于把这块提醒藏掉（2026-11-25 发现）。 */
      src.classList.add("setup-src-bad");
      src.appendChild(el("b", null, "这些岗位来自打包来源班「" + rs.class + "」"));
      src.appendChild(el("span", null, "现在配的是「" + (state.klass || "未填") + "」。"
        + "上传本班的岗位表，岗位的名称和数量就以表为准；不想用就跳过这一步。"
        + "屏上不会写入任何岗位。"));
    } else {
      src.appendChild(el("b", null, "岗位清单：共 " + rs.roles.length + " 个"
        + (rs.class ? "（来源班「" + rs.class + "」）" : "")));
      src.appendChild(el("span", null, "有本班的岗位表就上传——岗位的名称和数量会按表来。"));
    }
    p.appendChild(src);
    importStart(p);

    /* 新岗位没有显示时间就不上屏。这不是失败，但老师必须知道——
       否则「传完表、屏上没变」会被当成又坏了（2026-11-25）。
       常驻显示，不只在并入后弹一句。 */
    var noTime = rs.roles.filter(function (r) {
      return !r.freq || r.freq.kind === "unset";
    }).length;
    if (noTime) {
      p.appendChild(el("p", "setup-p",
        "其中 " + noTime + " 个岗位还没有显示时间，屏上暂时不显示；"
        + "到编辑模式里给它们定个时间就会上屏。"));
    }
    p.appendChild(el("p", "setup-p",
      "岗位的名称、职责和换人方式，在编辑模式里改。"));
  }

  function textSectionList(p) {
    var T = state.texts || {};

    var d1 = textSection("每天提醒", "晨间自主管理时黄色贴纸上的那句话", [
      field("每天提醒", textAt(["reminders", "default"]),
        function (v) { setText(["reminders", "default"], v); },
        "text", "带齐今天要用的书和作业，课前摆好。")
    ], true);
    p.appendChild(d1);

    var stageRows = [];
    STAGES.forEach(function (st) {
      if (st.key === "before") {
        /* 晨间这两句仍写进 stage.before 的 title / note，键不变、老数据原地保留 */
        stageRows.push(field("晨间自主管理 · 大字",
          textAt(["stage", st.key, "title"]),
          function (v) { setText(["stage", st.key, "title"], v); },
          "text", st.title));
        stageRows.push(field("晨间自主管理 · 第二行",
          textAt(["stage", st.key, "note"]),
          function (v) { setText(["stage", st.key, "note"], v); },
          "text", st.note));
        return;
      }
      stageRows.push(field(st.label + " · 大字",
        textAt(["stage", st.key, "title"]),
        function (v) { setText(["stage", st.key, "title"], v); },
        "text", st.title));
      stageRows.push(field(st.label + " · 一句话",
        textAt(["stage", st.key, "note"]),
        function (v) { setText(["stage", st.key, "note"], v); },
        "text", st.note));
    });
    p.appendChild(textSection("晨间自主管理 · 放学 · 休息日",
      "晨间这两句跟着作息里的晨间段时间走；放学和休息日不在作息表里", stageRows));

    var brRows = [
      field("课间 · 大字", textAt(["breakTitle"]),
        function (v) { setText(["breakTitle"], v); }, "text", "课间"),
      field("课间 · 第一行", (T.breakActions || []).join("，"),
        function (v) { setBreakActions(v); }, "text", "喝水，上厕所"),
      field("课间 · 第二行开头", textAt(["prepLabel"]),
        function (v) { setText(["prepLabel"], v); }, "text", "准备好")
    ];
    p.appendChild(textSection("课间这一屏", "大字一行，下面两行：先做什么、带什么", brRows));

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
      tipRows.push(field(b.label, textAt(["tips", b.name]),
        function (v) { setText(["tips", b.name], v); },
        "text", b.tip || "（这一时段没有提示语）"));
    });
    if (tipRows.length) {
      p.appendChild(textSection("各时段的提示语", "只列有名字的时段；留空就是原来的话", tipRows));
    }
  }

  /* ---------- 完成页 ----------
     这里只回答两件事：现在生效没有、配的是什么。
     以前这一页顶上还挂着一块「配好之后，屏上是这样」的时间线预览，
     配上岗位表那一段的人员对应和置信度，等于把编辑模式和调试信息
     塞进了配置流程（2026-11-25 反馈）。配置只负责「把文件变成能用的屏」，
     看效果、改细节都回大屏和编辑模式，那里本来就有。 */
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
        ? "已经生效。点「完成」回大屏。"
        : "已经生效；又改了上面的话，点「重新应用」。"));
    } else {
      p.appendChild(el("h3", "setup-h", "还没生效"));
      p.appendChild(el("p", "setup-msg", "还是草稿；点「应用到这台机器」才生效。"));
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

    roleSection(p);
    textSectionList(p);
    p.appendChild(el("p", "setup-p", "留空用原来的话。"));

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
    p.appendChild(acts);

    /* 本机备份与恢复：老师真正要的是「改坏了能退回去」，不是「导个文件」。
       大屏开着时 backup.js 每天自动落一份快照，这里只负责列出来、点一下恢复。 */
    var bsec = el("div", "setup-backup");
    bsec.appendChild(el("h3", "setup-h", "本机备份与恢复"));
    bsec.appendChild(el("p", "setup-p",
      "大屏开着每天自动存；改坏了点「恢复」。"));
    var bHost = el("div", "setup-backup-list");
    bsec.appendChild(bHost);
    p.appendChild(bsec);
    mountBackupList(bHost);

    /* 换电脑才用：同一台电脑上升级不需要导文件。 */
    var msec = el("div", "setup-backup");
    msec.appendChild(el("h3", "setup-h", "换电脑时用"));
    msec.appendChild(el("p", "setup-p",
      "换电脑才用；本机升级不用管。"));
    var macts = el("div", "setup-actions");
    var out = el("button", "setup-btn", "导出成文件");
    out.type = "button";
    out.addEventListener("click", exportAll);
    macts.appendChild(out);

    var inp = el("button", "setup-btn", "从文件导入");
    inp.type = "button";
    inp.addEventListener("click", pickImport);
    macts.appendChild(inp);
    msec.appendChild(macts);
    p.appendChild(msec);

    /* 版本与更新：入口放在设置最后一页，和「导出/导入」同属维护动作。 */
    var upBox = el("div", "setup-update");
    upBox.appendChild(el("h3", "setup-h", "版本与更新"));
    var upHost = el("div");
    upHost.id = "setupUpdate";
    upBox.appendChild(upHost);
    p.appendChild(upBox);
    if (root.Update && root.Update.mount) root.Update.mount(upHost);

    if (root.Runtime && root.Runtime.ready && !root.Runtime.ready()) {
      p.appendChild(el("p", "setup-msg", "这个包本身缺配置，应用后可能算不出全天。"));
    }
    return p;
  }

  /* 每一步「能不能走」的规则跟步骤写在一起（见顶部 STEPS）。
     返回 true 放行，返回字符串就是拦下来的理由，直接显示给老师。 */
  function leaveClass() {
    if (!state.klass) return "先填班级名。「我的班」这种占位名屏上也能用，但家长会看到。";
    return true;
  }

  function leaveTime() {
    var bad = blockErrors();
    if (Object.keys(bad).length) {
      return "作息里有 " + Object.keys(bad).length + " 段时间不对，红色那几行先改好。";
    }
    return true;
  }

  function foot() {
    var f = el("div", "setup-foot");
    var back = el("button", "setup-btn ghost", "上一步");
    back.type = "button";
    back.disabled = state.step === 0;
    back.addEventListener("click", function () { state.step--; saveDraft(); render(); });
    f.appendChild(back);
    f.appendChild(el("span", "grow"));

    if (state.step < lastStep()) {
      var next = el("button", "setup-btn primary", "下一步");
      next.type = "button";
      next.addEventListener("click", function () {
        var step = STEPS[state.step];
        var why = step && step.canLeave ? step.canLeave() : true;
        if (why === true) {
          state.step++;
          saveDraft();
          render();
          return;
        }
        /* false = 这一步自己开了弹框（比如名单要核对），等老师在框里点；
           字符串 = 一句话说清为什么走不了。以前只认 true/false，
           两步都只能靠 alert 说一句，弹框那条路就堵死了。 */
        if (typeof why === "string" && why) alertBox(why);
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

  /* ---------- 本机备份 ----------
     能力都在 backup.js 里（list / restore），这里只负责画。
     不弹窗、不阻断：读不到备份就说读不到，老师照样能用向导。 */
  function mountBackupList(host) {
    var B = root.Backup;
    if (!B || !B.list) {
      host.appendChild(el("p", "setup-p", "当前打开方式读不到本机备份。"));
      return;
    }
    if (B.mode && B.mode() !== "http") {
      host.appendChild(el("p", "setup-p",
        "双击打开的没有每日备份；用桌面上的图标打开才有。"));
      return;
    }
    host.appendChild(el("p", "setup-p", "正在读本机备份…"));
    B.list(function (items) {
      host.textContent = "";
      if (!items || !items.length) {
        host.appendChild(el("p", "setup-p",
          "大屏开着就会每天存一份，留最近 14 天。"));
        return;
      }
      items.forEach(function (it) {
        var row = el("div", "setup-backup-row");
        row.appendChild(el("span", "setup-p",
          it.day + " · " + (it.klass || "未命名班")
          + " · " + Math.max(1, Math.round((it.size || 0) / 1024)) + " KB"));
        var b = el("button", "setup-btn", "恢复到这天");
        b.type = "button";
        b.addEventListener("click", function () {
          b.disabled = true;
          B.restore(it.day, function (r) {
            if (r && r.ok) {
              if (root.location && root.location.reload) root.location.reload();
              else render();
            } else {
              b.disabled = false;
              alertBox((r && r.why) || "这份备份打不开。");
            }
          });
        });
        row.appendChild(b);
        host.appendChild(row);
      });
    });
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
        alertBox("这里选不了文件，请在电脑上导入。");
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
          alertBox("这个文件打不开，可能选错了。原有设置没有改动。");
          return;
        }
        var r = root.Store.importAll(obj);
        if (!r.ok) {
          alertBox("导入失败：" + r.why + "。原有设置没有改动。");
          return;
        }
        state = fillState(loadCurrent());
        state.applied = true;
        /* 导入的是整份设置，各步没什么可填的了：直接跳到最后一页，
           老师点「完成」就收工。 */
        state.step = lastStep();
        state.flash = "已导入" + (r.klass ? "「" + r.klass + "」的" : "") + "整份设置，屏上已经换过来。点「完成」关掉这一页就行。";
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
    /* 名单文件：字段行（学校/班级/班主任）与姓名必须分得开 */
    _extractNames: extractNames,
    _metaFromText: metaFromText,
    _matchPeople: function (text, roster) { return matchPeople(text, roster || rosterNames()); },
    _mergeRoleImport: mergeRoleImport,
    _rosterNames: rosterNames,
    _rosterAll: rosterAll,
    _extractNames: extractNames,
    _mergeNames: mergeNames,
    _applyRosterList: applyRosterList,
    _rosterDiff: rosterDiff,
    _rosterImportPlan: rosterImportPlan,
    _rosterRefs: rosterRefsOf,
    _saveRoster: saveRoster,
    _parseTimeRows: parseTimeRows,
    _blocksFromTimeRows: blocksFromTimeRows,
    _noonBandOf: noonBandOf,
    _gridCellRows: gridCellRows,
    _gridFromRows: gridFromRows,
    _splitSubjectTeacher: splitSubjectTeacher,
    _knownSubjects: function (extra) {
      return root.Subjects ? root.Subjects.all(extra) : [];
    },
    _blockErrors: blockErrors,
    _commit: commitRolesTexts
  };

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }
})(typeof window !== "undefined" ? window : globalThis);
