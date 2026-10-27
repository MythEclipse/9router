// A combo's access grant is identified by NAME, not id. Renaming a combo must
// carry every restricted key's grant across in the same transaction, or the
// rename silently revokes access: the key keeps a grant on a name that no longer
// resolves and the operator sees "403" with nothing obviously changed.
//
// deleteCombo already revoked orphan grants; the rename direction was missing.

import { describe, it, expect, beforeEach } from "vitest";
import { getAdapter } from "../../src/lib/db/driver.js";
import { createCombo, updateCombo, deleteCombo } from "../../src/lib/db/repos/combosRepo.js";
import { createApiKey } from "../../src/lib/db/repos/apiKeysRepo.js";
import { normalizeAllowList } from "../../src/shared/utils/keyAccess.js";

async function grantTo(keyId: string, allow: string[]) {
  const db = await getAdapter();
  db.run(`UPDATE apiKeys SET accessRestricted = 1, accessAllow = ? WHERE id = ?`, [
    JSON.stringify(allow),
    keyId,
  ]);
}

async function allowOf(keyId: string): Promise<string[]> {
  const db = await getAdapter();
  const row = db.get<{ accessAllow?: string | null }>(
    `SELECT accessAllow FROM apiKeys WHERE id = ?`,
    [keyId]
  );
  return normalizeAllowList(JSON.parse(row?.accessAllow || "[]"));
}

async function removeComboByName(name: string) {
  const db = await getAdapter();
  const row = db.get<{ id: string }>(`SELECT id FROM combos WHERE name = ?`, [name]);
  if (row) await deleteCombo(row.id);
}

describe("combo rename carries restricted-key grants", () => {
  let keyId: string;

  beforeEach(async () => {
    await removeComboByName("old-name");
    await removeComboByName("new-name");
    const key = await createApiKey(`rename-key-${Date.now()}`, "machine-test");
    keyId = key.id;
  });

  it("rewrites the grant to the new name", async () => {
    const combo = await createCombo({ name: "old-name", models: ["a/b"] });
    await grantTo(keyId, ["old-name", "other/model"]);

    await updateCombo(combo.id, { name: "new-name" });

    const allow = await allowOf(keyId);
    expect(allow).toContain("new-name");
    expect(allow).not.toContain("old-name");
    // Unrelated grants must survive untouched.
    expect(allow).toContain("other/model");
  });

  it("matches the grant case-insensitively", async () => {
    const combo = await createCombo({ name: "old-name", models: ["a/b"] });
    await grantTo(keyId, ["OLD-Name"]);

    await updateCombo(combo.id, { name: "new-name" });

    expect(await allowOf(keyId)).toEqual(["new-name"]);
  });

  it("leaves grants alone when the name does not change", async () => {
    const combo = await createCombo({ name: "old-name", models: ["a/b"] });
    await grantTo(keyId, ["old-name"]);

    await updateCombo(combo.id, { models: ["a/b", "c/d"] });

    expect(await allowOf(keyId)).toEqual(["old-name"]);
  });

  it("does not touch unrestricted keys", async () => {
    const combo = await createCombo({ name: "old-name", models: ["a/b"] });
    const db = await getAdapter();
    db.run(
      `UPDATE apiKeys SET accessRestricted = 0, accessAllow = '["old-name"]' WHERE id = ?`,
      [keyId]
    );

    await updateCombo(combo.id, { name: "new-name" });

    expect(await allowOf(keyId)).toEqual(["old-name"]);
  });
});
