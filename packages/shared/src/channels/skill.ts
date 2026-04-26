// Skill domain IPC channels(M1 #30 Part C TD-002 拆分)。
// SkillList / SkillInstall:builtin + user skill 加载;InstalledSkillList:db 视图。

export const SkillChannels = {
  SkillList: "skill:list",
  SkillInstall: "skill:install",
  InstalledSkillList: "installed-skill:list",
} as const;
