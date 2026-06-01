"""
epc_tracer.py  —  Spadework Companion
Traces a complete EPC (Event-driven Process Chain) from a named entry point,
recursively following function calls across Vue/TS and Django/Python files.

Usage:
    python epc_tracer.py --entry PurchaseOrderForm.vue::submitOrder --root /path/to/project
    python epc_tracer.py --entry purchasing/views.py::PurchaseOrderViewSet.perform_create --root /path/to/project
    python epc_tracer.py --list PurchaseOrderForm.vue --root /path/to/project

Output:
    epc_<entrypoint>.json  (written next to the script, or --output <path>)
"""

import ast
import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DJANGO_ABSTRACTIONS = {
    # ViewSet lifecycle hooks — these are the invisible call chain
    "perform_create":    "Called by CreateModelMixin.create() after validation — sets field overrides before save",
    "perform_update":    "Called by UpdateModelMixin.update() after validation — sets field overrides before save",
    "perform_destroy":   "Called by DestroyModelMixin.destroy() — override to add soft-delete logic",
    "get_queryset":      "Controls which records this view can see — filtering/scoping happens here",
    "get_serializer":    "Selects which serializer class to use — often swapped per action",
    "get_permissions":   "Determines access control for this request",
    "get_object":        "Fetches and permission-checks the single instance for detail views",
    # Serializer lifecycle
    "validate":          "Cross-field validation — runs after individual field validators",
    "create":            "Serializer.create() — maps validated_data to a new model instance",
    "update":            "Serializer.update() — maps validated_data onto an existing instance",
    "to_representation": "Transforms the model instance into the outbound JSON shape",
    "to_internal_value": "Transforms inbound JSON into Python before field validation",
    # Signal hooks (we detect these in code as post_save.connect / @receiver)
    "post_save":         "Django signal — fires after Model.save() completes",
    "pre_save":          "Django signal — fires before Model.save()",
    "post_delete":       "Django signal — fires after Model.delete()",
}

DJANGO_SIGNAL_PATTERN = re.compile(
    r"""@receiver\s*\(\s*(pre_save|post_save|pre_delete|post_delete)[^)]*\)"""
)

# Patterns that mark an API boundary in Vue/TS files
API_CALL_PATTERNS = [
    # Regular string arguments
    re.compile(r"""axios\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]"""),
    re.compile(r"""api\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]"""),
    # Template literal arguments (backticks) e.g. api.post(`/endpoint/${id}/`)
    re.compile(r"""axios\.(get|post|put|patch|delete)\s*\(\s*`([^`]+)`"""),
    re.compile(r"""api\.(get|post|put|patch|delete)\s*\(\s*`([^`]+)`"""),
    re.compile(r"""fetch\s*\(\s*['"]([^'"]+)['"]"""),
]

# File extensions we understand
PYTHON_EXTS = {".py"}
FRONTEND_EXTS = {".vue", ".ts", ".js"}


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class EpcNode:
    id: str
    label: str
    description: str
    type: str           # event | fn | pinia | api | django | signal | unknown
    language: str       # vue | typescript | python
    file: str           # relative path from project root
    line: int
    boundary: bool      # True = cross-language API boundary
    source_snippet: list[str] = field(default_factory=list)
    children: list["EpcNode"] = field(default_factory=list)
    warning: str = ""   # e.g. "cycle detected", "file not found"


# ---------------------------------------------------------------------------
# Comment / description extraction
# ---------------------------------------------------------------------------

def extract_description_python(node: ast.AST, source_lines: list[str]) -> str:
    """
    Prefer @epc: tag in the leading comment block, fall back to first docstring
    line, then first non-blank comment line immediately before the def.
    """
    # Check for @epc: tag in the docstring
    docstring = ast.get_docstring(node)
    if docstring:
        for line in docstring.splitlines():
            stripped = line.strip()
            if stripped.startswith("@epc:"):
                return stripped[5:].strip()
        # No @epc tag — use first line of docstring
        first = docstring.strip().splitlines()[0].strip()
        if first:
            return first

    # Look for # @epc: or plain comment in the lines immediately before the def
    start = node.lineno - 1  # 0-indexed
    for i in range(max(0, start - 5), start):
        line = source_lines[i].strip()
        if line.startswith("# @epc:"):
            return line[7:].strip()
        if line.startswith("#") and not line.startswith("# type:"):
            candidate = line.lstrip("#").strip()
            if candidate:
                return candidate

    return ""


