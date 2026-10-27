import { describe, it, expect } from "vitest";
import {
  availableModels,
  chipLabel,
  type OfferedModel,
} from "@/app/(dashboard)/dashboard/providers/[id]/availableModels";

const base = { addedIdentifiers: [] as string[], providerAlias: "acme" };

describe("availableModels", () => {
  it("splits free from paid", () => {
    const out = availableModels({
      ...base,
      suggested: [] as OfferedModel[],
      builtIn: [
        { id: "free-1", isFree: true },
        { id: "paid-1", isFree: false },
        { id: "unknown-flag" },
      ],
    });
    expect(out.free.map((m) => m.id)).toEqual(["free-1"]);
    // An absent flag is treated as paid, which is what the UI's `isFree !== true` did.
    expect(out.paid.map((m) => m.id)).toEqual(["paid-1", "unknown-flag"]);
    expect(out.total).toBe(3);
  });

  it("keeps the first occurrence so the API's live row wins", () => {
    const out = availableModels({
      ...base,
      suggested: [{ id: "m1", name: "from api", isFree: true, contextLength: 200000 }],
      builtIn: [{ id: "m1", name: "from catalog", isFree: false }],
    });
    expect(out.total).toBe(1);
    expect(out.free[0].name).toBe("from api");
    expect(out.free[0].contextLength).toBe(200000);
  });

  it("skips rows with no id rather than rendering an unclickable chip", () => {
    const out = availableModels({
      ...base,
      suggested: [{ id: "" }, {} as OfferedModel, { id: "real" }],
      builtIn: [],
    });
    expect(out.total).toBe(1);
    // No isFree flag means paid, which is the same rule the list used before.
    expect(out.paid[0].id).toBe("real");
  });

  it("drops a model already added under its bare id", () => {
    const out = availableModels({
      ...base,
      suggested: [],
      builtIn: [{ id: "m1" }, { id: "m2" }],
      addedIdentifiers: ["m1"],
    });
    expect(out.total).toBe(1);
  });

  it("drops a model already added under its aliased id", () => {
    // A model added through the alias path stores `alias/id`, a custom one stores the bare id.
    const out = availableModels({
      ...base,
      suggested: [],
      builtIn: [{ id: "m1" }, { id: "m2" }],
      addedIdentifiers: ["acme/m1"],
    });
    expect(out.paid.map((m) => m.id)).toEqual(["m2"]);
  });

  it("counts the extra free set", () => {
    const out = availableModels({
      ...base,
      suggested: [],
      builtIn: [],
      extraFree: [{ id: "kilo-1", isFree: true }],
    });
    expect(out.free.map((m) => m.id)).toEqual(["kilo-1"]);
  });

  it("returns nothing for a provider with no models", () => {
    const out = availableModels({ ...base, suggested: [], builtIn: [] });
    expect(out).toEqual({ free: [], paid: [], total: 0 });
  });

  it("matches the expression it replaced", () => {
    // The original, copied from the page before extraction.
    const legacy = (
      suggestedModels: OfferedModel[],
      models: { id: string; name?: string; isFree?: boolean }[],
      kiloFreeModels: { id: string; name?: string }[],
      modelAliases: Record<string, string>,
      customModelRows: { fullModel: string }[],
      providerStorageAlias: string
    ) => {
      const addedFullModels = new Set([
        ...Object.values(modelAliases),
        ...customModelRows.map((model) => model.fullModel),
      ]);
      const combinedAvailable = [
        ...suggestedModels,
        ...models.map((m) => ({ id: m.id, name: m.name || m.id, isFree: m.isFree })),
        ...kiloFreeModels.map((m) => ({ id: m.id, name: m.name || m.id, isFree: true })),
      ];
      const seenIds = new Set<string>();
      const uniqueAvailable: OfferedModel[] = [];
      for (const m of combinedAvailable) {
        if (!m?.id || seenIds.has(m.id)) continue;
        seenIds.add(m.id);
        uniqueAvailable.push(m);
      }
      const notAdded = uniqueAvailable.filter(
        (m) => !addedFullModels.has(`${providerStorageAlias}/${m.id}`) && !addedFullModels.has(m.id)
      );
      return {
        free: notAdded.filter((m) => m.isFree === true).map((m) => m.id),
        paid: notAdded.filter((m) => m.isFree !== true).map((m) => m.id),
      };
    };

    const cases = [
      { suggested: [{ id: "a", isFree: true }], models: [{ id: "b" }], kilo: [{ id: "c" }], aliases: {}, custom: [] },
      { suggested: [], models: [{ id: "a" }, { id: "a" }], kilo: [], aliases: {}, custom: [] },
      { suggested: [{ id: "a" }], models: [], kilo: [], aliases: { a: "x/a" }, custom: [] },
      { suggested: [{ id: "a" }], models: [], kilo: [], aliases: {}, custom: [{ fullModel: "prov/a" }] },
      { suggested: [{ id: "" } as OfferedModel, { id: "z", isFree: true }], models: [], kilo: [], aliases: {}, custom: [] },
      { suggested: [], models: [], kilo: [], aliases: {}, custom: [] },
    ];

    for (const c of cases) {
      const expected = legacy(c.suggested, c.models, c.kilo, c.aliases, c.custom, "prov");
      const actual = availableModels({
        suggested: c.suggested,
        builtIn: c.models,
        extraFree: c.kilo.map((m) => ({ ...m, isFree: true })),
        addedIdentifiers: [...Object.values(c.aliases), ...c.custom.map((r) => r.fullModel)],
        providerAlias: "prov",
      });
      expect({ free: actual.free.map((m) => m.id), paid: actual.paid.map((m) => m.id) }).toEqual(expected);
    }
  });

  it("names the catalog rows the same way the page did", () => {
    // builtIn rows were mapped to `{ id, name: name || id, isFree }` inline.
    const out = availableModels({
      ...base,
      suggested: [],
      builtIn: [
        { id: "no-name", isFree: true },
        { id: "with-name", name: "Nice Name", isFree: true },
      ].map((m) => ({ ...m, name: m.name || m.id })),
    });
    expect(out.free.map((m) => m.name)).toEqual(["no-name", "Nice Name"]);
  });
});

describe("chipLabel", () => {
  it("shows the last segment of a namespaced id", () => {
    expect(chipLabel("@cf/vendor/model")).toBe("model");
    expect(chipLabel("vendor/model")).toBe("model");
  });

  it("leaves a bare id alone", () => {
    expect(chipLabel("gpt-4")).toBe("gpt-4");
  });

  it("returns empty for empty input rather than undefined", () => {
    expect(chipLabel("")).toBe("");
  });

  it("matches the expression it replaced", () => {
    const legacy = (id: string) => id.split("/").pop();
    for (const id of ["@cf/vendor/model", "a/b", "bare", ""]) {
      expect(chipLabel(id)).toBe(legacy(id));
    }
  });
});
