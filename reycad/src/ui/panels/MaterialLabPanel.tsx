import { useEffect, useMemo, useRef, useState } from "react";
import type { MaterialDef } from "../../engine/scenegraph/types";
import engineApi from "../../engine/api/engineApi";
import { useEditorStore } from "../../editor/state/editorStore";
import { ColorPicker } from "../components/ColorPicker";
import { SliderRow } from "../components/SliderRow";

const DEFAULT_PBR: NonNullable<MaterialDef["pbr"]> = {
  metalness: 0.2,
  roughness: 0.6,
  baseColor: "#cccccc",
  emissiveColor: "#000000",
  emissiveIntensity: 0,
  transmission: 0,
  ior: 1.45,
  baseColorMapId: undefined,
  normalMapId: undefined,
  aoMapId: undefined,
  roughnessMapId: undefined,
  metalnessMapId: undefined,
  emissiveMapId: undefined
};

type PbrMapKey = "baseColorMapId" | "normalMapId" | "aoMapId" | "roughnessMapId" | "metalnessMapId" | "emissiveMapId";

const pbrMapFields: Array<{ key: PbrMapKey; label: string }> = [
  { key: "baseColorMapId", label: "Base Map ID" },
  { key: "normalMapId", label: "Normal Map ID" },
  { key: "aoMapId", label: "AO Map ID" },
  { key: "roughnessMapId", label: "Roughness Map ID" },
  { key: "metalnessMapId", label: "Metalness Map ID" },
  { key: "emissiveMapId", label: "Emissive Map ID" }
];

function normalizeImportedPbr(raw: unknown): NonNullable<MaterialDef["pbr"]> {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_PBR };
  }

  const value = raw as Partial<NonNullable<MaterialDef["pbr"]>>;
  const mapOrUndefined = (next: string | undefined): string | undefined => {
    if (typeof next !== "string") {
      return undefined;
    }
    const trimmed = next.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  return {
    metalness: typeof value.metalness === "number" ? value.metalness : DEFAULT_PBR.metalness,
    roughness: typeof value.roughness === "number" ? value.roughness : DEFAULT_PBR.roughness,
    baseColor: typeof value.baseColor === "string" ? value.baseColor : DEFAULT_PBR.baseColor,
    emissiveColor: typeof value.emissiveColor === "string" ? value.emissiveColor : DEFAULT_PBR.emissiveColor,
    emissiveIntensity: typeof value.emissiveIntensity === "number" ? value.emissiveIntensity : DEFAULT_PBR.emissiveIntensity,
    transmission: typeof value.transmission === "number" ? value.transmission : DEFAULT_PBR.transmission,
    ior: typeof value.ior === "number" ? value.ior : DEFAULT_PBR.ior,
    baseColorMapId: mapOrUndefined(value.baseColorMapId),
    normalMapId: mapOrUndefined(value.normalMapId),
    aoMapId: mapOrUndefined(value.aoMapId),
    roughnessMapId: mapOrUndefined(value.roughnessMapId),
    metalnessMapId: mapOrUndefined(value.metalnessMapId),
    emissiveMapId: mapOrUndefined(value.emissiveMapId)
  };
}