def extract_description_frontend(func_name: str, source: str, target_line: int = 0) -> str:
    """
    Search for @epc: tag or JSDoc comment before the function in Vue/TS source.
    target_line (1-indexed) pins the search to the right occurrence when a name
    appears multiple times. Falls back to scanning all occurrences.
    """
    lines = source.splitlines()

    def _is_decorator_line(text: str) -> bool:
        # Strip common comment leaders and check if what remains is just decorative
        stripped = text.lstrip("/# *-\u2014\u2013\u2500\u2501=~").strip()
        if not stripped or len(stripped) < 3:
            return True
        # Check for high density of line-drawing / dash characters
        dash_chars = set("-\u2014\u2013\u2500\u2501\u2502\u2503=~*#")
        if sum(1 for c in stripped if c in dash_chars) / len(stripped) > 0.3:
            return True
        return False

    def _scan_before(i: int) -> str:
        line = lines[i]
        if "@epc:" in line:
            return line.split("@epc:")[1].strip()
        for j in range(max(0, i - 6), i):
            prev = lines[j].strip()
            if "@epc:" in prev:
                return prev.split("@epc:")[1].strip()
            if prev.startswith("//") and not prev.startswith("// eslint"):
                candidate = prev.lstrip("/").strip()
                if candidate and not _is_decorator_line(candidate):
                    return candidate
            if prev.startswith("*") and not prev.startswith("*/"):
                candidate = prev.lstrip("*").strip()
                if candidate and not candidate.startswith("@") and not _is_decorator_line(candidate):
                    return candidate
        return ""

    # If we know which line to look at, use it directly
    if target_line > 0:
        idx = target_line - 1
        if 0 <= idx < len(lines) and re.search(rf"""\b{re.escape(func_name)}\b""", lines[idx]):
            return _scan_before(idx)

    # Otherwise scan all occurrences
    for i, line in enumerate(lines):
        if re.search(rf"""\b{re.escape(func_name)}\b""", line):
            result = _scan_before(i)
            if result:
                return result
    return ""


# ---------------------------------------------------------------------------
# Source snippet extraction
# ---------------------------------------------------------------------------

def get_snippet(source_lines: list[str], start_line: int, max_lines: int = 6) -> list[str]:
    """Return up to max_lines of source starting at start_line (1-indexed)."""
    start = max(0, start_line - 1)
    end = min(len(source_lines), start + max_lines)
    return [l.rstrip() for l in source_lines[start:end]]


# ---------------------------------------------------------------------------
# Python AST — call graph extraction
# ---------------------------------------------------------------------------

def collect_calls_python(func_node: ast.AST) -> list[str]:
    """
    Walk the AST of a function body and collect all called names.
    Returns both simple calls (foo()) and attribute calls (self.foo(), obj.method()).
    """
    calls = []
    for node in ast.walk(func_node):
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name):
                calls.append(node.func.id)
            elif isinstance(node.func, ast.Attribute):
                calls.append(node.func.attr)
    return calls


def find_function_python(
    name: str,
    tree: ast.Module,
    source_lines: list[str],
    class_name: Optional[str] = None,
) -> Optional[tuple[ast.AST, int, str]]:
    """
    Find a function/method by name in a parsed AST.
    If class_name is given, look inside that class first, then fall back to module level.
    Returns (ast_node, lineno, description) or None.
    """
    candidates = []

    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name == name:
                desc = extract_description_python(node, source_lines)
                candidates.append((node, node.lineno, desc))

    if not candidates:
        return None

    # Prefer the one inside the matching class
    if class_name:
        for node, lineno, desc in candidates:
            # Walk up: check if this function is inside the right class
            for parent in ast.walk(tree):
                if isinstance(parent, ast.ClassDef) and parent.name == class_name:
                    if any(
                        (isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) and child.name == name)
                        for child in ast.walk(parent)
                    ):
                        return node, lineno, desc

    return candidates[0]


def resolve_python_import(
    name: str,
    tree: ast.Module,
    current_file: Path,
    project_root: Path,
) -> Optional[Path]:
    """
    Try to resolve a called name to a Python file via import statements.
    Returns the Path to the file if found, else None.
    """
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            for alias in node.names:
                imported_name = alias.asname if alias.asname else alias.name
                if imported_name == name:
                    # Convert module path to file path
                    module_parts = node.module.split(".")
                    candidate = project_root / Path(*module_parts).with_suffix(".py")
                    if candidate.exists():
                        return candidate
                    # Also try as a package __init__
                    candidate2 = project_root / Path(*module_parts) / "__init__.py"
                    if candidate2.exists():
                        return candidate2
        elif isinstance(node, ast.Import):
            for alias in node.names:
                imported_name = alias.asname if alias.asname else alias.name
                if imported_name == name:
                    module_parts = alias.name.split(".")
                    candidate = project_root / Path(*module_parts).with_suffix(".py")
                    if candidate.exists():
                        return candidate
    return None


