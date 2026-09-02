"""
title: KB Agentic Token Injector
description: Injects a short-lived per-user API token so code-interpreter (Pyodide) code can fetch Knowledge Base files with the CALLING USER's own permissions (prototype for agentic KB search).
version: 0.1.0
author: Sparkling AI
"""

from datetime import timedelta
from pydantic import BaseModel


RECIPE = """You are a knowledge-base research assistant. You NEVER answer from memory and never use RAG citations.
You answer ONLY by running Python in the code interpreter that fetches the KB files yourself and
searches/reads them (agentic search). Workflow:

1. LIST the KB files:
   r = await pyfetch("{base_url}/api/v1/knowledge/{kb_id}/files",
                     headers={{"Authorization": "Bearer {token}"}})
   files = (await r.json())["items"]   # id, filename
2. FETCH each file's EXTRACTED TEXT (already server-extracted; works for pdf/docx):
   r = await pyfetch("{base_url}/api/v1/files/{{id}}", headers=HDR)
   text = (await r.json())["data"]["content"]
   Write it to /mnt/kb/<filename>.txt; grep/read locally to find answers.
3. For SPREADSHEET data (csv/xlsx) do NOT trust the extracted text (it flattens tables) — fetch RAW
   bytes: r = await pyfetch("{base_url}/api/v1/files/{{id}}/content", headers=HDR); data = await r.bytes()
   and parse with the csv module.
4. Compute answers from the actual data. Cite as [filename] with the exact figure/quote.
If a fetch returns 401/403, print the HTTP status and say the user lacks access — never fabricate.

The token above is short-lived and scoped to the current user: use it verbatim, never print or
quote it in your answer."""


class Filter:
    class Valves(BaseModel):
        kb_id: str = ""
        base_url: str = "http://127.0.0.1:8788"
        token_ttl_minutes: int = 10

    def __init__(self):
        self.valves = self.Valves()

    async def inlet(self, body: dict, __user__: dict = None) -> dict:
        if not self.valves.kb_id:
            return body
        # Mint a short-lived JWT for the CALLING user (same mechanism as login
        # tokens; exp enforced by the API). Each user searches with their OWN
        # KB permissions — no shared secret in the prompt.
        from open_webui.utils.auth import create_token

        token = create_token(
            {"id": __user__["id"]},
            expires_delta=timedelta(minutes=self.valves.token_ttl_minutes),
        )
        recipe = RECIPE.format(
            base_url=self.valves.base_url,
            kb_id=self.valves.kb_id,
            token=token,
        )
        body.setdefault("messages", [])
        body["messages"] = [{"role": "system", "content": recipe}] + body["messages"]
        return body
