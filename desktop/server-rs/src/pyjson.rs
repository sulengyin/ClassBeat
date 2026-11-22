//! Python `json.dumps` 的输出格式复刻。
//!
//! 为什么不用 `serde_json::to_string`：Python 默认分隔符是 `", "` 和 `": "`，
//! 输出 `{"ok": true, "port": 8765}`；serde_json 是 `{"ok":true,"port":8765}`。
//! 字节级验收（docs/11）要求两边完全一致，所以这里按 Python 的规则自己写。
//!
//! 覆盖 Python 的三个常用形态：
//!   - `dumps(v)`                      默认分隔符
//!   - `dumps_indent(v, 2)`            清单文件（indent=2）
//!   - `dumps_sorted_compact(v)`       落盘快照（sort_keys=True, separators=(",",":")）

use serde_json::{Map, Value};

/// 按 Python 的 ESCAPE 表转义字符串（ensure_ascii=False：非 ASCII 原样输出）。
fn write_str(s: &str, out: &mut String) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Python `repr(float)` 与 Rust `Display` 的差别只有一处会影响我们：
/// 整数值的 float 在 Python 里带 `.0`（`1.0`），Rust 打成 `1`。
fn write_number(n: &serde_json::Number, out: &mut String) {
    if let Some(i) = n.as_i64() {
        out.push_str(&i.to_string());
    } else if let Some(u) = n.as_u64() {
        out.push_str(&u.to_string());
    } else {
        let f = n.as_f64().unwrap_or(0.0);
        if f.is_finite() && f.fract() == 0.0 && f.abs() < 1e16 {
            out.push_str(&format!("{:.1}", f));
        } else {
            out.push_str(&format!("{}", f));
        }
    }
}

fn write_value(v: &Value, out: &mut String, indent: Option<usize>, level: usize) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => write_number(n, out),
        Value::String(s) => write_str(s, out),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                    if indent.is_some() {
                        out.push('\n');
                    } else {
                        out.push(' ');
                    }
                } else if let Some(n) = indent {
                    out.push('\n');
                    out.push_str(&" ".repeat(n * (level + 1)));
                }
                if indent.is_some() && i > 0 {
                    out.push_str(&" ".repeat(indent.unwrap() * (level + 1)));
                }
                write_value(item, out, indent, level + 1);
            }
            if let Some(n) = indent {
                out.push('\n');
                out.push_str(&" ".repeat(n * level));
            }
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, (k, val)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                    if indent.is_some() {
                        out.push('\n');
                    } else {
                        out.push(' ');
                    }
                } else if let Some(n) = indent {
                    out.push('\n');
                    out.push_str(&" ".repeat(n * (level + 1)));
                }
                if indent.is_some() && i > 0 {
                    out.push_str(&" ".repeat(indent.unwrap() * (level + 1)));
                }
                write_str(k, out);
                out.push(':');
                out.push(' ');
                write_value(val, out, indent, level + 1);
            }
            if let Some(n) = indent {
                out.push('\n');
                out.push_str(&" ".repeat(n * level));
            }
            out.push('}');
        }
    }
}

/// `json.dumps(obj, ensure_ascii=False)`
pub fn dumps(v: &Value) -> String {
    let mut out = String::with_capacity(256);
    write_value(v, &mut out, None, 0);
    out
}

/// `json.dumps(obj, ensure_ascii=False, indent=n)`
pub fn dumps_indent(v: &Value, n: usize) -> String {
    let mut out = String::with_capacity(512);
    write_value(v, &mut out, Some(n), 0);
    out
}

/// `json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))`
pub fn dumps_sorted_compact(v: &Value) -> String {
    fn sorted(v: &Value) -> Value {
        match v {
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                let mut out = Map::new();
                for k in keys {
                    out.insert(k.clone(), sorted(&map[k]));
                }
                Value::Object(out)
            }
            Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
            other => other.clone(),
        }
    }
    let mut out = String::with_capacity(256);
    write_compact(&sorted(v), &mut out);
    out
}

fn write_compact(v: &Value, out: &mut String) {
    match v {
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_compact(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (i, (k, val)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_str(k, out);
                out.push(':');
                write_compact(val, out);
            }
            out.push('}');
        }
        other => write_value(other, out, None, 0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matches_python_default_separators() {
        let v = json!({"ok": true, "app": "classbeat", "port": 8765});
        assert_eq!(dumps(&v), r#"{"ok": true, "app": "classbeat", "port": 8765}"#);
    }

    #[test]
    fn keeps_chinese_raw_and_escapes_controls() {
        let v = json!({"k": "五（1）班\n\u{1}"});
        assert_eq!(dumps(&v), "{\"k\": \"五（1）班\\n\\u0001\"}");
    }

    #[test]
    fn nested_indent_like_manifest() {
        let v = json!({"a": [1, 2], "b": {"c": true}});
        assert_eq!(
            dumps_indent(&v, 2),
            "{\n  \"a\": [\n    1,\n    2\n  ],\n  \"b\": {\n    \"c\": true\n  }\n}"
        );
    }

    #[test]
    fn sorts_keys_when_asked() {
        let v = json!({"b": 2, "a": 1});
        assert_eq!(dumps_sorted_compact(&v), r#"{"a":1,"b":2}"#);
    }

    #[test]
    fn integer_valued_float_gets_dot_zero() {
        let v = json!({"p": 1.0});
        assert_eq!(dumps(&v), r#"{"p": 1.0}"#);
    }
}
