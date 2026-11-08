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
    all[key] = Object.assign({}, cur, patch);
    all[key].updatedAt = new Date().toISOString();
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
        if (L.teacher !== undefined) b.teacher = L.teacher;
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
        if (r.people) {
          d.people = r.people.slice();
          d.status = r.people.length ? "ok" : "unknown";
          d.reason = d.status === "ok" ? null : "no-people";
        }
        if (r.at) d.at = r.at;
        d.overridden = true;
      });
    }

    return out;
  }

  /* ---------- 名单检索 ---------- */
  /* 排序：本场景相关的人 → 最近点过 → 名单顺序。
     这是 2.17 定的规则，越靠前的越容易被点到。 */
  function rankStudents(list, q, related, limit) {
    q = (q || "").trim();
    related = related || [];
    limit = limit || 8;
    if (!list) return [];

    var pool = list.filter(function (s) {
      if (s.active === false) return false;
      if (!q) return true;
      return s.name.indexOf(q) >= 0 || (s.alias && s.alias.indexOf(q) >= 0);
    });

    var picked = read(KEY.picked, {});
    var idx = {};
    list.forEach(function (s, i) { idx[s.name] = i; });

    pool.sort(function (a, b) {
      var ra = related.indexOf(a.name) >= 0 ? 0 : 1;
      var rb = related.indexOf(b.name) >= 0 ? 0 : 1;
      if (ra !== rb) return ra - rb;
      var ta = picked[a.name] || 0, tb = picked[b.name] || 0;
      if (ta !== tb) return tb - ta;
      return (idx[a.name] || 0) - (idx[b.name] || 0);
    });

    return pool.slice(0, limit);
  }

  function markPicked(name) {
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
  function makeChallenge() {
    var a = 102 + Math.floor(Math.random() * 888);  /* 三位数 */
    var b = 2 + Math.floor(Math.random() * 8);      /* 一位数 2-9 */
    return { a: a, b: b, answer: a * b, text: a + " × " + b };
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
  function texts() {
    var local = read(KEY.texts, null);
    if (local && Object.keys(local).length) return local;
    var baked = root.RHYTHM_DATA && root.RHYTHM_DATA.texts;
    return (baked && typeof baked === "object") ? baked : (local || {});
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
                       "content", "noon", "calendar", "students"];

  function config() {
    var c = read(KEY.config, null);
    if (!c || typeof c !== "object") return {};
    var out = {};
    CONFIG_BLOCKS.forEach(function (k) {
      if (c[k] !== undefined && c[k] !== null) out[k] = c[k];
    });
    return out;
  }

  function patchConfig(patch) {
    var cur = config();
    Object.keys(patch || {}).forEach(function (k) {
      if (CONFIG_BLOCKS.indexOf(k) < 0) return;
      if (patch[k] === null) delete cur[k];
      else if (patch[k] !== undefined) cur[k] = patch[k];
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

  /* ---------- 偏好 ---------- */
  function prefs() { return read(KEY.prefs, { cdMode: "auto", reduce: false }); }
  function setPref(k, v) {
    var p = prefs(); p[k] = v; write(KEY.prefs, p); return p;
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
    /* 名册修正只存在本机 config 里，Runtime 不认识 students，
       不单独并进来，换机器备份时老师的修正就丢了。 */
    var local = read(KEY.config, {});
    if (local && local.students) out.students = local.students;
    return {
      format: EXPORT_FORMAT,
      savedAt: new Date().toISOString(),
      texts: read(KEY.texts, {}) || {},
      overrides: read(KEY.overrides, {}) || {},
      config: out,
      phrases: allPhrases(),
      prefs: prefs()
    };
  }

  function isPlain(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  /* 导入要么整份成功，要么一个字都不写。
     文件从别的电脑拷过来，可能只对了一半；写进去一半，
     屏上会变成谁都不是的班，比直接拒绝更难收拾。 */
  function importAll(obj) {
    if (!isPlain(obj)) return { ok: false, why: "文件不是有效的设置" };
    if (obj.format !== EXPORT_FORMAT) return { ok: false, why: "不是本程序导出的设置文件" };

    var plan = [];
    if ("texts" in obj) {
      if (!isPlain(obj.texts)) return { ok: false, why: "设置里的「文字」格式不对" };
      plan.push([KEY.texts, obj.texts]);
    }
    if ("overrides" in obj) {
      if (!isPlain(obj.overrides)) return { ok: false, why: "设置里的「临时调整」格式不对" };
      plan.push([KEY.overrides, obj.overrides]);
    }
    if ("config" in obj) {
      var c = obj.config;
      if (!isPlain(c)) return { ok: false, why: "设置里的「班级配置」格式不对" };
      if ("timetable" in c && (!isPlain(c.timetable) || !Array.isArray(c.timetable.blocks))) {
        return { ok: false, why: "设置里的「作息表」格式不对" };
      }
      if ("schedule" in c && (!isPlain(c.schedule) || !Array.isArray(c.schedule.entries))) {
        return { ok: false, why: "设置里的「课表」格式不对" };
      }
      plan.push([KEY.config, c]);
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

  var api = {
    KEY: KEY, dayKey: dayKey, clone: clone,
    allOverrides: allOverrides, getDayOverride: getDayOverride,
    patchDayOverride: patchDayOverride, clearDayOverride: clearDayOverride,
    applyOverrides: applyOverrides, undo: undo, canUndo: canUndo,
    rankStudents: rankStudents, markPicked: markPicked,
    recall: recall, remember: remember, allPhrases: allPhrases, removePhrase: removePhrase,
    findTimeWords: findTimeWords,
    texts: texts, patchTexts: patchTexts, resetTexts: resetTexts,
    textsLocal: textsLocal, setTextsLocal: setTextsLocal, setupSnapshot: setupSnapshot,
    config: config, patchConfig: patchConfig, resetConfig: resetConfig,
    reorderRoles: reorderRoles,
    exportAll: exportAll, importAll: importAll,
    makeChallenge: makeChallenge, lockState: lockState,
    recordFail: recordFail, resetFail: resetFail,
    prefs: prefs, setPref: setPref
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Store = api;
})(typeof window !== "undefined" ? window : globalThis);
