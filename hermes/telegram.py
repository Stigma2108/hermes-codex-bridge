"""Redaction-safe Telegram sender. Credentials are read only from process env."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request


class TelegramError(RuntimeError):
    def __init__(self, code, retry_after=None):
        super().__init__(code)
        self.retry_after = retry_after


class TelegramClient:
    def __init__(self, opener=urllib.request.urlopen, environ=None):
        self._opener = opener
        self._environ = os.environ if environ is None else environ

    def send(self, text, event_id, allowed_actions):
        token = self._environ.get("HERMES_TELEGRAM_TOKEN")
        chat_id = self._environ.get("HERMES_TELEGRAM_CHAT_ID")
        if not token or not chat_id: raise TelegramError("TELEGRAM_CONFIG")
        fields = {"chat_id": chat_id, "text": text}
        endpoint = "https://api.telegram.org/bot" + urllib.parse.quote(token, safe="") + "/sendMessage"
        request = urllib.request.Request(endpoint, data=urllib.parse.urlencode(fields).encode("ascii"), method="POST")
        try:
            with self._opener(request, timeout=15) as response:
                body = response.read(1024 * 1024)
            result = json.loads(body.decode("utf-8"))
            if not result.get("ok") or not isinstance(result.get("result", {}).get("message_id"), int):
                raise TelegramError("TELEGRAM_RESPONSE")
            return result["result"]
        except urllib.error.HTTPError as error:
            retry_after = None
            if error.code == 429:
                try:
                    data = json.loads(error.read(65536).decode("utf-8"))
                    value = data.get("parameters", {}).get("retry_after")
                    retry_after = value if isinstance(value, int) and 1 <= value <= 86400 else None
                except Exception:
                    pass
                raise TelegramError("TELEGRAM_RATE_LIMIT", retry_after=retry_after) from None
            raise TelegramError("TELEGRAM_HTTP") from None
        except TelegramError:
            raise
        except Exception:
            raise TelegramError("TELEGRAM_UNAVAILABLE") from None
