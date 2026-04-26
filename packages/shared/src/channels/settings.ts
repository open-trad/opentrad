// Settings domain IPC channels(M1 #30 Part C TD-002 拆分)。
// settings 表 key-value JSON 读写。

export const SettingsChannels = {
  SettingsGet: "settings:get",
  SettingsSet: "settings:set",
} as const;