export default function MaterialLabPanel(): JSX.Element {
  const selection = useEditorStore((state) => state.data.selection);
  const project = useEditorStore((state) => state.data.project);
  const addLog = useEditorStore((state) => state.addLog);
  const [query, setQuery] = useState("");
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const materials = useMemo(
    () => Object.values(project.materials).filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase())),
    [project.materials, query]
  );

  const selectedMaterial = useMemo(
    () => (selectedMaterialId ? materials.find((item) => item.id === selectedMaterialId) : materials[0]),
    [materials, selectedMaterialId]
  );

  useEffect(() => {
    if (!selectedMaterial && materials.length > 0) {
      setSelectedMaterialId(materials[0].id);
    }
  }, [materials, selectedMaterial]);

  useEffect(() => {
    setNameDraft(selectedMaterial?.name ?? "");
  }, [selectedMaterial?.id, selectedMaterial?.name]);

  const selectedPreviewColor = selectedMaterial?.kind === "solidColor" ? selectedMaterial.color ?? "#cccccc" : selectedMaterial?.pbr?.baseColor ?? "#cccccc";

  const updatePbr = (patch: Partial<NonNullable<MaterialDef["pbr"]>>): void => {
    if (!selectedMaterial || selectedMaterial.kind !== "pbr") {
      return;
    }
    engineApi.updateMaterial(selectedMaterial.id, {
      pbr: {
        ...DEFAULT_PBR,
        ...(selectedMaterial.pbr ?? {}),
        ...patch
      }
    });
  };

  const exportSelectedMaterial = (): void => {
    if (!selectedMaterial) {
      return;
    }
    const content = JSON.stringify(selectedMaterial, null, 2);
    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${selectedMaterial.name.replace(/\s+/g, "_").toLowerCase() || "material"}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const importMaterialsFromFile = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    try {
      const raw = JSON.parse(await file.text()) as unknown;
      const entries = Array.isArray(raw) ? raw : [raw];
      let imported = 0;
      let created = 0;
      let updated = 0;

      for (const entry of entries) {
        if (!entry || typeof entry !== "object") {
          continue;
        }

        const value = entry as Partial<MaterialDef>;
        if (value.kind !== "solidColor" && value.kind !== "pbr") {
          continue;
        }

        const seed: Partial<MaterialDef> = {
          name: typeof value.name === "string" ? value.name : undefined
        };

        if (value.kind === "solidColor") {
          seed.kind = "solidColor";
          seed.color = typeof value.color === "string" ? value.color : "#cccccc";
        } else {
          seed.kind = "pbr";
          seed.pbr = normalizeImportedPbr(value.pbr);
        }

        const existingId = typeof value.id === "string" ? value.id : undefined;
        if (existingId && project.materials[existingId]) {
          engineApi.updateMaterial(existingId, seed);
          setSelectedMaterialId(existingId);
          updated += 1;
        } else {
          const id = engineApi.createMaterial(value.kind, seed);
          setSelectedMaterialId(id);
          created += 1;
        }
        imported += 1;
      }

      addLog(`[materials] imported=${imported} created=${created} updated=${updated}`);
    } catch {
      addLog("[materials] import failed: invalid JSON");
    }
  };

  return (
    <div className="panel stack-sm">
      <div className="panel-head">
        <h3>MaterialLab</h3>
        <span className="pill">{materials.length} mats</span>
      </div>

      <label className="field">
        <span>Search</span>
        <input className="input" placeholder="material name" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>

      <div className="row wrap">
        <button
          className="btn btn-primary"
          onClick={() => {
            const id = engineApi.createMaterial("solidColor");
            setSelectedMaterialId(id);
          }}
          type="button"
        >
          New Color
        </button>
        <button
          className="btn btn-primary"
          onClick={() => {
            const id = engineApi.createMaterial("pbr");
            setSelectedMaterialId(id);
          }}
          type="button"
        >
          New PBR
        </button>
        <button
          className="btn"
          disabled={!selectedMaterial || selection.length === 0}
          onClick={() => selectedMaterial && engineApi.setNodeMaterialBatch(selection, selectedMaterial.id)}
          type="button"
        >
          Apply Selection
        </button>
      </div>

      <div className="row wrap">
        <button className="btn" disabled={!selectedMaterial} onClick={exportSelectedMaterial} type="button">
          Export JSON
        </button>
        <button className="btn" onClick={() => importInputRef.current?.click()} type="button">
          Import JSON
        </button>
        <button
          className="btn btn-danger"
          disabled={!selectedMaterial || materials.length <= 1}
          onClick={() => {
            if (!selectedMaterial) {
              return;
            }
            engineApi.deleteMaterial(selectedMaterial.id);
            setSelectedMaterialId(null);
          }}
          type="button"
        >
          Delete
        </button>
      </div>
      <input ref={importInputRef} accept="application/json,.json" onChange={importMaterialsFromFile} style={{ display: "none" }} type="file" />

      <ul className="list">
        {materials.map((material) => (
          <li key={material.id}>
            <button
              className={`list-item ${selectedMaterial?.id === material.id ? "selected" : ""}`}
              onClick={() => setSelectedMaterialId(material.id)}
              type="button"
            >
              <span>{material.name}</span>
              <span className="mono">{material.kind}</span>
            </button>
          </li>
        ))}
      </ul>

      {selectedMaterial && (
        <div className="stack-sm">
          <label className="field">
            <span>Name</span>
            <input
              className="input"
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              onBlur={() => {
                const trimmed = nameDraft.trim();
                if (trimmed.length > 0 && trimmed !== selectedMaterial.name) {
                  engineApi.updateMaterial(selectedMaterial.id, { name: trimmed });
                }
              }}
            />
          </label>

          <div className="perm-card">
            <span className="mono">Preview</span>
            <div
              style={{
                width: "100%",
                height: "54px",
                borderRadius: "10px",
                marginTop: "6px",
                border: "1px solid #304357",
                background: `linear-gradient(135deg, ${selectedPreviewColor}, #0f151d)`
              }}
            />
          </div>

          {selectedMaterial.kind === "solidColor" && (
            <ColorPicker
              label="Color"
              value={selectedMaterial.color ?? "#cccccc"}
              onChange={(value) => {
                engineApi.updateMaterial(selectedMaterial.id, { color: value });
              }}
            />
          )}

          {selectedMaterial.kind === "pbr" && (
            <>
              <ColorPicker label="Base Color" value={selectedMaterial.pbr?.baseColor ?? DEFAULT_PBR.baseColor} onChange={(value) => updatePbr({ baseColor: value })} />
              <ColorPicker
                label="Emissive Color"
                value={selectedMaterial.pbr?.emissiveColor ?? DEFAULT_PBR.emissiveColor ?? "#000000"}
                onChange={(value) => updatePbr({ emissiveColor: value })}
              />
              <SliderRow label="Metalness" min={0} max={1} step={0.01} value={selectedMaterial.pbr?.metalness ?? DEFAULT_PBR.metalness} onChange={(value) => updatePbr({ metalness: value })} />
              <SliderRow label="Roughness" min={0} max={1} step={0.01} value={selectedMaterial.pbr?.roughness ?? DEFAULT_PBR.roughness} onChange={(value) => updatePbr({ roughness: value })} />
              <SliderRow
                label="Emissive Intensity"
                min={0}
                max={5}
                step={0.01}
                value={selectedMaterial.pbr?.emissiveIntensity ?? DEFAULT_PBR.emissiveIntensity ?? 0}
                onChange={(value) => updatePbr({ emissiveIntensity: value })}
              />
              <SliderRow
                label="Transmission"
                min={0}
                max={1}
                step={0.01}
                value={selectedMaterial.pbr?.transmission ?? DEFAULT_PBR.transmission ?? 0}
                onChange={(value) => updatePbr({ transmission: value })}
              />
              <SliderRow label="IOR" min={1} max={2.5} step={0.01} value={selectedMaterial.pbr?.ior ?? DEFAULT_PBR.ior ?? 1.45} onChange={(value) => updatePbr({ ior: value })} />

              {pbrMapFields.map((field) => (
                <label className="field" key={field.key}>
                  <span>{field.label}</span>
                  <input
                    className="input mono"
                    placeholder="asset id (optional)"
                    value={selectedMaterial.pbr?.[field.key] ?? ""}
                    onChange={(event) => updatePbr({ [field.key]: event.target.value.trim() || undefined })}
                  />
                </label>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