# ---------------------------------------------------------------------------
# Frontend (Vue / TS) — function extraction via regex
# ---------------------------------------------------------------------------

# These regexes cover the main patterns in emillar_v2 Vue/TS files:
#   const foo = async () => {
#   const foo = () => {
#   function foo(
#   async function foo(
#   foo(        <- method inside defineComponent / setup()

FRONTEND_FUNC_PATTERNS = [
    re.compile(r"""(?:async\s+)?function\s+(\w+)\s*\("""),
    re.compile(r"""const\s+(\w+)\s*=\s*(?:async\s*)?\("""),
    re.compile(r"""const\s+(\w+)\s*=\s*(?:async\s*)?\(\s*\)\s*=>"""),
    re.compile(r"""(\w+)\s*\(.*?\)\s*\{"""),  # method shorthand inside object
]

FRONTEND_CALL_PATTERN = re.compile(r"""(\w+)\s*\(""")
IMPORT_PATTERN = re.compile(r"""import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]""")
STORE_IMPORT_PATTERN = re.compile(r"""const\s+(\w+)\s*=\s*use(\w+)Store\s*\(""")


def find_function_frontend(name: str, source: str) -> Optional[tuple[int, int, str]]:
    """
    Find a function in Vue/TS source by name.
    Returns (start_line, end_line_estimate, description) or None.
    """
    lines = source.splitlines()
    for i, line in enumerate(lines):
        for pat in FRONTEND_FUNC_PATTERNS:
            m = pat.search(line)
            if m and m.group(1) == name:
                desc = extract_description_frontend(name, source, target_line=i + 1)
                # Estimate end by finding matching brace
                end = estimate_block_end(lines, i)
                return i + 1, end, desc
    return None


def estimate_block_end(lines: list[str], start: int, max_scan: int = 120) -> int:
    depth = 0
    max_depth_seen = 0
    for i in range(start, min(len(lines), start + max_scan)):
        opens = lines[i].count("{")
        closes = lines[i].count("}")
        depth += opens - closes
        max_depth_seen = max(max_depth_seen, depth)
        # Only close when we've actually entered a block (depth >= 1) and returned to 0
        if max_depth_seen >= 1 and depth <= 0:
            return i + 1
    return start + max_scan


def collect_calls_frontend(source: str, start_line: int, end_line: int) -> list[str]:
    """Extract function call names from a block of frontend source."""
    block = "\n".join(source.splitlines()[start_line - 1: end_line])
    calls = FRONTEND_CALL_PATTERN.findall(block)
    # Filter out JS keywords and very short names
    skip = {
        "if", "for", "while", "switch", "catch", "return", "await",
        "async", "const", "let", "var", "new", "typeof", "instanceof",
        "console", "Object", "Array", "String", "Number", "Boolean",
        "Promise", "Math", "JSON", "parseInt", "parseFloat",
        "setTimeout", "clearTimeout", "setInterval",
    }
    return [c for c in calls if c not in skip and len(c) > 2]


def collect_dotted_calls_frontend(source: str, start_line: int, end_line: int) -> list[str]:
    """Collect dotted method calls like store.createPO, router.push within a function block."""
    block = "\n".join(source.splitlines()[start_line - 1: end_line])
    # Match obj.method( patterns
    pat = re.compile(r"""\b(\w+)\.(\w+)\s*\(""")
    skip_objs = {"console", "Object", "Array", "Math", "JSON", "Promise", "window", "document"}
    skip_methods = {"value", "then", "catch", "finally", "push", "pop", "filter", "map", "find",
                    "forEach", "reduce", "split", "join", "trim", "replace", "toString", "length"}
    results = []
    for m in pat.finditer(block):
        obj, method = m.group(1), m.group(2)
        if obj not in skip_objs and method not in skip_methods and len(method) > 2:
            results.append(f"{obj}.{method}")
    return results


