import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import engineApi from "../../engine/api/engineApi";
import { SearchBar } from "../components/SearchBar";
import { useEditorStore } from "../../editor/state/editorStore";
import { ColorPicker } from "../components/ColorPicker";
import { SliderRow } from "../components/SliderRow";

type Tab = "templates" | "materials" | "textures" | "primitives";

const primitives = ["box", "cylinder", "sphere", "cone", "text", "terrain"] as const;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

function readImageDimensions(dataUrl: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.width, height: image.height });
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });
}

export default function AssetsPanel(): JSX.Element {
  const [tab, setTab] = useState<Tab>("templates");
  const [query, setQuery] = useState("");
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(null);
  const [selectedTextureId, setSelectedTextureId] = useState<string | null>(null);
  const [materialNameDraft, setMaterialNameDraft] = useState("");
  const [variantName, setVariantName] = useState("");
  const [uploadingTexture, setUploadingTexture] = useState(false);
  const textureInputRef = useRef<HTMLInputElement | null>(null);
  const selection = useEditorStore((state) => state.data.selection);
  const project = useEditorStore((state) => state.data.project);

  const templates = useMemo(
    () =>
      engineApi
        .listTemplates()
        .filter((item) => `${item.name} ${item.tags.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase())),
    [query]
  );

  const materials = useMemo(
    () => Object.values(project.materials).filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase())),
    [project.materials, query]
  );
  const textures = useMemo(
    () => Object.values(project.textures).filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase())),
    [project.textures, query]
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

  useEffect(() => {
    if (!selectedTextureId && textures.length > 0) {
      setSelectedTextureId(textures[0].id);
    }
  }, [selectedTextureId, textures]);

  async function onTextureUpload(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    setUploadingTexture(true);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const size = await readImageDimensions(dataUrl);
      const id = engineApi.createTextureAsset(
        file.name,
        dataUrl,
        file.type || "image/png",
        size?.width,
        size?.height
      );
      if (id) {
        setSelectedTextureId(id);
      }
    } finally {
      setUploadingTexture(false);
      event.target.value = "";
    }
  }

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
        <button className={`btn ${tab === "textures" ? "btn-primary" : ""}`} onClick={() => setTab("textures")} type="button">
          Textures
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
                engineApi.setNodeMaterialBatch(selection, selectedMaterial.id);
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

      {tab === "textures" && (
        <div className="stack-sm">
          <div className="row wrap">
            <button className="btn btn-primary" disabled={uploadingTexture} onClick={() => textureInputRef.current?.click()} type="button">
              {uploadingTexture ? "Uploading..." : "Upload Texture"}
            </button>
            <button
              className="btn"
              disabled={!selectedTextureId || selection.length === 0}
              onClick={() => {
                if (!selectedTextureId) {
                  return;
                }
                engineApi.applyTextureToSelection(selectedTextureId);
              }}
              type="button"
            >
              Apply To Selection
            </button>
            <button className="btn" disabled={selection.length === 0} onClick={() => engineApi.recolorSelection("#d7bfa9")} type="button">
              Recolor Selection
            </button>
            <button className="btn" disabled={selection.length === 0} onClick={() => engineApi.applyPatternToSelection("camo")} type="button">
              Apply Camo Pattern
            </button>
            <button
              className="btn"
              disabled={selection.length === 0}
              onClick={() => {
                void engineApi.saveSelectionVariant(variantName);
                setVariantName("");
              }}
              type="button"
            >
              Save Variant
            </button>
          </div>

          <label className="field">
            <span>Variant Name</span>
            <input
              className="input"
              placeholder="Humanoid skin v1"
              value={variantName}
              onChange={(event) => setVariantName(event.target.value)}
            />
          </label>

          <input ref={textureInputRef} accept="image/*" style={{ display: "none" }} type="file" onChange={(event) => void onTextureUpload(event)} />

          <ul className="list">
            {textures.map((texture) => (
              <li key={texture.id}>
                <button
                  className={`list-item ${selectedTextureId === texture.id ? "selected" : ""}`}
                  onClick={() => setSelectedTextureId(texture.id)}
                  type="button"
                >
                  <span>{texture.name}</span>
                  <span className="mono">{texture.mimeType}</span>
                </button>
              </li>
            ))}
          </ul>

          {selectedTextureId && project.textures[selectedTextureId] && (
            <img
              alt={project.textures[selectedTextureId].name}
              className="preview-image"
              src={project.textures[selectedTextureId].dataUrl}
              style={{ width: "100%", maxHeight: "180px", objectFit: "cover", borderRadius: "10px" }}
            />
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
