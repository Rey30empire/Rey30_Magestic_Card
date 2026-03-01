type PyodideType = {
  runPythonAsync: (code: string) => Promise<unknown>;
  globals: {
    set: (name: string, value: unknown) => void;
  };
};

declare global {
  interface Window {
    loadPyodide?: (options: { indexURL: string }) => Promise<PyodideType>;
  }
}

let pyodideInstance: PyodideType | null = null;
const PYODIDE_VERSION = "0.27.2";
const LOCAL_PYODIDE_INDEX_URL = `/vendor/pyodide/${PYODIDE_VERSION}/full/`;
const CDN_PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const ALLOW_REMOTE_PYODIDE_FALLBACK = import.meta.env.VITE_ALLOW_REMOTE_PYODIDE !== "false";

async function loadScript(src: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

async function loadPyodideFrom(indexUrl: string): Promise<PyodideType> {
  await loadScript(`${indexUrl}pyodide.js`);
  if (!window.loadPyodide) {
    throw new Error("Pyodide loader missing");
  }

  return window.loadPyodide({
    indexURL: indexUrl
  });
}

export async function getPyodide(): Promise<PyodideType> {
  if (pyodideInstance) {
    return pyodideInstance;
  }

  try {
    pyodideInstance = await loadPyodideFrom(LOCAL_PYODIDE_INDEX_URL);
    return pyodideInstance;
  } catch (localError) {
    if (!ALLOW_REMOTE_PYODIDE_FALLBACK) {
      throw localError;
    }
  }

  pyodideInstance = await loadPyodideFrom(CDN_PYODIDE_INDEX_URL);
  return pyodideInstance;
}