def detect_api_calls(source: str, start_line: int, end_line: int) -> list[dict]:
    """Detect axios/fetch API calls within a function block."""
    block = "\n".join(source.splitlines()[start_line - 1: end_line])
    found = []
    for pat in API_CALL_PATTERNS:
        for m in pat.finditer(block):
            groups = m.groups()
            method = groups[0].upper() if len(groups) > 1 else "GET"
            endpoint = groups[-1]
            found.append({"method": method, "endpoint": endpoint})
    return found


def resolve_frontend_import(name: str, source: str, current_file: Path, project_root: Path) -> Optional[Path]:
    """Try to resolve a frontend import to a file path."""

    # 1. Named imports: import { usePurchaseOrderStore } from '@/features/...'
    for m in IMPORT_PATTERN.finditer(source):
        imports = [i.strip().split(" as ")[-1].strip() for i in m.group(1).split(",")]
        if name in imports:
            import_path = m.group(2)
            return resolve_path(import_path, current_file, project_root)

    # 2. Default imports: import api from '@/api/axios'
    default_import_pat = re.compile(r"""import\s+(\w+)\s+from\s+['"]([^'"]+)['"]""")
    for m in default_import_pat.finditer(source):
        if m.group(1) == name:
            return resolve_path(m.group(2), current_file, project_root)

    # 3. Store usage: const store = usePurchaseOrderStore()
    #    Resolves store.method calls by finding the composable import
    store_var_pat = re.compile(r"""const\s+(\w+)\s*=\s*(use\w+Store)\s*\(""")
    for m in store_var_pat.finditer(source):
        store_var = m.group(1)       # e.g. "store"
        composable = m.group(2)      # e.g. "usePurchaseOrderStore"

        if name == store_var or name.startswith(store_var + "."):
            # Find the import path for the composable
            for im in IMPORT_PATTERN.finditer(source):
                imported_names = [i.strip().split(" as ")[-1].strip() for i in im.group(1).split(",")]
                if composable in imported_names:
                    return resolve_path(im.group(2), current_file, project_root)
            # Fallback: search project for the composable file by name
            for ext in [".ts", ".js"]:
                matches = list(project_root.rglob(f"{composable}{ext}"))
                if matches:
                    return matches[0]

    return None


def resolve_path(import_path: str, current_file: Path, project_root: Path) -> Optional[Path]:
    """Resolve a JS/TS import path to an actual file."""
    # Strip query strings and hash
    import_path = import_path.split("?")[0].split("#")[0]

    # Handle @/ alias (Vite default = src/)
    if import_path.startswith("@/"):
        import_path = import_path[2:]
        bases = [project_root / "src", project_root / "frontend" / "src", project_root / "frontend"]
    elif import_path.startswith("./") or import_path.startswith("../"):
        bases = [current_file.parent]
    else:
        bases = [project_root / "src", project_root / "frontend" / "src", project_root]

    for base in bases:
        for ext in ["", ".ts", ".js", ".vue"]:
            candidate = (base / import_path).with_suffix(ext) if ext else base / import_path
            if candidate.exists() and candidate.is_file():
                return candidate
            # Try index file
            index = base / import_path / f"index{ext}"
            if index.exists():
                return index
    return None


# ---------------------------------------------------------------------------
# Core tracer
# ---------------------------------------------------------------------------

