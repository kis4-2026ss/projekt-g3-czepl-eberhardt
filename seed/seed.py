#!/usr/bin/env python3
"""Seed Directus with restaurant test data.

Reads the schema from schema.json and item content from data/*.json,
then creates collections, fields, relations, and items via the Directus
REST API. Idempotent: bails out cleanly if seeding has already happened.
"""

from __future__ import annotations

import json
import mimetypes
import os
import sys
import time
from pathlib import Path

import requests

URL = os.environ.get("DIRECTUS_URL", "http://directus:8055").rstrip("/")
EMAIL = os.environ.get("ADMIN_EMAIL", "admin@adlerwirt.at")
PASS = os.environ.get("ADMIN_PASSWORD", "directus")

HERE = Path(__file__).resolve().parent
SCHEMA_FILE = HERE / "schema.json"
DATA_DIR = HERE / "data"
IMAGES_DIR = HERE / "images"


class Directus:
    def __init__(self, base_url: str) -> None:
        self.base = base_url
        self.token: str | None = None
        self.session = requests.Session()

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        return h

    def wait_ready(self, timeout: int = 240) -> None:
        deadline = time.time() + timeout
        print(f"Waiting for Directus at {self.base} ...", flush=True)
        while time.time() < deadline:
            try:
                r = self.session.get(f"{self.base}/server/health", timeout=5)
                if r.ok:
                    print("Directus is up.", flush=True)
                    return
            except requests.RequestException:
                pass
            time.sleep(2)
        sys.exit("Directus did not become ready in time.")

    def login(self, email: str, password: str) -> None:
        r = self.session.post(
            f"{self.base}/auth/login",
            json={"email": email, "password": password},
            timeout=30,
        )
        if not r.ok:
            sys.exit(f"Login failed ({r.status_code}): {r.text}")
        self.token = r.json()["data"]["access_token"]

    def request(self, method: str, path: str, body=None):
        r = self.session.request(
            method,
            f"{self.base}{path}",
            headers=self._headers(),
            json=body,
            timeout=60,
        )
        if 200 <= r.status_code < 300:
            return r.json() if r.text else None
        # Tolerate "already exists" so re-runs don't crash
        text = r.text or ""
        if r.status_code in (400, 409) and "already exists" in text.lower():
            return None
        raise RuntimeError(f"{method} {path} → HTTP {r.status_code}: {text[:500]}")

    def collection_exists(self, name: str) -> bool:
        try:
            self.request("GET", f"/collections/{name}")
            return True
        except RuntimeError as e:
            msg = str(e)
            if "HTTP 403" in msg or "HTTP 404" in msg:
                return False
            raise


def load_json(path: Path):
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def create_collection(d: Directus, c: dict) -> None:
    body = {
        "collection": c["collection"],
        "schema": {},
        "meta": {"icon": c.get("icon", "box")},
    }
    for key in ("note", "display_template", "sort_field"):
        if key in c:
            body["meta"][key] = c[key]
    if c.get("is_singleton"):
        body["meta"]["singleton"] = True

    print(f"  → collection {c['collection']}", flush=True)
    d.request("POST", "/collections", body)
    for f in c.get("fields", []):
        d.request("POST", f"/fields/{c['collection']}", f)


def upsert_singleton(d: Directus, collection: str, item: dict) -> None:
    """Singletons are always written via PATCH (Directus upserts the one row)."""
    d.request("PATCH", f"/items/{collection}", item)


