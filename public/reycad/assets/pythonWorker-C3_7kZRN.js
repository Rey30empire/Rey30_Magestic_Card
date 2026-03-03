(function(){"use strict";let i=null;const r="0.27.2",n=`/vendor/pyodide/${r}/full/`,l=`https://cdn.jsdelivr.net/pyodide/v${r}/full/`,_=`
import builtins
import contextlib
import io
import json
import sys
import types

_ops = []
_selection = list(__REYCAD_SELECTION__ or [])
_max_nodes = int(__REYCAD_MAX_NODES__)
_created_nodes = 0

_allowed_modules = {
  "math",
  "random",
  "statistics",
  "json",
  "itertools",
  "collections",
  "reycad",
  "typing"
}

_original_import = builtins.__import__

def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".")[0]
    if root not in _allowed_modules:
        raise ImportError(f"Module '{root}' is blocked in ReyCAD Python sandbox")
    return _original_import(name, globals, locals, fromlist, level)

builtins.__import__ = _safe_import

def _emit(tool, args):
    global _created_nodes
    if tool == "create_primitive":
        _created_nodes += 1
        if _created_nodes > _max_nodes:
            raise RuntimeError(f"Node creation limit exceeded ({_max_nodes})")
    _ops.append({"tool": tool, "args": args})
    return f"op_{len(_ops)}"

class _Create:
    def box(self, w=20, h=20, d=20, x=0, y=0, z=0, material=None):
        return _emit("create_primitive", {"primitive":"box","params":{"w":w,"h":h,"d":d},"transform":{"position":[x,y,z]},"materialId":material})
    def cylinder(self, r=8, h=20, x=0, y=0, z=0, material=None):
        return _emit("create_primitive", {"primitive":"cylinder","params":{"rTop":r,"rBottom":r,"h":h,"radialSegments":32},"transform":{"position":[x,y,z]},"materialId":material})
    def sphere(self, r=10, x=0, y=0, z=0, material=None):
        return _emit("create_primitive", {"primitive":"sphere","params":{"r":r,"widthSegments":32,"heightSegments":16},"transform":{"position":[x,y,z]},"materialId":material})
    def cone(self, r=10, h=20, x=0, y=0, z=0, material=None):
        return _emit("create_primitive", {"primitive":"cone","params":{"r":r,"h":h,"radialSegments":32},"transform":{"position":[x,y,z]},"materialId":material})
    def text(self, text="R33", size=8, height=2, x=0, y=0, z=0, material=None):
        return _emit("create_primitive", {"primitive":"text","params":{"text":text,"size":size,"height":height,"fontId":"default"},"transform":{"position":[x,y,z]},"materialId":material})
    def terrain(self, w=120, d=120, segments=48, height_seed=1337, height_scale=8, x=0, y=0, z=0, material=None):
        return _emit("create_primitive", {
            "primitive":"terrain",
            "params":{"w":w,"d":d,"segments":segments,"heightSeed":height_seed,"heightScale":height_scale},
            "transform":{"position":[x,y,z]},
            "materialId":material
        })

class _Boolean:
    def subtract(self, a, b):
        return _emit("add_boolean", {"op":"subtract","aId":a,"bId":b})
    def union(self, a, b):
        return _emit("add_boolean", {"op":"union","aId":a,"bId":b})
    def intersect(self, a, b):
        return _emit("add_boolean", {"op":"intersect","aId":a,"bId":b})

class _Selection:
    def get(self):
        return list(_selection)
    def set(self, ids):
        global _selection
        _selection = list(ids)
        _emit("selection_set", {"nodeIds": list(ids)})
        return list(_selection)

class _Physics:
    def rigidbody(self, node_id, enabled=True, mode="dynamic", mass=1, gravity_scale=1, lock_rotation=True, velocity=(0,0,0)):
        vx, vy, vz = velocity
        return _emit("set_rigidbody", {
            "nodeId": str(node_id),
            "enabled": bool(enabled),
            "mode": str(mode),
            "mass": float(mass),
            "gravityScale": float(gravity_scale),
            "lockRotation": bool(lock_rotation),
            "linearVelocity": [float(vx), float(vy), float(vz)]
        })

    def collider(self, node_id, enabled=True, shape="box", is_trigger=False, size=(1,1,1), radius=0.5, height=1):
        sx, sy, sz = size
        return _emit("set_collider", {
            "nodeId": str(node_id),
            "enabled": bool(enabled),
            "shape": str(shape),
            "isTrigger": bool(is_trigger),
            "size": [float(sx), float(sy), float(sz)],
            "radius": float(radius),
            "height": float(height)
        })

    def world(self, enabled=True, simulate=True, gravity=(0,-9.81,0), floor_y=0, backend="auto", runtime_mode="arena"):
        gx, gy, gz = gravity
        return _emit("set_physics_world", {
            "enabled": bool(enabled),
            "simulate": bool(simulate),
            "runtimeMode": str(runtime_mode),
            "backend": str(backend),
            "gravity": [float(gx), float(gy), float(gz)],
            "floorY": float(floor_y)
        })

    def impulse(self, node_id, impulse=(0, 8, 0)):
        ix, iy, iz = impulse
        return _emit("apply_impulse", {
            "nodeId": str(node_id),
            "impulse": [float(ix), float(iy), float(iz)]
        })

    def add_constraint(self, a_id, b_id, rest_length=10, stiffness=0.6, damping=0.1, enabled=True):
        return _emit("add_constraint", {
            "aId": str(a_id),
            "bId": str(b_id),
            "restLength": float(rest_length),
            "stiffness": float(stiffness),
            "damping": float(damping),
            "enabled": bool(enabled)
        })

    def update_constraint(self, constraint_id, a_id=None, b_id=None, rest_length=None, stiffness=None, damping=None, enabled=None):
        payload = {"constraintId": str(constraint_id)}
        if a_id is not None:
            payload["aId"] = str(a_id)
        if b_id is not None:
            payload["bId"] = str(b_id)
        if rest_length is not None:
            payload["restLength"] = float(rest_length)
        if stiffness is not None:
            payload["stiffness"] = float(stiffness)
        if damping is not None:
            payload["damping"] = float(damping)
        if enabled is not None:
            payload["enabled"] = bool(enabled)
        return _emit("update_constraint", payload)

    def remove_constraint(self, constraint_id):
        return _emit("remove_constraint", {"constraintId": str(constraint_id)})

    def battle_setup(self):
        return _emit("setup_battle_scene", {})

    def battle_clash(self, impulse=16):
        return _emit("play_battle_clash", {"impulse": float(impulse)})

    def battle_stop(self):
        return _emit("stop_battle_scene", {})

module = types.ModuleType("reycad")
module.create = _Create()
module.boolean = _Boolean()
module.selection = _Selection()
module.physics = _Physics()

def group(node_ids, mode="mixed"):
    return _emit("group", {"nodeIds": list(node_ids), "mode": mode})

def hole(node_id):
    return _emit("set_mode", {"nodeId": node_id, "mode": "hole"})

def solid(node_id):
    return _emit("set_mode", {"nodeId": node_id, "mode": "solid"})

def duplicate(node_id, count=1, dx=0, dy=0, dz=0):
    return _emit("duplicate_pattern", {"nodeId": node_id, "count": int(count), "dx": dx, "dy": dy, "dz": dz})

def scatter(template_id, count=10, area=(100,100), seed=123):
    width, depth = area
    return _emit("scatter_template", {"templateId": template_id, "count": int(count), "width": float(width), "depth": float(depth), "seed": int(seed)})

def set_grid(snap=1, angleSnap=15, size=400):
    return _emit("set_grid", {"snap": snap, "angleSnap": angleSnap, "size": size})

def frame(node_ids):
    return _emit("frame", {"nodeIds": list(node_ids)})

module.group = group
module.hole = hole
module.solid = solid
module.duplicate = duplicate
module.scatter = scatter
module.set_grid = set_grid
module.frame = frame
sys.modules["reycad"] = module

_stdout_io = io.StringIO()
_stderr_io = io.StringIO()
_status = "ok"

with contextlib.redirect_stdout(_stdout_io), contextlib.redirect_stderr(_stderr_io):
    try:
        exec(__REYCAD_CODE__, {})
    except Exception as _err:
        _status = "error"
        print(f"{type(_err).__name__}: {_err}", file=sys.stderr)

json.dumps({
  "status": _status,
  "stdout": _stdout_io.getvalue(),
  "stderr": _stderr_io.getvalue(),
  "ops": _ops
})
`;async function m(e){return await import(`${e}pyodide.mjs`)}async function a(e){return(await m(e)).loadPyodide({indexURL:e})}async function d(){return i||(i=(async()=>{try{return await a(n)}catch{return await a(l)}})(),i)}self.onmessage=async e=>{try{if(e.data.type==="init"){await d();const f={id:e.data.id,ok:!0,type:"init"};self.postMessage(f);return}const t=await d();t.globals.set("__REYCAD_CODE__",e.data.code),t.globals.set("__REYCAD_MAX_NODES__",e.data.maxNodes),t.globals.set("__REYCAD_SELECTION__",e.data.selection);const s=await t.runPythonAsync(_),o=JSON.parse(String(s)),p={id:e.data.id,ok:!0,type:"run",stdout:o.stdout??"",stderr:o.stderr??"",ops:Array.isArray(o.ops)?o.ops:[]};self.postMessage(p)}catch(t){const s={id:e.data.id,ok:!1,type:"error",error:t instanceof Error?t.message:String(t)};self.postMessage(s)}}})();
