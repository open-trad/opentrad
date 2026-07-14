import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

const MAX_WORKSPACE_PATH_LENGTH = 4_096;

export class WorkspaceRootError extends Error {
  readonly code = "WORKSPACE_ROOT_INVALID";

  constructor() {
    super("Selected workspace is not an accessible directory");
    this.name = "WorkspaceRootError";
  }
}

/** Canonicalize and revalidate a renderer-selected workspace in the main process. */
export async function validateWorkspaceRoot(candidate: unknown): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (
      typeof candidate !== "string" ||
      candidate.length === 0 ||
      candidate.length > MAX_WORKSPACE_PATH_LENGTH ||
      candidate.includes("\0") ||
      !isAbsolute(candidate)
    ) {
      throw new WorkspaceRootError();
    }
    const canonical = await realpath(candidate);
    if (!isAbsolute(canonical) || canonical.length > MAX_WORKSPACE_PATH_LENGTH) {
      throw new WorkspaceRootError();
    }
    handle = await open(
      canonical,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const metadata = await handle.stat();
    if (!metadata.isDirectory()) throw new WorkspaceRootError();
    return canonical;
  } catch (cause) {
    if (cause instanceof WorkspaceRootError) throw cause;
    throw new WorkspaceRootError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