def upload_images(d: Directus) -> dict[str, str]:
    """Upload all images from IMAGES_DIR to Directus. Returns filename→UUID map."""
    if not IMAGES_DIR.exists():
        print("  (no images directory found, skipping)", flush=True)
        return {}
    uuid_map: dict[str, str] = {}
    for img_path in sorted(IMAGES_DIR.iterdir()):
        if img_path.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
            continue
        mime = mimetypes.guess_type(img_path.name)[0] or "image/png"
        with img_path.open("rb") as fh:
            r = d.session.post(
                f"{d.base}/files",
                headers={"Authorization": f"Bearer {d.token}"},
                files={"file": (img_path.name, fh, mime)},
                data={"title": img_path.stem},
                timeout=60,
            )
        if not r.ok:
            raise RuntimeError(f"Upload {img_path.name} → HTTP {r.status_code}: {r.text[:300]}")
        uuid_map[img_path.name] = r.json()["data"]["id"]
        print(f"  → {img_path.name}", flush=True)
    return uuid_map


def resolve_images(item: dict, uuid_map: dict[str, str]) -> dict:
    """Replace any string value that matches an image filename with its UUID."""
    return {
        k: uuid_map.get(v, v) if isinstance(v, str) else v
        for k, v in item.items()
    }


def main() -> None:
    schema = load_json(SCHEMA_FILE)

    d = Directus(URL)
    d.wait_ready()
    d.login(EMAIL, PASS)

    if d.collection_exists("site_settings"):
        print(
            "Already seeded — collections exist. "
            "Run 'docker compose down -v' to wipe and re-seed."
        )
        return

    print("Creating collections + fields ...", flush=True)
    for c in schema["collections"]:
        create_collection(d, c)

    print("Creating relations ...", flush=True)
    for rel in schema.get("relations", []):
        print(
            f"  → {rel['collection']}.{rel['field']} → {rel['related_collection']}",
            flush=True,
        )
        d.request("POST", "/relations", rel)

    print("Granting public read access to files ...", flush=True)
    policies = d.request("GET", "/policies")["data"]
    public_policy = next((p["id"] for p in policies if p["name"] in ("$t:public_label", "Public")), None)
    if public_policy:
        d.request("POST", "/permissions", {
            "policy": public_policy,
            "collection": "directus_files",
            "action": "read",
        })
        print(f"  → directus_files read → policy {public_policy}", flush=True)
    else:
        print("  (public policy not found, skipping)", flush=True)

    print("Uploading images ...", flush=True)
    uuid_map = upload_images(d)

    print("Inserting singletons ...", flush=True)
    for col in (
        "site_settings",
        "hero",
        "about",
        "ui_copy",
        "home_copy",
        "speisekarte_copy",
        "kontakt_copy",
        "faq_copy",
        "ueber_uns_copy",
    ):
        item = resolve_images(load_json(DATA_DIR / f"{col}.json"), uuid_map)
        upsert_singleton(d, col, item)
        print(f"  → {col}", flush=True)

    print("Inserting flat collections ...", flush=True)
    for col in (
        "opening_hours",
        "team",
        "testimonials",
        "events",
        "faq",
        "navigation_links",
        "page_headers",
    ):
        items = load_json(DATA_DIR / f"{col}.json")
        for item in items:
            d.request("POST", f"/items/{col}", resolve_images(item, uuid_map))
        print(f"  → {col}: {len(items)} items", flush=True)

    print("Inserting categories ...", flush=True)
    slug_to_id: dict[str, int] = {}
    for c in load_json(DATA_DIR / "categories.json"):
        slug = c.pop("slug")
        res = d.request("POST", "/items/categories", c)
        slug_to_id[slug] = res["data"]["id"]
    print(f"  → categories: {len(slug_to_id)} items", flush=True)

    print("Inserting menu items ...", flush=True)
    items = load_json(DATA_DIR / "menu_items.json")
    for item in items:
        slug = item.pop("category_slug")
        if slug not in slug_to_id:
            raise RuntimeError(f"menu_items references unknown category slug: {slug}")
        item["category"] = slug_to_id[slug]
        d.request("POST", "/items/menu_items", item)
    print(f"  → menu_items: {len(items)} items", flush=True)

    print("Seed complete — Gasthaus Adlerwirt ist offen.", flush=True)


if __name__ == "__main__":
    main()
