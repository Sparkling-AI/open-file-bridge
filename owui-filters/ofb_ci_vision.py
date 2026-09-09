"""
Open File Bridge — CI Vision Filter (Open WebUI >= 0.11)

WHY: in Open WebUI 0.11.x, code-interpreter output reaches the model as
TEXT only. If executed code prints an image (a `data:image/...;base64,...`
URL — e.g. Open File Bridge's GET /image_b64), the middleware uploads it
and rewrites the line to `![Output Image](/api/v1/files/<id>/content)`
markdown, but no image_url content block is ever created for the
code-interpreter path (only native tool-call output gets that). The model
never sees the pixels; only the user does.

WHAT THIS FILTER DOES: on the code-interpreter continuation turn (and any
later turn), it scans the assistant message's `<code_interpreter_output>`
sections for images — both the rewritten `/api/v1/files/<id>/content`
markdown refs and raw data URLs printed anywhere in the output text — and
appends a synthetic user message carrying them as `image_url` parts, so a
vision-capable chat model receives them as actual visual input.

It is a strict no-op for every request that has no code-interpreter
output, and it strips its own earlier synthetic messages from history so
inlined base64 never bloats later turns. Any internal failure passes the
body through untouched — chats must never break because of this filter.

SKILL-SIDE CONTRACT (taught in SKILL-EXT.md): to show a local image AND
let a vision model inspect it, print the data URL inside the cell:
    d = await bridge_get("/image_b64", {"path": "photos/site.jpg"})
    print(d["data_url"])            # becomes a file ref after OWUI's rewrite
    print(json.dumps({"width": d["width"], ...}))  # your summary, last line
Open WebUI uploads full-line data URLs (UI shows the image); this filter
then re-attaches it for the model. Data URLs embedded in JSON output are
NOT uploaded by Open WebUI but are still caught by this filter.

INSTALL (admin): Admin Panel → Functions → paste this file → enable
(Active + Global). Or POST /api/v1/functions/create, then
POST /api/v1/functions/id/ofb_ci_vision/toggle and .../toggle/global.
Requires no fork and no other patching; works on stock Open WebUI 0.11+.
"""

import asyncio
import base64
import re
from pathlib import Path

from pydantic import BaseModel

# Synthetic messages carry this prefix so (a) later turns can strip them
# from history and (b) the model can recognize the attachment context.
MARKER = "[ofb-ci-vision]"

CI_OUTPUT_RE = re.compile(
    r"<code_interpreter_output>(.*?)(?:</code_interpreter_output>|\Z)", re.DOTALL
)
FILE_REF_RE = re.compile(
    r"!\[([^\]]*)\]\(/api/v1/files/([0-9a-fA-F-]{36})/content\)"
)
MD_DATA_URL_RE = re.compile(
    r"!\[([^\]]*)\]\(data:image/([\w.+-]+);base64,([A-Za-z0-9+/=]{256,})\)"
)
BARE_DATA_URL_RE = re.compile(
    r"data:image/([\w.+-]+);base64,([A-Za-z0-9+/=]{256,})"
)


class Valves(BaseModel):
    priority: int = 0
    max_images: int = 3
    max_image_mb: float = 8.0
    inject_for_all_models: bool = True


