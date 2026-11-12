"""Telegram 推送与告警。"""
from __future__ import annotations

import html
import logging
import time

import httpx

log = logging.getLogger(__name__)

MAX_LEN = 4000  # Telegram 上限 4096，留余量


def esc(s: str) -> str:
    return html.escape(s or "", quote=False)


def split_message(text: str, limit: int = MAX_LEN) -> list[str]:
    """按行切分长消息，尽量不切断一行。"""
    if len(text) <= limit:
        return [text]
    parts, buf = [], ""
    for line in text.split("\n"):
        while len(line) > limit:  # 单行超长，硬切
            if buf:
                parts.append(buf)
                buf = ""
            parts.append(line[:limit])
            line = line[limit:]
        if len(buf) + len(line) + 1 > limit:
            parts.append(buf)
            buf = line
        else:
            buf = f"{buf}\n{line}" if buf else line
    if buf:
        parts.append(buf)
    return parts


class Telegram:
    def __init__(self, bot_token: str, chat_id: str, dry_run: bool = False):
        self.chat_id = chat_id
        self.dry_run = dry_run or not (bot_token and chat_id)
        if not self.dry_run:
            self.url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
            self.client = httpx.Client(timeout=20.0)
        self.sent = 0

    def send(self, text: str, preview: bool = False) -> bool:
        ok = True
        for part in split_message(text):
            ok = self._send_one(part, preview) and ok
        return ok

    def _send_one(self, text: str, preview: bool) -> bool:
        if self.dry_run:
            print("----- [telegram dry-run] -----\n" + text)
            self.sent += 1
            return True
        body = {
            "chat_id": self.chat_id,
            "text": text,
            "parse_mode": "HTML",
            "link_preview_options": {"is_disabled": not preview},
        }
        for attempt in range(3):
            try:
                r = self.client.post(self.url, json=body)
            except httpx.HTTPError as e:
                log.warning("telegram 网络错误: %s", type(e).__name__)
                time.sleep(2 ** attempt)
                continue
            if r.status_code == 200:
                self.sent += 1
                return True
            if r.status_code == 429:
                wait = (r.json().get("parameters") or {}).get("retry_after", 5)
                time.sleep(min(float(wait), 30))
                continue
            if r.status_code == 400 and "parse" in r.text.lower():
                # HTML 解析失败时退回纯文本
                body.pop("parse_mode", None)
                continue
            log.warning("telegram 发送失败: HTTP %s", r.status_code)
            return False
        return False

    def alert(self, title: str, detail: str = "") -> None:
        text = f"⚠️ <b>{esc(title)}</b>"
        if detail:
            text += f"\n<pre>{esc(detail[-1500:])}</pre>"
        try:
            self.send(text)
        except Exception:  # 告警本身失败不能再抛
            log.exception("发送告警失败")
