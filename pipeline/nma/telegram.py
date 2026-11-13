"""Telegram 推送与告警。"""
from __future__ import annotations

import html
import logging
import time

import httpx

log = logging.getLogger(__name__)

MAX_LEN = 4000  # Telegram 上限 4096，留余量


def feedback_keyboard(item_id: int) -> dict:
    """推送条目下面的 ⭐ / 👍 / 👎 按钮。点击后由 Worker 处理（worker/src/feedback.ts 里有同样的按钮文字）。"""
    return {"inline_keyboard": [[
        {"text": "⭐ 收藏", "callback_data": f"fb:{item_id}:s"},
        {"text": "👍", "callback_data": f"fb:{item_id}:u"},
        {"text": "👎", "callback_data": f"fb:{item_id}:d"},
    ]]}


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
            self.api = f"https://api.telegram.org/bot{bot_token}"
            self.url = f"{self.api}/sendMessage"
            self.client = httpx.Client(timeout=20.0)
        self.sent = 0
        self.last_message_ids: list[int] = []  # 上一次 send 发出的消息 id（自动清理用）

    def send(self, text: str, preview: bool = False, reply_markup: dict | None = None) -> bool:
        ok = True
        self.last_message_ids = []
        parts = split_message(text)
        for i, part in enumerate(parts):
            # 按钮只挂在最后一段上
            ok = self._send_one(part, preview, reply_markup if i == len(parts) - 1 else None) and ok
        return ok

    def delete_messages(self, message_ids: list[int]) -> bool:
        """批量删除 bot 自己发的消息（Telegram 只允许删 48 小时内的）。找不到的 id 会被跳过。"""
        if not message_ids:
            return True
        if self.dry_run:
            print(f"----- [telegram dry-run] delete {len(message_ids)} messages -----")
            return True
        ok = True
        for i in range(0, len(message_ids), 100):  # deleteMessages 每次最多 100 个
            try:
                r = self.client.post(f"{self.api}/deleteMessages",
                                     json={"chat_id": self.chat_id, "message_ids": message_ids[i : i + 100]})
                ok = r.status_code == 200 and ok
                if r.status_code != 200:
                    log.warning("telegram 删除消息失败: HTTP %s", r.status_code)
            except httpx.HTTPError as e:
                log.warning("telegram 删除消息网络错误: %s", type(e).__name__)
                ok = False
        return ok

    def _send_one(self, text: str, preview: bool, reply_markup: dict | None = None) -> bool:
        if self.dry_run:
            print("----- [telegram dry-run] -----\n" + text)
            self.sent += 1
            self.last_message_ids.append(-self.sent)  # dry-run 没有真 id，用负数占位
            return True
        body = {
            "chat_id": self.chat_id,
            "text": text,
            "parse_mode": "HTML",
            "link_preview_options": {"is_disabled": not preview},
        }
        if reply_markup:
            body["reply_markup"] = reply_markup
        for attempt in range(3):
            try:
                r = self.client.post(self.url, json=body)
            except httpx.HTTPError as e:
                log.warning("telegram 网络错误: %s", type(e).__name__)
                time.sleep(2 ** attempt)
                continue
            if r.status_code == 200:
                self.sent += 1
                try:
                    self.last_message_ids.append(int(r.json()["result"]["message_id"]))
                except (ValueError, KeyError, TypeError):
                    pass
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