class EpcTracer:
    def __init__(self, project_root: Path, max_depth: int = 12):
        self.project_root = project_root
        self.max_depth = max_depth
        self.visited: set[tuple[str, str]] = set()  # (file, func_name)
        self._file_cache: dict[Path, tuple[str, list[str]]] = {}

    def _load_file(self, path: Path) -> tuple[str, list[str]]:
        if path not in self._file_cache:
            source = path.read_text(encoding="utf-8", errors="replace")
            self._file_cache[path] = (source, source.splitlines())
        return self._file_cache[path]

    def _rel(self, path: Path) -> str:
        try:
            return str(path.relative_to(self.project_root))
        except ValueError:
            return str(path)

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    def trace(self, entry_file: Path, entry_func: str) -> EpcNode:
        """Build the full EPC tree from an entry point."""
        self.visited.clear()
        return self._trace_node(entry_file, entry_func, depth=0, entry_type="event")

    # ------------------------------------------------------------------
    # Dispatch by language
    # ------------------------------------------------------------------

    def _trace_node(
        self,
        file: Path,
        func_name: str,
        depth: int,
        entry_type: str = "fn",
        class_name: Optional[str] = None,
    ) -> EpcNode:
        key = (str(file), func_name)

        if depth > self.max_depth:
            return EpcNode(
                id=f"{func_name}_depth_limit",
                label=func_name,
                description="",
                type="unknown",
                language="unknown",
                file=self._rel(file),
                line=0,
                boundary=False,
                warning="max depth reached",
            )

        if key in self.visited:
            return EpcNode(
                id=f"{func_name}_cycle",
                label=func_name,
                description="",
                type="fn",
                language="python" if file.suffix == ".py" else "vue",
                file=self._rel(file),
                line=0,
                boundary=False,
                warning="cycle detected — already traced above",
            )

        self.visited.add(key)

        if file.suffix in PYTHON_EXTS:
            return self._trace_python(file, func_name, depth, entry_type, class_name)
        elif file.suffix in FRONTEND_EXTS:
            return self._trace_frontend(file, func_name, depth, entry_type)
        else:
            return EpcNode(
                id=func_name,
                label=func_name,
                description="",
                type="unknown",
                language="unknown",
                file=self._rel(file),
                line=0,
                boundary=False,
                warning=f"unsupported file type: {file.suffix}",
            )

    # ------------------------------------------------------------------
    # Python / Django tracer
    # ------------------------------------------------------------------

    def _trace_python(
        self,
        file: Path,
        func_name: str,
        depth: int,
        entry_type: str,
        class_name: Optional[str] = None,
    ) -> EpcNode:
        if not file.exists():
            return EpcNode(
                id=func_name, label=func_name, description="",
                type="django", language="python",
                file=self._rel(file), line=0, boundary=False,
                warning=f"file not found: {file}",
            )

        source, source_lines = self._load_file(file)

        try:
            tree = ast.parse(source)
        except SyntaxError as e:
            return EpcNode(
                id=func_name, label=func_name, description="",
                type="django", language="python",
                file=self._rel(file), line=0, boundary=False,
                warning=f"syntax error: {e}",
            )

        result = find_function_python(func_name, tree, source_lines, class_name)
        if not result:
            # Check if it's a known Django abstraction
            if func_name in DJANGO_ABSTRACTIONS:
                return EpcNode(
                    id=func_name,
                    label=func_name,
                    description=DJANGO_ABSTRACTIONS[func_name],
                    type="django",
                    language="python",
                    file=self._rel(file),
                    line=0,
                    boundary=False,
                    warning="DRF abstraction — not explicitly defined in this file",
                )
            return EpcNode(
                id=func_name, label=func_name, description="",
                type="django", language="python",
                file=self._rel(file), line=0, boundary=False,
                warning="function not found in file",
            )

        func_node, lineno, description = result

        # Check for @epc: override in the abstraction table
        if not description and func_name in DJANGO_ABSTRACTIONS:
            description = DJANGO_ABSTRACTIONS[func_name]

        node = EpcNode(
            id=f"{self._rel(file)}::{func_name}",
            label=func_name,
            description=description,
            type=entry_type if depth == 0 else "django",
            language="python",
            file=self._rel(file),
            line=lineno,
            boundary=False,
            source_snippet=get_snippet(source_lines, lineno),
        )

        # Collect calls and recurse
        calls = collect_calls_python(func_node)
        seen_calls: set[str] = set()

        for called in calls:
            if called in seen_calls:
                continue
            seen_calls.add(called)

            # Is it a known Django abstraction we should annotate?
            if called in DJANGO_ABSTRACTIONS:
                abstraction_node = EpcNode(
                    id=f"{called}_abstraction",
                    label=called,
                    description=DJANGO_ABSTRACTIONS[called],
                    type="django",
                    language="python",
                    file=self._rel(file),
                    line=0,
                    boundary=False,
                    warning="DRF/Django framework method",
                )
                node.children.append(abstraction_node)
                continue

            # Try to resolve to a file and recurse
            target_file = resolve_python_import(called, tree, file, self.project_root)
            if target_file:
                child = self._trace_node(target_file, called, depth + 1, "fn")
                node.children.append(child)
            else:
                # Try same file
                if find_function_python(called, tree, source_lines):
                    child = self._trace_node(file, called, depth + 1, "fn")
                    node.children.append(child)

        # Detect Django signals defined in this file
        for m in DJANGO_SIGNAL_PATTERN.finditer(source):
            signal_type = m.group(1)
            # Find the function immediately after the decorator
            signal_line = source[:m.start()].count("\n") + 1
            signal_node = EpcNode(
                id=f"{signal_type}_signal_{signal_line}",
                label=f"@receiver({signal_type})",
                description=DJANGO_ABSTRACTIONS.get(signal_type, f"Django {signal_type} signal"),
                type="signal",
                language="python",
                file=self._rel(file),
                line=signal_line,
                boundary=False,
                warning="signal — fires asynchronously after model operation",
            )
            node.children.append(signal_node)

        return node

    # ------------------------------------------------------------------
    # Vue / TypeScript tracer
    # ------------------------------------------------------------------

    def _trace_frontend(
        self,
        file: Path,
        func_name: str,
        depth: int,
        entry_type: str,
    ) -> EpcNode:
        if not file.exists():
            return EpcNode(
                id=func_name, label=func_name, description="",
                type=entry_type, language="vue",
                file=self._rel(file), line=0, boundary=False,
                warning=f"file not found: {file}",
            )

        source, source_lines = self._load_file(file)
        lang = "vue" if file.suffix == ".vue" else "typescript"

        # Handle store.method pattern
        store_var, method_name = None, func_name
        if "." in func_name:
            store_var, method_name = func_name.split(".", 1)

        result = find_function_frontend(method_name, source)
        if not result:
            return EpcNode(
                id=func_name, label=func_name, description="",
                type=entry_type, language=lang,
                file=self._rel(file), line=0, boundary=False,
                warning="function not found — may be dynamically defined or external",
            )

        start_line, end_line, description = result

        node = EpcNode(
            id=f"{self._rel(file)}::{func_name}",
            label=func_name,
            description=description,
            type=entry_type if depth == 0 else "fn",
            language=lang,
            file=self._rel(file),
            line=start_line,
            boundary=False,
            source_snippet=get_snippet(source_lines, start_line),
        )

        # Detect API calls at any depth — these mark the Vue→Django boundary
        api_calls = detect_api_calls(source, start_line, end_line)
        seen_endpoints: set[str] = set()
        for api in api_calls:
            ep_key = f"{api['method']}:{api['endpoint']}"
            if ep_key in seen_endpoints:
                continue
            seen_endpoints.add(ep_key)
            # Use a stable id — strip dynamic segments like ${poId}
            stable_ep = re.sub(r"\$\{[^}]+\}", "{id}", api["endpoint"])
            api_node = EpcNode(
                id=f"api_{api['method']}_{stable_ep.replace('/', '_').replace('{','').replace('}','')}_{depth}",
                label=f"{api['method']} {api['endpoint']}",
                description=f"HTTP {api['method']} to Django REST endpoint",
                type="api",
                language="typescript",
                file=self._rel(file),
                line=start_line,
                boundary=True,
            )
            # Try to find the matching Django view
            django_child = self._resolve_api_to_django(api["endpoint"], api["method"])
            if django_child:
                api_node.children.append(django_child)
            node.children.append(api_node)

        # Collect and recurse into function calls
        # Also collect dotted calls like store.createPO, router.push
        calls = collect_calls_frontend(source, start_line, end_line)
        dotted_calls = collect_dotted_calls_frontend(source, start_line, end_line)
        all_calls = list(dict.fromkeys(dotted_calls + calls))  # dotted first, deduped
        seen_calls: set[str] = set()

        for called in all_calls:
            if called in seen_calls:
                continue
            if called == method_name or called == func_name:
                continue
            seen_calls.add(called)

            # Try to resolve via imports (handles store.method pattern)
            target_file = resolve_frontend_import(called, source, file, self.project_root)
            if target_file and target_file != file:
                # For store.method calls, look up just the method in the store file
                if "." in called:
                    _, method = called.split(".", 1)
                    child = self._trace_node(target_file, method, depth + 1, "fn")
                else:
                    child = self._trace_node(target_file, called, depth + 1, "fn")
                node.children.append(child)
            elif target_file is None:
                # Try same file (plain function call)
                if "." not in called and find_function_frontend(called, source):
                    child = self._trace_node(file, called, depth + 1, "fn")
                    node.children.append(child)

        return node

    # ------------------------------------------------------------------
    # API boundary resolution  Vue endpoint → Django viewset
    # ------------------------------------------------------------------

    def _resolve_api_to_django(self, endpoint: str, method: str) -> Optional[EpcNode]:
        """
        Try to find the Django view that handles this endpoint by scanning urls.py files.
        This is best-effort — URL patterns with parameters won't match exactly.
        """
        url_files = list(self.project_root.rglob("urls.py"))
        method_to_action = {
            "GET":    ["list", "retrieve"],
            "POST":   ["create"],
            "PUT":    ["update"],
            "PATCH":  ["partial_update"],
            "DELETE": ["destroy"],
        }
        actions = method_to_action.get(method.upper(), [])

        # Normalise endpoint: strip leading app prefix (/purchasing/, /api/, etc), trailing slash, query string
        clean = re.sub(r"^/[^/]+/", "", endpoint).strip("/").split("?")[0]
        # Remove dynamic segments like ${poId} and trailing ID-like parts
        clean = re.sub(r"\$\{[^}]+\}", "", clean).strip("/")
        clean_base = re.sub(r"/\d+(/|$)", "/", clean).strip("/").split("/")[0]

        for url_file in url_files:
            source = url_file.read_text(encoding="utf-8", errors="replace")
            # Look for ViewSet registrations:
            #   router.register(r'purchase-orders', PurchaseOrderViewSet, ...)
            #   router.register(r'purchase-orders', views.PurchaseOrderViewSet, ...)
            m = re.search(
                rf"""router\.register\s*\(\s*r?['"].*?{re.escape(clean_base)}.*?['"]\s*,\s*(?:\w+\.)?(\w+ViewSet)""",
                source, re.IGNORECASE
            )
            if m:
                viewset_name = m.group(1)
                # Find which file defines this ViewSet
                viewset_file = self._find_class_file(viewset_name)
                if viewset_file:
                    # Prefer perform_create/perform_update over the DRF mixin defaults
                    # since that's where custom logic lives in emillar_v2
                    action_map = {
                        "create":  ["perform_create", "create"],
                        "list":    ["get_queryset", "list"],
                        "retrieve":["get_object", "retrieve"],
                        "update":  ["perform_update", "update"],
                        "destroy": ["perform_destroy", "destroy"],
                    }
                    raw_action = actions[0] if actions else "create"
                    preferred = action_map.get(raw_action, [raw_action])
                    # Pick the first one that actually exists in the file
                    file_source = viewset_file.read_text(encoding="utf-8", errors="replace")
                    action = next(
                        (a for a in preferred if re.search(rf"def\s+{re.escape(a)}\s*\(", file_source)),
                        raw_action
                    )
                    # Save and restore visited to avoid false cycle detection across API boundaries
                    saved_visited = set(self.visited)
                    node = self._trace_node(viewset_file, action, 0, "django", class_name=viewset_name)
                    self.visited = saved_visited
                    return node
        return None

    def _find_class_file(self, class_name: str) -> Optional[Path]:
        """Search the project for a Python file defining class_name."""
        for py_file in self.project_root.rglob("*.py"):
            if "migrations" in py_file.parts or "__pycache__" in py_file.parts:
                continue
            try:
                source = py_file.read_text(encoding="utf-8", errors="replace")
                if re.search(rf"""class\s+{re.escape(class_name)}\s*[\(:]""", source):
                    return py_file
            except Exception:
                continue
        return None


