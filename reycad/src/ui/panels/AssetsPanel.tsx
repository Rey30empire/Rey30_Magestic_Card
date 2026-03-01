import { useEffect, useMemo, useState } from "react";
import engineApi from "../../engine/api/engineApi";
import { SearchBar } from "../components/SearchBar";
import { useEditorStore } from "../../editor/state/editorStore";
import { ColorPicker } from "../components/ColorPicker";
import { SliderRow } from "../components/SliderRow";

type Tab = "templates" | "materials" | "primitives";

const primitives = ["box", "cylinder", "sphere", "cone", "text"] as const;

export default function AssetsPanel(): JSX.Element {
  const [tab, setTab] = useState<Tab>("templates");
  const [query, setQuery] = useState("");
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(null);
  const [materialNameDraft, setMaterialNameDraft] = useState("");
  const selection = useEditorStore((state) => state.data.selection);

  const templates = useMemo(
    () =>
      engineApi
        .listTemplates()
        .filter((item) => `${item.name} ${item.tags.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase())),
    [query]
  );

  const materials = useMemo(
    () => engineApi.listMaterials().filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase())),
    [query]
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
    setMaterialNameDraft(selectedMaterial?.name ?? "");
  }, [selectedMaterial?.id, selectedMaterial?.name]);

  return (
    <div className="panel stack-sm">
      <div className="panel-head">
        <h3>Assets</h3>
      </div>

      <div className="row">
        <button className={`btn ${tab === "templates" ? "btn-primary" : ""}`} onClick={() => setTab("templates")} type="button">
          Templates
        </button>
        <button className={`btn ${tab === "materials" ? "btn-primary" : ""}`} onClick={() => setTab("materials")} type="button">
          Materials
        </button>
        <button className={`btn ${tab === "primitives" ? "btn-primary" : ""}`} onClick={() => setTab("primitives")} type="button">
          Primitives
        </button>
      </div>

      <SearchBar placeholder="search by name or tag" value={query} onChange={setQuery} />

      {tab === "templates" && (
        <ul className="list">
          {templates.map((template) => (
            <li key={template.id}>
              <button className="list-item" onClick={() => engineApi.insertTemplate(template.id)} type="button">
                <span>{template.name}</span>
                <span className="mono">{template.tags.join(", ")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {tab === "materials" && (
        <div className="stack-sm">
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
              disabled={selection.length === 0 || !selectedMaterial}
              onClick={() => {
                if (!selectedMaterial) {
                  return;
                }
                for (const nodeId of selection) {
                  engineApi.setNodeMaterial(nodeId, selectedMaterial.id);
                }
              }}
              type="button"
            >
              Apply To Selection
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

          <ul className="list">
            {materials.map((material) => (
              <li key={material.id}>
                <button
                  className={`list-item ${selectedMaterial?.id === material.id ? "selected" : ""}`}
                  onClick={() => {
                    setSelectedMaterialId(material.id);
                  }}
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
                  value={materialNameDraft}
                  onChange={(event) => setMaterialNameDraft(event.target.value)}
                  onBlur={() => {
                    const trimmed = materialNameDraft.trim();
                    if (trimmed.length > 0 && trimmed !== selectedMaterial.name) {
                      engineApi.updateMaterial(selectedMaterial.id, { name: trimmed });
                    }
                  }}
                />
              </label>

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
                  <ColorPicker
                    label="Base Color"
                    value={selectedMaterial.pbr?.baseColor ?? "#cccccc"}
                    onChange={(value) => {
                      engineApi.updateMaterial(selectedMaterial.id, {
                        pbr: {
                          ...(selectedMaterial.pbr ?? { metalness: 0.2, roughness: 0.6, baseColor: "#cccccc" }),
                          baseColor: value
                        }
                      });
                    }}
                  />
                  <SliderRow
                    label="Metalness"
                    min={0}
                    max={1}
                    step={0.01}
                    value={selectedMaterial.pbr?.metalness ?? 0.2}
                    onChange={(value) => {
                      engineApi.updateMaterial(selectedMaterial.id, {
                        pbr: {
                          ...(selectedMaterial.pbr ?? { metalness: 0.2, roughness: 0.6, baseColor: "#cccccc" }),
                          metalness: value
                        }
                      });
                    }}
                  />
                  <SliderRow
                    label="Roughness"
                    min={0}
                    max={1}
                    step={0.01}
                    value={selectedMaterial.pbr?.roughness ?? 0.6}
                    onChange={(value) => {
                      engineApi.updateMaterial(selectedMaterial.id, {
                        pbr: {
                          ...(selectedMaterial.pbr ?? { metalness: 0.2, roughness: 0.6, baseColor: "#cccccc" }),
                          roughness: value
                        }
                      });
                    }}
                  />
                </>
              )}
            </div>
          )}
        </div>
      )}

      {tab === "primitives" && (
        <div className="row wrap">
          {primitives.map((primitive) => (
            <button key={primitive} className="btn btn-primary" onClick={() => engineApi.createPrimitive(primitive)} type="button">
              {primitive}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
