/* P3 数据层：覆盖、话术、名单检索、验证码。
   纯函数（applyOverrides / rankStudents / challenge）不碰 DOM，可 node 测。
   存储坏掉时：备份坏数据 → 回退默认 → 大屏继续能跑（PLAN P3 失败处理）。 */
(function (root) {
  "use strict";

  var KEY = {
    overrides: "rhythm.overrides.v1",
    history:   "rhythm.history.v1",
    phrases:   "rhythm.phrases.v1",
    prefs:     "rhythm.prefs.v1",
    picked:    "rhythm.picked.v1",
    lock:      "rhythm.lock.v1",
    texts:     "rhythm.texts.v1",
    config:    "rhythm.config.v1",
    schema:    "rhythm.schema.v1",
    snapshot:  "rhythm.setup.snapshot.v1"
  };

  var mem = {};

  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

  function ls() {
    try {
      var s = root.localStorage;
      if (!s) return null;
      s.setItem("__probe", "1");
      s.removeItem("__probe");
      return s;
    } catch (e) { return null; }
  }

  function read(k, def) {
    var s = ls();
    if (!s) return mem[k] !== undefined ? clone(mem[k]) : clone(def);
    var raw = null;
    try { raw = s.getItem(k); } catch (e) { return clone(def); }
    if (!raw) return clone(def);
    try {
      var v = JSON.parse(raw);
      return v == null ? clone(def) : v;
    } catch (e) {
      /* 坏数据不当垃圾扔掉：留一份现场，再回退 */
      try { s.setItem(k + ".broken." + Date.now(), raw); } catch (_) {}
      return clone(def);
    }
  }

  function write(k, v) {
    var s = ls();
    if (!s) { mem[k] = clone(v); return false; }
    try { s.setItem(k, JSON.stringify(v)); return true; }
    catch (e) { mem[k] = clone(v); return false; }
  }

  /* ---------- 日期 ---------- */
  function dayKey(d) {
    /* 不传日期时以北京时间为准：设备时区不对，覆盖层不能写到昨天去 */
    if (!d && root.Clock && root.Clock.dayKey) return root.Clock.dayKey();
    d = d || new Date();
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  /* ---------- 覆盖层 ---------- */
  function allOverrides() { return read(KEY.overrides, {}); }

  function getDayOverride(key) {
    var all = allOverrides();
    return all[key] || null;
  }

  function pushHistory(key, snapshot) {
    var h = read(KEY.history, {});
    h[key] = (h[key] || []).concat([clone(snapshot)]).slice(-10);
    write(KEY.history, h);
  }

  /* 合并式修改：只传要改的字段，不动其他 */
  function patchDayOverride(key, patch) {
    var all = allOverrides();
    var cur = all[key] || {};
    pushHistory(key, cur);
    /* 合完再整条过闸门：存人的地方（roles[].people / lessons[].teacher）
       不许带着对象进来。这一步就是「腌毒链」的第④步，必须断在这里。 */
    var next = cleanOverride(Object.assign({}, cur, patch)) || {};
    next.updatedAt = new Date().toISOString();
    all[key] = next;
    write(KEY.overrides, all);
    return all[key];
  }

  function clearDayOverride(key) {
    var all = allOverrides();
    if (!all[key]) return;
    pushHistory(key, all[key]);
    delete all[key];
    write(KEY.overrides, all);
  }

  function undo(key) {
    var h = read(KEY.history, {});
    var stack = h[key] || [];
    if (!stack.length) return false;
    var prev = stack.pop();
    h[key] = stack;
    write(KEY.history, h);

    var all = allOverrides();
    if (prev && Object.keys(prev).length) all[key] = prev;
    else delete all[key];
    write(KEY.overrides, all);
    return true;
  }

  function canUndo(key) {
    var h = read(KEY.history, {});
    return (h[key] || []).length > 0;
  }

  /* 把覆盖套到当天数据上，返回新对象，不改原始数据 */
  function applyOverrides(day, ov) {
    if (!day || !ov) return day;
    var out = clone(day);

    if (ov.lessons) {
      (out.timeline || []).forEach(function (b) {
        if (b.type !== "class") return;
        var L = ov.lessons[b.periodNo];
        if (!L) return;
        if (L.subject) b.subject = L.subject;
        /* 老师名也走同一个归一：历史覆盖里可能存着对象，
           以前原样赋给 b.teacher，屏上就是 [object Object]。 */
        if (L.teacher !== undefined) b.teacher = personNameOf(L.teacher) || null;
        if (L.place !== undefined) b.place = L.place;
        b.overridden = true;
      });
    }

    if (ov.noon) {
      (out.timeline || []).forEach(function (b) {
        if (b.type !== "noon") return;
        if (ov.noon.title) b.name = ov.noon.title;
        if (ov.noon.tip !== undefined) b.tip = ov.noon.tip;
        if (ov.noon.items) b.items = ov.noon.items;
        b.overridden = true;
      });
    }

    if (ov.roles) {
      (out.duties || []).forEach(function (d) {
        var r = ov.roles[d.roleId];
        if (!r) return;
        /* 用 peopleList 而不是 slice()：
           · 对象元素会被还原成人名，而不是原样带上屏；
           · 历史覆盖里 people 是字符串时（"张三"），slice() 得到的是字符
             串本身，后面 peopleText 调 .map 会直接抛错，整块值日条白掉。 */
        if ("people" in r) {
          var names = peopleList(r.people);
          d.people = names;
          d.status = names.length ? "ok" : "unknown";
          d.reason = d.status === "ok" ? null : "no-people";
          d.peopleFrom = names.length ? "override" : "none";
        }
        if (r.at) d.at = r.at;
        d.overridden = true;
      });
    }

    return out;
  }

  /* ---------- 名单归一化 ---------- */
  /* 名单在仓库里本来只有一种形状：`[{id, name, active}]`。但实际机器上见过
     另外两种，都来自「别人做的设置文件」与「手工改过的班级数据」：
       · 纯字符串数组 ["张三", "李四"]；
       · name 本身是对象 {name: {name: "张三"}}。
     不归一化，第一种会让 rankStudents 在 `s.name.indexOf` 上直接抛错
     （换人面板整块空掉，看起来就是「打一个字不出人」）；第二种会一路
     走到界面上显示成 [object Object]。所以在数据层收口一次。

     ★ 这是全项目唯一的人名归一化实现。edit / screen / setup 都调它。
       引擎（engine/schedule.js）另有一份极小兜底，因为它要脱离 UI 独立
       运行、并与 Python 版逐字段对拍；那份只在引擎内部整理输入用，
       不参与写路径，永远不会把脏数据带回存储。别把它当第二套规格。 */
  function personNameOf(v, depth) {
    var d = depth || 0;
    if (v == null) return "";
    if (typeof v === "string") return v.trim();
    if (typeof v === "number") return String(v);
    if (typeof v === "object" && d < 3) {
      var inner = v.name != null ? v.name : (v.label != null ? v.label : "");
      return personNameOf(inner, d + 1);
    }
    return "";
  }

  /* 一个「人的集合」→ 干净的人名数组：去空、去 [object Object]、去重，
     顺手按分隔符拆开（配置里常见 people: ["张三、李四"]）。
     人名里不会出现这些符号；不拆的话上屏碰巧没错，但按姓名核对时对不上。 */
  var NAME_SEP = /[、\/／,，;；|｜]+/;
  function peopleList(v) {
    if (v == null) return [];
    var arr = Array.isArray(v) ? v : [v];
    var out = [];
    arr.forEach(function (x) {
      var n = personNameOf(x);
      if (!n || n === "[object Object]") return;
      n.split(NAME_SEP).forEach(function (part) {
        var p = part.trim();
        if (p && p !== "[object Object]" && out.indexOf(p) < 0) out.push(p);
      });
    });
    return out;
  }

  function normStudents(list) {
    var src = list;
    if (isPlain(src) && Array.isArray(src.students)) src = src.students;
    if (!Array.isArray(src)) return [];
    var out = [];
    src.forEach(function (s) {
      if (s == null) return;
      if (typeof s === "string" || typeof s === "number") {
        var raw = String(s).trim();
        if (raw) out.push({ name: raw, active: true });
        return;
      }
      if (typeof s !== "object") return;
      var name = personNameOf(s.name);
      /* "[object Object]" 是没有信息量的残留，不收 */
      if (!name || name === "[object Object]") return;
      var o = { name: name, active: s.active !== false };
      if (s.id != null && String(s.id) !== "") o.id = String(s.id);
      var alias = personNameOf(s.alias);
      if (alias && alias !== "[object Object]") o.alias = alias;
      out.push(o);
    });
    return out;
  }

  /* ---------- 名单检索 ---------- */
  /* 排序：本场景相关的人 → 最近点过 → 名单顺序。
     这是 2.17 定的规则，越靠前的越容易被点到。
     输入先归一化：老师打的第一个字就是「姓」，`indexOf` 已经能命中，
     不需要额外的拼音或首字母表。 */
  function rankStudents(list, q, related, limit) {
    q = String(q == null ? "" : q).trim();
    limit = limit || 8;
    if (!limit || limit < 1) return [];

    var all = normStudents(list);
    if (!all.length) return [];

    /* 相关人（这个岗位原来是谁）也可能带对象，一并取名字 */
    var rel = [];
    (Array.isArray(related) ? related : []).forEach(function (n) {
      var v = personNameOf(n);
      if (v && v !== "[object Object]") rel.push(v);
    });

    var pool = all.filter(function (s) {
      if (s.active === false) return false;
      if (!q) return true;
      return s.name.indexOf(q) >= 0 || (s.alias && s.alias.indexOf(q) >= 0);
    });

    var picked = read(KEY.picked, {});
    var idx = {};
    all.forEach(function (s, i) { idx[s.name] = i; });

    pool.sort(function (a, b) {
      var ra = rel.indexOf(a.name) >= 0 ? 0 : 1;
      var rb = rel.indexOf(b.name) >= 0 ? 0 : 1;
      if (ra !== rb) return ra - rb;
      var ta = picked[a.name] || 0, tb = picked[b.name] || 0;
      if (ta !== tb) return tb - ta;
      return (idx[a.name] || 0) - (idx[b.name] || 0);
    });

    return pool.slice(0, limit);
  }

  function markPicked(name) {
    name = personNameOf(name);
    if (!name || name === "[object Object]") return;
    var p = read(KEY.picked, {});
    p[name] = Date.now();
    var keys = Object.keys(p);
    if (keys.length > 60) {
      keys.sort(function (a, b) { return p[a] - p[b]; })
          .slice(0, keys.length - 60)
          .forEach(function (k) { delete p[k]; });
    }
    write(KEY.picked, p);
  }

  /* ---------- 话术 ---------- */
  var PINNED_MAX = 12, RECENT_MAX = 5;

  function allPhrases() { return read(KEY.phrases, []); }

  /* 召回：记住的排前面，最近用过的补在后面。两层都要有，
     因为"刚才那条改一下"和"我常说的那句"是两种需求。 */
  function recall(scope) {
    var list = allPhrases().filter(function (p) { return p.scope === scope && p.text; });
    var pinned = list.filter(function (p) { return p.pinned; })
      .sort(function (a, b) { return (b.useCount || 0) - (a.useCount || 0); })
      .slice(0, PINNED_MAX);
    var pinnedText = {};
    pinned.forEach(function (p) { pinnedText[p.text] = 1; });
    var recent = list.filter(function (p) { return !p.pinned && !pinnedText[p.text]; })
      .sort(function (a, b) { return (b.lastUsedAt || 0) - (a.lastUsedAt || 0); })
      .slice(0, RECENT_MAX);
    return pinned.concat(recent);
  }

  function remember(scope, text, pinned) {
    text = (text || "").trim();
    if (!text) return allPhrases();
    var list = allPhrases();
    var hit = null;
    list.forEach(function (p) { if (p.scope === scope && p.text === text) hit = p; });

    if (hit) {
      hit.useCount = (hit.useCount || 0) + 1;
      hit.lastUsedAt = Date.now();
      if (pinned) hit.pinned = true;
    } else {
      list.push({
        id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        scope: scope, text: text, pinned: !!pinned,
        useCount: 1, lastUsedAt: Date.now(), createdAt: Date.now()
      });
    }
    write(KEY.phrases, trimPhrases(list));
    return list;
  }

  function removePhrase(id) {
    var list = allPhrases().filter(function (p) { return p.id !== id; });
    write(KEY.phrases, list);
    return list;
  }

  function trimPhrases(list) {    var byScope = {};
    list.forEach(function (p) { (byScope[p.scope] = byScope[p.scope] || []).push(p); });
    var keep = [];
    Object.keys(byScope).forEach(function (sc) {
      var arr = byScope[sc];
      var pin = arr.filter(function (p) { return p.pinned; })
        .sort(function (a, b) { return (b.useCount || 0) - (a.useCount || 0); })
        .slice(0, PINNED_MAX);
      var pinText = {};
      pin.forEach(function (p) { pinText[p.text] = 1; });
      var rec = arr.filter(function (p) { return !pinText[p.text]; })
        .sort(function (a, b) { return (b.lastUsedAt || 0) - (a.lastUsedAt || 0); })
        .slice(0, RECENT_MAX);
      keep = keep.concat(pin, rec);
    });
    return keep;
  }

  /* ---------- 时间词检测 ---------- */
  /* 话术复用最大的坑：上周写"今天 12:50"，这周直接填进去就是错的。
     不做自动替换（猜不准），只标出来要求确认一次。 */
  var TIME_WORD = /今天|明天|后天|昨天|周一|周二|周三|周四|周五|周六|周日|上午|下午|中午|晚上|\d{1,2}[:：]\d{2}/g;

  function findTimeWords(text) {
    if (!text) return [];
    var m = String(text).match(TIME_WORD) || [];
    return m.filter(function (v, i) { return m.indexOf(v) === i; });
  }

  /* ---------- 验证码 ---------- */
  /* 小数 ÷ 整数，除得尽，五年级口算能出：
       · 一位小数：9.6 ÷ 8 = 1.2
       · 两位小数：1.48 ÷ 4 = 0.37
     先取「以 0.1 / 0.01 为单位的整数」n，再取除数 b，只从 b 的倍数里挑 n——
     这样天然没有余数，也不用碰浮点除法。 */
  function makeChallenge() {
    for (var i = 0; i < 60; i++) {
      var b = 2 + Math.floor(Math.random() * 8);      /* 除数 2-9 */
      var two = Math.random() < 0.5;                   /* 被除数是两位小数 */
      var scale = two ? 100 : 10;
      var lo = two ? 11 : 5, hi = two ? 499 : 99;      /* 0.11-4.99 / 0.5-9.9 */
      var first = Math.ceil(lo / b) * b;
      var last = Math.floor(hi / b) * b;
      if (last < first) continue;
      var n = first + b * Math.floor(Math.random() * ((last - first) / b + 1));
      /* 末位是 0 的话，实际只有一位小数（或干脆是整数），题目就名不副实了 */
      if (n % 10 === 0) continue;
      var answer = n / b / scale;
      if (answer < 0.05) continue;                     /* 0.02 这种不像口算题 */
      return {
        a: n / scale,
        b: b,
        answer: answer,
        text: (n / scale).toFixed(two ? 2 : 1) + " ÷ " + b
      };
    }
    /* 理论上到不了；真到了也给一道成立的题，不能把老师锁在门外 */
    return { a: 9.6, b: 8, answer: 1.2, text: "9.6 ÷ 8" };
  }

  /* 连错 3 次锁 60 秒。学生乱试的成本要提高，但不至于把老师也锁死。 */
  function lockState() {
    var l = read(KEY.lock, { fails: 0, until: 0 });
    if (l.until && Date.now() > l.until) {
      l = { fails: 0, until: 0 };
      write(KEY.lock, l);
    }
    return l;
  }

  function recordFail() {
    var l = lockState();
    l.fails = (l.fails || 0) + 1;
    if (l.fails >= 3) { l.until = Date.now() + 60000; l.fails = 0; }
    write(KEY.lock, l);
    return l;
  }

  function resetFail() { write(KEY.lock, { fails: 0, until: 0 }); }

  /* ---------- 屏上文字 ---------- */
  /* 只存"老师改过的"，没改的沿用系统默认。
     这样以后改了默认文案，老师没动过的地方会自动跟上。 */
  /* 打包时可以把某位老师改好的文字烤成本包的默认值（RHYTHM_DATA.texts）。
     本机没改过就吃包里的默认，改过就吃本机的——换机器不会丢。
     注意是 RHYTHM_DATA：早先这里写成了 root.DATA，那个全局从来不存在，
     烤进去的文案一直是死的，只有本机 localStorage 在起作用。 */
  function isPlain(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  /* 本机改过的文案只盖住改到的那一层，没改到的继续吃包里的默认。
     不这么并：老师早先改过任何一条，localStorage 里就存了半份文案，
     后来包里新加的「提醒事项」会被整份挡住，屏上再也不出现。
     数组和字符串当叶子，"" 也算有效值，能用来清空某一句。 */
  function mergeTexts(base, over) {
    if (!isPlain(base) || !isPlain(over)) return over;
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    Object.keys(over).forEach(function (k) {
      out[k] = (isPlain(base[k]) && isPlain(over[k]))
        ? mergeTexts(base[k], over[k])
        : over[k];
    });
    return out;
  }

  function texts() {
    var local = read(KEY.texts, null);
    var baked = root.RHYTHM_DATA && root.RHYTHM_DATA.texts;
    var hasLocal = !!local && Object.keys(local).length > 0;
    if (!hasLocal) return isPlain(baked) ? baked : (local || {});
    if (!isPlain(baked)) return local;
    return mergeTexts(baked, local);
  }

  function patchTexts(patch) {
    /* 从当前生效的文案起步，而不是从空对象起步：
       包里烤了 data/texts.json 时，第一次改任意一项不能把其余默认值抹掉。 */
    var cur = clone(texts()) || {};
    Object.keys(patch).forEach(function (k) {
      if (patch[k] == null) delete cur[k];
      else cur[k] = patch[k];
    });
    write(KEY.texts, cur);
    return cur;
  }

  function resetTexts() {
    write(KEY.texts, {});
    return {};
  }

  /* 配置向导要用「本机原文案」而不是 texts()：texts() 会把包内默认并进来，
     拿它做快照，恢复时会把别人的默认写成自己的改动。 */
  function textsLocal() {
    var v = read(KEY.texts, null);
    return (v && Object.keys(v).length) ? v : null;
  }

  function setTextsLocal(obj) {
    return write(KEY.texts, (obj && typeof obj === "object") ? obj : {});
  }

  /* 向导保存前的快照：只放岗位和文案，够还原这两块就行。
     不带撤销栈、不带班级作息课表——那些有各自的导入导出。 */
  function setupSnapshot(v) {
    if (arguments.length) { write(KEY.snapshot, v || null); return v; }
    return read(KEY.snapshot, null);
  }

  /* ---------- 本机配置：作息 / 课表 / 班级信息 ---------- */
  /* data.js 里的配置是出厂值，老师在设置里改的存这里，读时盖在出厂值上。
     整块替换而不是逐字段深合并：一张作息表改一条边界，本来就是整表重写，
     深合并只会留下「删掉的那一段又冒回来」这种怪事。 */
  var CONFIG_BLOCKS = ["meta", "timetable", "schedule", "roles",
                       "content", "noon", "calendar", "students", "peopleGroups",
                       "dutyPresents"];

  function config() {
    var c = read(KEY.config, null);
    if (!c || typeof c !== "object") return {};
    var out = {};
    CONFIG_BLOCKS.forEach(function (k) {
      if (c[k] !== undefined && c[k] !== null) out[k] = c[k];
    });
    return out;
  }

  /* 每块各自的清洗。新增「存人」的块时只在这里登记一处。 */
  function cleanBlock(k, v) {
    if (k === "students") {
      var st = normStudents(v);
      return st.length ? st : null;      /* 空名单等同于「没有名单」 */
    }
    if (k === "peopleGroups") return cleanGroups(v);
    /* roles 必须是对象：写成别的东西会让引擎 buildDay 直接抛错，
       整块大屏白掉。宁可当成「没配置」，让 roleDoc 回退到出厂岗位。 */
    if (k === "roles") return isPlain(v) ? cleanRolesDoc(v) : null;
    return v;                             /* 其余块不含人，原样放行 */
  }

  function patchConfig(patch) {
    var cur = config();
    Object.keys(patch || {}).forEach(function (k) {
      if (CONFIG_BLOCKS.indexOf(k) < 0) return;
      if (patch[k] === null) { delete cur[k]; return; }
      if (patch[k] === undefined) return;
      var v = cleanBlock(k, patch[k]);
      if (v === null || v === undefined) delete cur[k];
      else cur[k] = v;
    });
    write(KEY.config, cur);
    /* 大屏每秒重绘，但改完设置最好立刻看到，所以这里主动通知一次 */
    if (root.Runtime && root.Runtime.reload) root.Runtime.reload();
    if (root.Screen && root.Screen.render) root.Screen.render();
    return cur;
  }

  function resetConfig() {
    write(KEY.config, {});
    if (root.Runtime && root.Runtime.reload) root.Runtime.reload();
    if (root.Screen && root.Screen.render) root.Screen.render();
    return {};
  }

  /* ---------- 岗位顺序 ---------- */
  /* 值日条按 order 从小到大排（PLAN 2.14），这个先后由班主任定（2.4）。
     老数据里多条岗位并列同一个 order（比如三个 0），只交换两个数字看不出变化；
     所以按当前位置换完人，再统一重排成 5、10、15…，相对顺序唯一且可预期。 */
  function reorderRoles(roles, roleId, delta) {
    var list = (roles || []).map(function (r, i) {
      return { role: r, at: i, order: (typeof r.order === "number" ? r.order : i) };
    }).sort(function (a, b) { return a.order - b.order || a.at - b.at; });

    var from = -1;
    list.forEach(function (x, i) { if (x.role.id === roleId) from = i; });
    if (from < 0) return { changed: false, roles: (roles || []).slice() };

    var to = from + (delta < 0 ? -1 : 1);
    if (to < 0 || to >= list.length) return { changed: false, roles: (roles || []).slice() };

    var tmp = list[from]; list[from] = list[to]; list[to] = tmp;
    return {
      changed: true,
      roles: list.map(function (x, i) {
        var c = clone(x.role);
        c.order = (i + 1) * 5;
        return c;
      })
    };
  }

  /* ---------- 人群组（PLAN 2.18） ----------
     只落库老师显式「存成组」的点名组；排班组（source:role）的成员
     每次都从岗位实时取，不存快照。临时勾选走弹窗内存，不写这里。 */
  /* 组员 id 只认字符串。历史上见过两种脏数据，都会一路显示成 [object Object]：
       · 存进来的是对象 {id, name}——旧代码直接 String(m) 就成了 "[object Object]"；
       · 已经写坏的 "[object Object]" 字面量。
     对象能救就救（有 id 用 id，没有就用 name 走 `name:` 兜底）；
     字面量没有信息量，只能丢——但组本身和其它成员留着，别整组消失。 */
  /* 组员的键：姓名优先，id 只作别名。
     原因（2026-11-23 复盘）：学生 id 是人在 students.json 里手写的
     （s01、s02…），系统不生成、也不保证跨文件稳定——换一份名单就全变，
     老师「修正名单」时新加的人干脆没有 id。把它当主键，组就会「丢人」。
     姓名才是老师实际认的身份，也是 people / groups / peopleMap 一直在用的键。
     编码保持三种不变，老数据照样读得出来：
       · "name:张三"  —— 现在的写入形式（换名单不丢）
       · "s01"        —— 更早的写入形式（rosterNameIndex 反查姓名）
       · "张三"       —— 手工写的纯姓名 */
  function memberIdOf(m) {
    if (m == null) return "";
    if (typeof m === "object") {
      var n = personNameOf(m.name != null ? m.name : "");
      if (n && n !== "[object Object]") return "name:" + n;
      var id = m.id != null ? String(m.id).trim() : "";
      return (id && id !== "[object Object]") ? id : "";
    }
    var v = String(m).trim();
    if (!v || v === "[object Object]" || v === "name:[object Object]") return "";
    return v;
  }

  function normGroup(g) {
    if (!isPlain(g)) return null;
    /* 排班组（source:role）的成员每次都从岗位实时取，存成快照第二天就过期。
       这是「老师显式存组」这条路径上的有意拒绝——清洗旧数据走的是
       cleanGroupOne，那条路会把放错地方的 role 组按手动组救回来。 */
    if (g.source !== undefined && g.source !== "manual") return null;
    var name = personNameOf(g.name);
    if (!name || name === "[object Object]") return null;
    var ids = [];
    (Array.isArray(g.memberIds) ? g.memberIds : []).forEach(function (m) {
      var v = memberIdOf(m);
      if (v && ids.indexOf(v) < 0) ids.push(v);
    });
    /* 老师新建/修改组时必须真有成员；清洗旧数据不走这里，走 cleanGroupOne
       ——那边允许空组，因为「留个空组」比「组凭空消失」更容易解释。 */
    if (!ids.length) return null;
    return {
      id: String(g.id == null ? "" : g.id).trim(),
      name: name,
      source: "manual",
      memberIds: ids,
      order: typeof g.order === "number" ? g.order : 0
    };
  }

  /* 同一 id 再存就是改名/换成员，不新增一条 */
  function upsertGroup(list, g) {
    var out = (Array.isArray(list) ? list : []).slice();
    var n = normGroup(g);
    if (!n || !n.id) return out;
    var hit = -1;
    out.forEach(function (x, i) { if (x && x.id === n.id) hit = i; });
    if (hit >= 0) out[hit] = n; else out.push(n);
    return out;
  }

  function removeGroup(list, id) {
    return (Array.isArray(list) ? list : []).filter(function (g) {
      return g && g.id !== id;
    });
  }

  function peopleGroups() {
    var list = config().peopleGroups;
    return Array.isArray(list) ? clone(list) : [];
  }

  function saveGroup(g) {
    /* 拒绝的理由要说得准：以前这里和「没名字/没成员」共用一句
       「组名和成员都要有」，传了排班组的人看到这句会以为是自己漏填了。 */
    if (isPlain(g) && g.source !== undefined && g.source !== "manual") {
      return { ok: false, why: "排班组的成员每次都从岗位实时取，不需要存成组。" };
    }
    var n = normGroup(g);
    if (!n || !n.id) return { ok: false, why: "组名和成员都要有。" };
    var next = upsertGroup(peopleGroups(), n);
    patchConfig({ peopleGroups: next });
    return { ok: true, groups: next };
  }

  function deleteGroup(id) {
    var next = removeGroup(peopleGroups(), id);
    patchConfig({ peopleGroups: next });
    return next;
  }

  /* ---------- 数据体检 ----------
     写闸门负责把「形状坏的」改回来（对象→姓名、字面量→丢掉）。
     但还有一类它管不了：形状没问题、只是「这个人不在名单里了」。
     这类最容易被老师当成「功能丢了」——组还在、点开却是空的。
     不静默修（自动认领可能认错同名学生），集中列出来给老师看。 */

  /* 老编码 "s01" → 稳定的 "name:张三"。名单可用时做一次，
     以后换名单也不会整片对不上。返回转换条数。 */
  function fixGroupKeys() {
    var cfg = config();
    var stu = normStudents(cfg.students);
    if (!stu.length || !Array.isArray(cfg.peopleGroups)) return { fixed: 0 };
    var byId = {};
    stu.forEach(function (s) { if (s.id) byId[String(s.id)] = s.name; });
    var n = 0;
    var next = cfg.peopleGroups.map(function (g) {
      if (!isPlain(g) || !Array.isArray(g.memberIds)) return g;
      var ids = [];
      g.memberIds.forEach(function (m) {
        var k = memberIdOf(m);
        if (!k) return;
        if (k.indexOf("name:") !== 0 && byId[k]) { k = "name:" + byId[k]; n++; }
        if (ids.indexOf(k) < 0) ids.push(k);
      });
      var o = clone(g);
      o.memberIds = ids;
      return o;
    });
    if (n) patchConfig({ peopleGroups: next });
    return { fixed: n };
  }

  /* 纯读体检。名单没录入时不判「对不上」——那不是错误，是还没填。 */
  function auditPeople() {
    var cfg = config();
    var stu = normStudents(cfg.students);
    var names = {}, ids = {};
    stu.forEach(function (s) { names[s.name] = 1; if (s.id) ids[String(s.id)] = 1; });
    var hasRoster = stu.length > 0;
    var items = [];

    function missingOf(v) {
      var k = memberIdOf(v);
      if (!k) return null;
      if (k.indexOf("name:") === 0) {
        var nm = k.slice(5);
        return names[nm] ? null : nm;
      }
      return ids[k] ? null : k;
    }

    if (hasRoster) {
      (cfg.peopleGroups || []).forEach(function (g) {
        var bad = [];
        (g.memberIds || []).forEach(function (m) {
          var miss = missingOf(m);
          if (miss && bad.indexOf(miss) < 0) bad.push(miss);
        });
        if (bad.length) {
          items.push({ kind: "group", name: g.name, detail: bad.join("、") + " 不在当前名单里" });
        }
      });

      ((cfg.roles || {}).roles || []).forEach(function (r) {
        var raw = peopleList(r.people);
        if (r.peopleMap) Object.keys(r.peopleMap).forEach(function (k) {
          raw = raw.concat(peopleList(r.peopleMap[k]));
        });
        if (r.groups) Object.keys(r.groups).forEach(function (k) {
          raw = raw.concat(peopleList(r.groups[k]));
        });
        var bad = [];
        raw.forEach(function (n) { if (!names[n] && bad.indexOf(n) < 0) bad.push(n); });
        if (bad.length) {
          items.push({ kind: "role", name: r.name, detail: bad.join("、") + " 不在当前名单里" });
        }
      });
    }

    return { ok: items.length === 0, hasRoster: hasRoster, items: items };
  }

  /* ---------- 偏好 ---------- */
  /* 动效默认关（2026-11-19 真机反馈③：默认无动效，点「增加动效」才开）。
     reduceChosen 记录老师是否主动按过开关：没按过的旧机器升级后一律
     进"无动效"，按过之后才按自己的选择来。其余键（theme、prepLead…）
     原样保留。 */
  function prefs() {
    var p = read(KEY.prefs, {}) || {};
    var chosen = p.reduceChosen === true;
    var out = clone(p);
    if (!out || typeof out !== "object") out = {};
    out.cdMode = p.cdMode || "auto";
    out.reduce = chosen ? p.reduce !== false : true;
    out.reduceChosen = chosen;
    return out;
  }
  function setPref(k, v) {
    var p = read(KEY.prefs, {}) || {};
    p[k] = v;
    if (k === "reduce") p.reduceChosen = true;
    write(KEY.prefs, p);
    return prefs();
  }

  /* ---------- 备份 / 迁移 ---------- */
  /* 老师改的东西全在这台机器的 localStorage 里：换机器、清缓存、
     或者要人帮着打包，都得能整车搬走。撤销栈不搬——那是过程不是结果。 */
  var EXPORT_FORMAT = "rhythm-config/v1";

  function exportAll() {
    /* 导出整份生效配置，不是只导本机改动：对方可能拿的是另一个包，
       少了这份，班级作息课表就接不上。 */
    var full = (root.Runtime && root.Runtime.config) ? root.Runtime.config() : null;
    var out = Object.assign({}, full || config());
    /* 名单与人群组只取「本机修正过的」那份：Runtime.config 按 LOCAL_ONLY
       故意不含它们（出厂包里的名单是样例，写进备份就等于把它冻结了，
       以后换新包再也不更新）。 */
    var local = read(KEY.config, {});
    if (local && local.students) out.students = local.students;
    if (local && local.peopleGroups) out.peopleGroups = local.peopleGroups;
    return {
      format: EXPORT_FORMAT,
      schemaVersion: configVersion(),
      savedAt: new Date().toISOString(),
      texts: read(KEY.texts, {}) || {},
      overrides: read(KEY.overrides, {}) || {},
      config: out,
      phrases: allPhrases(),
      prefs: prefs()
    };
  }

  /* ---------- 写闸门 ----------
     为什么要有这一层（2026-11-23 复盘）：

     「人」这个实体以前在系统里有五种写法同时在流转——"张三"、{name}、
     {id,name}、id 串、"name:张三"——于是每个读它的人都得自己猜一遍，
     全项目猜出了五份 nameOf。更糟的是写入路径毫无约束：patchConfig /
     patchDayOverride / importAll 谁拿到什么就存什么，脏数据进得去；
     exportAll 又原样吐出来，把脏数据固化进备份；importAll 反过来用
     元素级条件整份拒绝，能救的也救不回来。四条路拼成一个死锁。

     修法不是给每条路各加一个兜底，而是：凡是落进存储的「存人字段」，
     一律先过这里。清洗是写入口的固有属性，不再靠 schema 版本号触发——
     版本号只能洗一次，写闸门每次写都生效。

     清洗（宽）与校验（严）分工：
       · 清洗发生在写之前，尽量把旧数据救回来，救不回的也不静默删；
       · 校验只查骨架（是不是数组、是不是对象），不查元素类型——
         元素长什么样是清洗的责任，校验越权就会把能救的文件判死。 */

  /* 岗位文档：people / peopleMap / groups / substitute 四处都存人 */
  function cleanRoleOne(r) {
    if (!isPlain(r)) return null;
    var o = clone(r);
    if ("people" in o) o.people = peopleList(o.people);
    if (o.peopleMap !== undefined) {
      if (!isPlain(o.peopleMap)) delete o.peopleMap;
      else Object.keys(o.peopleMap).forEach(function (k) {
        var names = peopleList(o.peopleMap[k]);
        if (names.length) o.peopleMap[k] = names[0];
        else delete o.peopleMap[k];
      });
    }
    if (o.groups !== undefined) {
      if (!isPlain(o.groups)) delete o.groups;
      else Object.keys(o.groups).forEach(function (k) {
        var names = peopleList(o.groups[k]);
        if (names.length) o.groups[k] = names;
        else delete o.groups[k];
      });
    }
    if (o.substitute !== undefined) {
      /* 替补不是「人名列表」，是「人 + 备注」的记录（data.js 里 r11 的
         {"name":"陈静姝","note":"特殊情况帮忙擦黑板"}），tools/check_p1.py
         也按 s["name"] 读。所以只清洗 name，不能拍平成字符串数组。 */
      o.substitute = (Array.isArray(o.substitute) ? o.substitute : [o.substitute])
        .map(function (x) {
          if (isPlain(x)) {
            var y = clone(x);
            y.name = personNameOf(y.name);
            return y.name ? y : null;
          }
          var n = personNameOf(x);
          return n ? { name: n } : null;
        })
        .filter(function (x) { return !!x; });
    }
    return o;
  }

  function cleanRolesDoc(doc) {
    if (!isPlain(doc)) return doc;
    var out = clone(doc);
    if (Array.isArray(out.roles)) {
      out.roles = out.roles.map(cleanRoleOne).filter(function (r) { return !!r; });
    }
    return out;
  }

  /* 人群组：组名与成员都可能被写坏。能救的救，救不回的保留空组，
     由 P4 的确认清单报给老师，不在这里静默丢弃。 */
  function cleanGroupOne(g) {
    if (!isPlain(g)) return null;
    var o = clone(g);
    var nm = personNameOf(o.name);
    o.name = (nm && nm !== "[object Object]") ? nm : "未命名组";
    var ids = [];
    /* memberIds 偶尔被写成单个值而不是数组（"s01"）。当单值救回来，
       比当成空数组丢掉整组好。 */
    var raw = Array.isArray(o.memberIds) ? o.memberIds
            : (o.memberIds == null ? [] : [o.memberIds]);
    raw.forEach(function (m) {
      var v = memberIdOf(m);
      if (v && ids.indexOf(v) < 0) ids.push(v);
    });
    o.memberIds = ids;
    /* peopleGroups 里装的就是手动组；历史脏数据里的 source:"role"
       属于放错了地方，按手动组救回来，别让整组消失。 */
    o.source = "manual";
    return o;
  }

  function cleanGroups(list) {
    if (!Array.isArray(list)) return [];
    return list.map(cleanGroupOne).filter(function (g) { return !!g; });
  }

  /* 某一天的临时调整：roles[id].people 与 lessons[periodNo].teacher */
  function cleanOverride(o) {
    if (!isPlain(o)) return null;
    var out = clone(o);
    if (isPlain(out.roles)) {
      Object.keys(out.roles).forEach(function (id) {
        var r = out.roles[id];
        if (!isPlain(r)) { delete out.roles[id]; return; }
        if ("people" in r) r.people = peopleList(r.people);
      });
    }
    if (isPlain(out.lessons)) {
      Object.keys(out.lessons).forEach(function (p) {
        var L = out.lessons[p];
        if (!isPlain(L)) { delete out.lessons[p]; return; }
        if (L.teacher !== undefined) {
          /* 已经被腌进去的字面量 "[object Object]" 顺手清成空：
             它是显示故障留下的残渣，不是老师输入的老师名。 */
          var tn = personNameOf(L.teacher);
          L.teacher = tn === "[object Object]" ? "" : tn;
        }
      });
    }
    return out;
  }

  function cleanOverrides(all) {
    if (!isPlain(all)) return {};
    var out = {};
    Object.keys(all).forEach(function (k) {
      var o = cleanOverride(all[k]);
      if (isPlain(o) && Object.keys(o).length) out[k] = o;
    });
    return out;
  }

  /* 整份班级配置 */
  function cleanConfig(c) {
    if (!isPlain(c)) return c;
    var out = clone(c);

    if (out.students !== undefined) {
      var st = normStudents(out.students);
      if (st.length) out.students = st;
      else if (Array.isArray(out.students)) delete out.students;
    }

    if (Array.isArray(out.peopleGroups)) {
      out.peopleGroups = cleanGroups(out.peopleGroups);
    }

    if (isPlain(out.roles)) {
      out.roles = cleanRolesDoc(out.roles);
    }

    return out;
  }

  /* 老名字：迁移与导入都在用，行为与 cleanConfig 完全一致 */
  function sanitizeConfig(c) {
    return cleanConfig(c);
  }

  /* ---------- 配置版本与迁移 ----------
     老师的配置只活在这台机器上；格式一改，老 localStorage 必须能原地升级。
     每加一版就往 MIGRATIONS 末尾追加一个函数，输入是上一版的配置对象。 */
  var SCHEMA_VERSION = 2;
  var MIGRATIONS = [
    /* 0 → 1：早期配置没有版本号，但结构兼容，补上标记即可。 */
    function (c) { return c; },
    /* 1 → 2：修掉已经写坏的组员与姓名（[object Object]），名单统一成对象。
       已污染的老机器升级后会在这里被清洗一次，不需要老师重新分组。 */
    function (c) { return sanitizeConfig(c); }
  ];

  function configVersion() {
    var v = read(KEY.schema, 0);
    return (typeof v === "number" && v >= 0 && v === Math.floor(v)) ? v : 0;
  }

  function migrateConfig(raw, from) {
    var out = isPlain(raw) ? clone(raw) : {};
    for (var v = from; v < SCHEMA_VERSION; v++) {
      if (typeof MIGRATIONS[v] === "function") out = MIGRATIONS[v](out) || out;
    }
    return out;
  }

  function upgrade() {
    var from = configVersion();
    if (from >= SCHEMA_VERSION) return from;
    var raw = read(KEY.config, null);
    /* 坏成非对象的配置不覆盖，留着现场；版本号照样补上。 */
    if (isPlain(raw)) write(KEY.config, migrateConfig(raw, from));
    write(KEY.schema, SCHEMA_VERSION);
    return SCHEMA_VERSION;
  }

  /* 导入要么整份成功，要么一个字都不写。
     文件从别的电脑拷过来，可能只对了一半；写进去一半，
     屏上会变成谁都不是的班，比直接拒绝更难收拾。 */
  function importAll(obj) {
    if (!isPlain(obj)) return { ok: false, why: "文件不是有效的设置" };
    if (obj.format !== EXPORT_FORMAT) return { ok: false, why: "不是本程序导出的设置文件" };

    var importedVersion = 0;
    if ("schemaVersion" in obj) {
      importedVersion = obj.schemaVersion;
      if (typeof importedVersion !== "number" || importedVersion < 0
          || importedVersion !== Math.floor(importedVersion)) {
        return { ok: false, why: "设置里的「版本号」格式不对" };
      }
      if (importedVersion > SCHEMA_VERSION) {
        return { ok: false, why: "设置来自更新的版本（v" + importedVersion + "），请先升级本机再导入" };
      }
    }

    var plan = [];
    if ("texts" in obj) {
      if (!isPlain(obj.texts)) return { ok: false, why: "设置里的「文字」格式不对" };
      plan.push([KEY.texts, obj.texts]);
    }
    if ("overrides" in obj) {
      if (!isPlain(obj.overrides)) return { ok: false, why: "设置里的「临时调整」格式不对" };
      /* 临时调整里也存人（roles[].people / lessons[].teacher）。
         以前这里一句校验都没有：对象原样落库、原样套到当天数据上，
         靠大屏 personName 兜底才没露字——但那只是把症状推迟到显示层。 */
      plan.push([KEY.overrides, cleanOverrides(obj.overrides)]);
    }
    if ("config" in obj) {
      /* 先按版本迁一次，拿到的仍是「结构可能不完整」的对象。 */
      var c = migrateConfig(obj.config, importedVersion);
      if (!isPlain(c)) return { ok: false, why: "设置里的「班级配置」格式不对" };
      /* 顺序很重要：先清洗，再只查骨架。
         反过来的话，「组名是对象」这种 cleanGroupOne 明明能救的情况，
         会被 `typeof g.name !== "string"` 整份拒绝——程序自己导出的
         文件自己导不回来，就是这么来的。 */
      c = cleanConfig(c);
      if ("timetable" in c && (!isPlain(c.timetable) || !Array.isArray(c.timetable.blocks))) {
        return { ok: false, why: "设置里的「作息表」格式不对" };
      }
      if ("schedule" in c && (!isPlain(c.schedule) || !Array.isArray(c.schedule.entries))) {
        return { ok: false, why: "设置里的「课表」格式不对" };
      }
      /* 人群组只查骨架：元素长什么样已经由 cleanGroups 处理完了。 */
      if ("peopleGroups" in c && !Array.isArray(c.peopleGroups)) {
        return { ok: false, why: "设置里的「人群组」格式不对" };
      }
      plan.push([KEY.config, c]);
      plan.push([KEY.schema, SCHEMA_VERSION]);
    }
    if ("phrases" in obj) {
      if (!Array.isArray(obj.phrases)) return { ok: false, why: "设置里的「常用话术」格式不对" };
      plan.push([KEY.phrases, trimPhrases(obj.phrases)]);
    }
    if ("prefs" in obj) {
      if (!isPlain(obj.prefs)) return { ok: false, why: "设置里的「本机偏好」格式不对" };
      plan.push([KEY.prefs, obj.prefs]);
    }
    if (!plan.length) return { ok: false, why: "文件里没有可导入的内容" };

    /* 校验全过才落盘。写入失败（配额满）时 write 只在内存里兜底，
       这里不逐项报错，回读一次班级名足以判断是否真的进去了。 */
    plan.forEach(function (kv) { write(kv[0], kv[1]); });
    write(KEY.history, {});          // 撤销栈是旧配置下的快照，不能留

    if (root.Runtime && root.Runtime.reload) root.Runtime.reload();
    if (root.Screen && root.Screen.render) root.Screen.render();

    var meta = (obj.config && obj.config.meta) || {};
    var sch = (obj.config && obj.config.schedule) || {};
    return { ok: true, n: plan.length, klass: meta.klass || sch.class || "" };
  }

  upgrade();
  /* 把组员的旧 id 编码（"s01"）就地换成姓名编码（"name:张三"）：
     换一份名单，id 就全变了，老师的组会整片对不上。幂等——没有可转的就
     不写盘，所以不需要靠版本号触发一次。放在 upgrade 之后单独跑，
     因为升级只在版本落后时执行，而这台机器上可能早就是 v2 了。 */
  fixGroupKeys();

  var api = {
    KEY: KEY, dayKey: dayKey, clone: clone,
    allOverrides: allOverrides, getDayOverride: getDayOverride,
    patchDayOverride: patchDayOverride, clearDayOverride: clearDayOverride,
    applyOverrides: applyOverrides, undo: undo, canUndo: canUndo,
    rankStudents: rankStudents, markPicked: markPicked,
    normStudents: normStudents, personNameOf: personNameOf, peopleList: peopleList,
    memberIdOf: memberIdOf, sanitizeConfig: sanitizeConfig,
    cleanConfig: cleanConfig, cleanOverrides: cleanOverrides,
    cleanRolesDoc: cleanRolesDoc, cleanGroups: cleanGroups,
    recall: recall, remember: remember, allPhrases: allPhrases, removePhrase: removePhrase,
    findTimeWords: findTimeWords,
    texts: texts, patchTexts: patchTexts, resetTexts: resetTexts,
    textsLocal: textsLocal, setTextsLocal: setTextsLocal, setupSnapshot: setupSnapshot,
    config: config, patchConfig: patchConfig, resetConfig: resetConfig,
    reorderRoles: reorderRoles,
    peopleGroups: peopleGroups, saveGroup: saveGroup, deleteGroup: deleteGroup,
    upsertGroup: upsertGroup, removeGroup: removeGroup,
    fixGroupKeys: fixGroupKeys, auditPeople: auditPeople,
    schemaVersion: configVersion,
    exportAll: exportAll, importAll: importAll,
    makeChallenge: makeChallenge, lockState: lockState,
    recordFail: recordFail, resetFail: resetFail,
    prefs: prefs, setPref: setPref
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Store = api;
})(typeof window !== "undefined" ? window : globalThis);