# ---------------------------------------------------------------------------
# Entry point auto-detection (for the VSCode picker)
# ---------------------------------------------------------------------------

def list_entry_points(file: Path) -> list[dict]:
    """
    Return all detectable entry points in a file:
    Vue/TS: @click handlers, onMounted, watch, defineEmits handlers
    Python: ViewSet actions, url-mapped views, signal receivers
    """
    source = file.read_text(encoding="utf-8", errors="replace")
    entries = []

    if file.suffix in FRONTEND_EXTS:
        # @click="handler" or @click="handler()"
        for m in re.finditer(r"""@(?:click|submit|change|input|keyup|keydown)\s*=\s*["'](\w+)""", source):
            entries.append({"type": "@click", "name": m.group(1), "line": source[:m.start()].count("\n") + 1})
        # onMounted(() => ...) or onMounted(funcName)
        for m in re.finditer(r"""onMounted\s*\(\s*(?:\(\s*\)\s*=>\s*\{)?(\w+)?""", source):
            name = m.group(1) or "onMounted_callback"
            entries.append({"type": "onMounted", "name": name, "line": source[:m.start()].count("\n") + 1})
        # watch(source, handler)
        for m in re.finditer(r"""watch\s*\(\s*\w+\s*,\s*(?:async\s*)?\(?(\w+)""", source):
            entries.append({"type": "watch", "name": m.group(1), "line": source[:m.start()].count("\n") + 1})
        # Pinia actions
        for m in re.finditer(r"""actions\s*:\s*\{([^}]+)\}""", source, re.DOTALL):
            for am in re.finditer(r"""async\s+(\w+)|(\w+)\s*\(""", m.group(1)):
                name = am.group(1) or am.group(2)
                if name:
                    entries.append({"type": "pinia_action", "name": name, "line": source[:m.start()].count("\n") + 1})

    elif file.suffix in PYTHON_EXTS:
        try:
            tree = ast.parse(source)
            lines = source.splitlines()
            for node in ast.walk(tree):
                if isinstance(node, ast.ClassDef):
                    # Check if it looks like a ViewSet or APIView
                    if any(b.id if isinstance(b, ast.Name) else "" in ("ViewSet", "APIView", "GenericAPIView", "ModelViewSet")
                           for b in node.bases if isinstance(b, (ast.Name, ast.Attribute))):
                        for child in ast.walk(node):
                            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                                entries.append({
                                    "type": "django_view",
                                    "name": f"{node.name}.{child.name}",
                                    "line": child.lineno,
                                })
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    # url-mapped views typically have (request, ...) signature
                    args = [a.arg for a in node.args.args]
                    if "request" in args:
                        entries.append({"type": "view_fn", "name": node.name, "line": node.lineno})
        except SyntaxError:
            pass

        # Signal receivers
        for m in DJANGO_SIGNAL_PATTERN.finditer(source):
            line = source[:m.start()].count("\n") + 2
            entries.append({"type": "signal", "name": f"@receiver({m.group(1)})", "line": line})

    return entries


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Trace an EPC from a Vue/TS or Django entry point"
    )
    parser.add_argument(
        "--entry", "-e",
        help="Entry point as file::function, e.g. PurchaseOrderForm.vue::submitOrder",
    )
    parser.add_argument(
        "--list", "-l",
        help="List all detectable entry points in a file",
    )
    parser.add_argument(
        "--root", "-r",
        default=".",
        help="Project root directory (default: current directory)",
    )
    parser.add_argument(
        "--output", "-o",
        help="Output JSON file path (default: epc_<func>.json)",
    )
    parser.add_argument(
        "--depth", "-d",
        type=int,
        default=12,
        help="Maximum recursion depth (default: 12)",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        default=True,
        help="Pretty-print JSON output (default: True)",
    )
    args = parser.parse_args()

    project_root = Path(args.root).resolve()

    # --list mode
    if args.list:
        list_file = project_root / args.list if not Path(args.list).is_absolute() else Path(args.list)
        if not list_file.exists():
            # Try searching
            found = list(project_root.rglob(args.list))
            if found:
                list_file = found[0]
            else:
                print(f"File not found: {args.list}", file=sys.stderr)
                sys.exit(1)
        entries = list_entry_points(list_file)
        print(json.dumps(entries, indent=2))
        return

    # --entry mode
    if not args.entry:
        parser.print_help()
        sys.exit(1)

    if "::" not in args.entry:
        print("Entry must be in the form file::function", file=sys.stderr)
        sys.exit(1)

    file_part, func_part = args.entry.split("::", 1)

    # Find the file
    entry_path = project_root / file_part if not Path(file_part).is_absolute() else Path(file_part)
    if not entry_path.exists():
        found = list(project_root.rglob(file_part))
        if found:
            entry_path = found[0]
            print(f"Resolved to: {entry_path}", file=sys.stderr)
        else:
            print(f"File not found: {file_part}", file=sys.stderr)
            sys.exit(1)

    # Handle ClassName.method_name
    class_name = None
    func_name = func_part
    if "." in func_part and entry_path.suffix in PYTHON_EXTS:
        class_name, func_name = func_part.split(".", 1)

    print(f"Tracing: {func_name} in {entry_path}", file=sys.stderr)

    tracer = EpcTracer(project_root, max_depth=args.depth)
    tree = tracer.trace(entry_path, func_name)

    # Serialise
    def node_to_dict(n: EpcNode) -> dict:
        d = asdict(n)
        d["children"] = [node_to_dict(c) for c in n.children]
        return d

    output = {
        "meta": {
            "entry": args.entry,
            "root": str(project_root),
            "depth_limit": args.depth,
            "files_traced": len(tracer._file_cache),
        },
        "tree": node_to_dict(tree),
    }

    indent = 2 if args.pretty else None
    json_str = json.dumps(output, indent=indent)

    if args.output:
        out_path = Path(args.output)
    else:
        safe_name = re.sub(r"[^\w]", "_", func_name)
        out_path = Path(f"epc_{safe_name}.json")

    out_path.write_text(json_str, encoding="utf-8")
    print(f"Written: {out_path}", file=sys.stderr)
    print(json_str)


if __name__ == "__main__":
    main()