"""Bounded, credential-redacted diagnostics for Cloudflare API failures."""

import json
import os
import re
import time
from email.utils import parsedate_to_datetime


def safe_diagnostic(value):
    text = str(value)
    secrets = sorted(
        {
            value for name, value in os.environ.items()
            if any(part in name.upper() for part in ("TOKEN", "SECRET", "PASSWORD", "KEY"))
            and len(value) >= 4
        },
        key=len,
        reverse=True,
    )
    for secret in secrets:
        text = text.replace(secret, "[REDACTED]")
    text = re.sub(r"(?i)bearer\s+[^\s\"',;]+", "Bearer [REDACTED]", text)
    return text


def retry_after(header):
    header = header.strip()
    if not header.isascii():
        return 0.0
    if re.fullmatch(r"(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)", header):
        return float(header)
    try:
        date = parsedate_to_datetime(header)
        return max(0.0, date.timestamp() - time.time()) if date.tzinfo else 0.0
    except (ValueError, TypeError, OverflowError, OSError):
        return 0.0


def error_details(response=None, *, errors=None):
    # Never dump request headers, SQL parameters, raw bodies, or arbitrary JSON.
    details = {}
    payload = {"errors": errors}
    if response is not None:
        try:
            payload = response.json()
        except ValueError:
            payload = {}
    if isinstance(payload, dict) and isinstance(payload.get("errors"), list):
        errors = []
        for error in payload["errors"][:5]:
            if isinstance(error, dict):
                entry = {}
                for name in ("code", "message"):
                    value = error.get(name)
                    if isinstance(value, str | int):
                        entry[name] = safe_diagnostic(value)[:512]
                if entry:
                    errors.append(entry)
        if errors:
            details["errors"] = errors
    response_headers = response.headers if response is not None else {}
    headers = {
        name: safe_diagnostic(response_headers[name])[:256]
        for name in (
            "retry-after", "ratelimit", "ratelimit-policy", "cf-ray",
            "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset",
        )
        if name in response_headers
    }
    if headers:
        details["headers"] = headers
    return ": " + json.dumps(details, ensure_ascii=True) if details else ""


def query_error_details(rows):
    errors = []
    for row in rows:
        if row.get("success"):
            continue
        entries = row.get("errors")
        if isinstance(entries, list):
            errors.extend(entries[:5])
        if isinstance(row.get("error"), str):
            errors.append({"message": row["error"]})
        if len(errors) >= 5:
            break
    return error_details(errors=errors[:5])


def is_d1_overloaded(response):
    """Recognize the structured D1 overload code, never message substrings."""
    if response.status_code != 429:
        return False
    try:
        payload = response.json()
    except ValueError:
        return False
    if not isinstance(payload, dict) or not isinstance(payload.get("errors"), list):
        return False
    return any(
        isinstance(error, dict) and str(error.get("code")) == "7429"
        for error in payload["errors"]
    )