class Filter:
    def __init__(self):
        self.valves = Valves()

    async def inlet(self, body: dict, __user__: dict = None, __model__: dict = None) -> dict:
        try:
            return await self._process(body, __user__, __model__)
        except Exception as e:
            print(f"[ofb_ci_vision] passthrough after internal error: {e!r}")
            return body

    # ---- helpers -------------------------------------------------------

    @staticmethod
    def _message_text(message: dict) -> str:
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "\n".join(
                part.get("text", "") for part in content if isinstance(part, dict)
            )
        return ""

    @staticmethod
    def _is_ours(message: dict) -> bool:
        if message.get("role") != "user":
            return False
        content = message.get("content")
        if isinstance(content, str):
            return content.startswith(MARKER)
        if isinstance(content, list):
            return any(
                isinstance(p, dict)
                and p.get("type") == "text"
                and str(p.get("text", "")).startswith(MARKER)
                for p in content
            )
        return False

    def _collect_candidates(self, sections: str) -> list:
        """Ordered, deduped image candidates: ('file', id, label) | ('data', mime, b64, label)."""
        candidates = []
        seen_b64 = set()
        seen_files = set()

        for label, file_id in FILE_REF_RE.findall(sections):
            if file_id not in seen_files:
                seen_files.add(file_id)
                candidates.append(("file", file_id, label or "output image"))

        for label, mime, b64 in MD_DATA_URL_RE.findall(sections):
            key = (mime, len(b64), b64[:256])
            if key not in seen_b64:
                seen_b64.add(key)
                candidates.append(("data", mime, b64, label or "output image"))

        for mime, b64 in BARE_DATA_URL_RE.findall(sections):
            key = (mime, len(b64), b64[:256])
            if key not in seen_b64:
                seen_b64.add(key)
                candidates.append(("data", mime, b64, "output image"))

        return candidates

    async def _file_to_data_url(self, file_id: str, user: dict) -> str | None:
        """Resolve an /api/v1/files/<id>/content ref to a data URL.

        Only files owned by the requesting user (or when the requester is
        an admin) are read — the files API enforces this over HTTP and we
        must not weaken it by going through the DB directly.
        """
        try:
            from open_webui.models.files import Files
            from open_webui.storage.provider import Storage

            file = await Files.get_file_by_id(file_id)
            if file is None:
                return None
            if user:
                if user.get("role") != "admin" and file.user_id != user.get("id"):
                    return None

            meta = file.meta or {}
            size = int(meta.get("size") or 0)
            if size > self.valves.max_image_mb * 1024 * 1024:
                print(f"[ofb_ci_vision] skipped {file_id}: {size} bytes over cap")
                return None

            local_path = await asyncio.to_thread(Storage.get_file, file.path)
            local_path = Path(local_path)
            if not local_path.is_file():
                return None
            data = await asyncio.to_thread(local_path.read_bytes)
            mime = meta.get("content_type") or "image/png"
            return f"data:{mime};base64,{base64.b64encode(data).decode()}"
        except Exception as e:
            print(f"[ofb_ci_vision] file {file_id} unresolved: {e!r}")
            return None

    def _b64_to_data_url(self, mime: str, b64: str) -> str | None:
        try:
            if len(b64) * 3 // 4 > self.valves.max_image_mb * 1024 * 1024:
                return None
            base64.b64decode(b64, validate=False)  # sanity-decode only
            return f"data:image/{mime};base64,{b64}"
        except Exception:
            return None

    # ---- main ----------------------------------------------------------

    async def _process(self, body: dict, user: dict, model: dict) -> dict:
        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            return body

        # 1. Drop our own earlier synthetic messages (token hygiene:
        #    inlined base64 must not ride along on later turns).
        stripped = [m for m in messages if not self._is_ours(m)]
        if len(stripped) != len(messages):
            body = {**body, "messages": stripped}
            messages = stripped

        # 2. Only the last assistant message is a live CI continuation.
        last_assistant = None
        for m in reversed(messages):
            if m.get("role") == "assistant":
                last_assistant = m
                break
        if last_assistant is None:
            return body

        sections = "".join(CI_OUTPUT_RE.findall(self._message_text(last_assistant)))
        if not sections:
            return body

        # 3. Model gate: opt-out only (explicit vision=False), since
        #    server-side OWUI has no canonical vision flag in 0.11.
        if not self.valves.inject_for_all_models:
            capabilities = (
                (model or {}).get("info", {}).get("meta", {}).get("capabilities", {})
            )
            if capabilities.get("vision") is False:
                return body

        # 4. Resolve candidates to data URLs, capped.
        candidates = self._collect_candidates(sections)
        if not candidates:
            return body

        max_bytes = int(self.valves.max_image_mb * 1024 * 1024)
        attached = []
        labels = []
        for cand in candidates:
            if len(attached) >= self.valves.max_images:
                break
            if cand[0] == "file":
                url = await self._file_to_data_url(cand[1], user or {})
                label = cand[2]
            else:
                url = self._b64_to_data_url(cand[1], cand[2])
                label = cand[3]
            if url and len(url) < max_bytes * 4 / 3 + 64:
                attached.append({"type": "image_url", "image_url": {"url": url}})
                labels.append(label)
        if not attached:
            return body

        note = (
            f"{MARKER} {len(attached)} image(s) produced by the code interpreter "
            f"({', '.join(labels)}) are attached for direct visual inspection. "
            "Analyze them with your vision capability; the text output above may "
            "be incomplete (OCR) or may not describe them."
        )
        messages.append(
            {"role": "user", "content": [{"type": "text", "text": note}, *attached]}
        )
        print(f"[ofb_ci_vision] attached {len(attached)} image(s) from code output")
        return body
