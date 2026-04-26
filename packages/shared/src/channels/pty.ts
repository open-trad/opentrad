// PTY domain IPC channels(M1 #20 落地)。
// spawn / write / resize / kill:renderer → main RPC;data / exit:main → renderer push。

export const PtyChannels = {
  PtySpawn: "pty:spawn",
  PtyWrite: "pty:write",
  PtyResize: "pty:resize",
  PtyKill: "pty:kill",
  PtyData: "pty:data",
  PtyExit: "pty:exit",
} as const;
