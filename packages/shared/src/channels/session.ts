// Session domain IPC channels(M1 #30 Part C TD-002 拆分)。
// list / get / delete:sessions 表 CRUD;resume:M1 #29 D-M1-7 历史回放(read-only)。

export const SessionChannels = {
  SessionList: "session:list",
  SessionGet: "session:get",
  SessionDelete: "session:delete",
  SessionResume: "session:resume",
} as const;
