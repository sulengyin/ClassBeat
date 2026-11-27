/* 版本号的唯一定义处。
   打包时按 --version 与 git 提交号重写下面两行（classbeat-tools stage 改 BUILD，
   single 两个都写），生成到发布包里；其它文件不要再写死版本号，服务端也从这里读。 */
(function (root) {
  "use strict";

  var VERSION = "0.5.18";
  var BUILD = "dev";

  root.AppVersion = {
    version: VERSION,
    build: BUILD,
    /* 界面上用的短文案：v0.1.0 · a1b2c3d */
    text: function () {
      return "v" + VERSION + (BUILD && BUILD !== "dev" ? " · " + BUILD : "");
    }
  };
})(typeof window !== "undefined" ? window : this);
