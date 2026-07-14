import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateWorkspaceRoot, WorkspaceRootError } from "../src/main/services/workspace-root";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("validateWorkspaceRoot", () => {
  it("returns the canonical directory after a main-process file descriptor check", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const link = join(root, "selected-link");
    await mkdir(workspace);
    await symlink(workspace, link);

    await expect(validateWorkspaceRoot(link)).resolves.toBe(await realpath(workspace));
  });

  it("rejects relative, missing, file and NUL paths with a fixed error", async () => {
    const root = await temporaryRoot();
    const file = join(root, "file.txt");
    await writeFile(file, "not a workspace");

    for (const value of ["relative", join(root, "missing"), file, `${root}\0suffix`, null]) {
      const error = await validateWorkspaceRoot(value).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(WorkspaceRootError);
      expect(error).toMatchObject({
        code: "WORKSPACE_ROOT_INVALID",
        message: "Selected workspace is not an accessible directory",
      });
      expect(JSON.stringify(error)).not.toContain(String(value));
    }
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opentrad-workspace-"));
  roots.push(root);
  return root;
}
