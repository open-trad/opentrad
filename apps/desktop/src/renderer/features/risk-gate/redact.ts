// 参数脱敏(M1 #28 issue body 要求):URL / 邮箱 / 文件路径中的用户名替换为
// `<REDACTED>` **显示给用户**,但传后端时是原值。
//
// 用 RegExp 简单脱敏(M1 简化,M2 视情况升级到 AST 级 redactor)。

const EMAIL_REGEX = /([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const HOMEDIR_REGEX = /\/(?:Users|home)\/([^/\s"'\\]+)/g;
const URL_USER_REGEX = /(https?:\/\/[^/]*?)([A-Za-z0-9._-]+):([^@]+)@/g; // 含 user:pass@ 的 URL

export function redactString(input: string): string {
  return input
    .replace(EMAIL_REGEX, "$1***@$2")
    .replace(HOMEDIR_REGEX, (_, _name) => `/<HOME>/<REDACTED>`)
    .replace(URL_USER_REGEX, "$1<REDACTED>:<REDACTED>@");
}

// 递归脱敏 unknown(常见为 object / array / string)。其他类型原样返回。
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactValue(v);
    }
    return out;
  }
  return value;
}

// 把 params unknown 序列化成 UI 友好的 pretty JSON(已脱敏)。
export function paramsToDisplayString(params: unknown): string {
  try {
    return JSON.stringify(redactValue(params), null, 2);
  } catch {
    return "(无法序列化)";
  }
}
