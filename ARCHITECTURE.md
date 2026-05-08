# Architecture: Generic AI-to-Directus MCP Bridge

## Overview

This document describes the technical architecture of a generic, introspective MCP (Model Context Protocol) Server that bridges any AI agent (LLM) to a Directus headless CMS instance. The system enables schema-agnostic content exploration and manipulation with a human-in-the-loop approval workflow.

---

## System Components

```
┌──────────────────────────────────────────────────────────────────┐
│                          AI Agent Layer                          │
│                                                                  │
│   ┌──────────────┐          ┌───────────────────────────────┐    │
│   │  Claude /    │          │         Ollama (local)        │    │
│   │  Cursor IDE  │          │   (schema exploration +       │    │
│   │  (dev tool)  │          │    content manipulation)      │    │
│   └──────┬───────┘          └───────────────┬───────────────┘    │
│          │  MCP Protocol                    │  MCP Protocol      │
└──────────┼──────────────────────────────────┼───────────────────-┘
           │                                  │
           ▼                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│                     Generic Directus MCP Server                  │
│                      (Node.js / TypeScript)                      │
│                                                                  │
│  ┌─────────────────────────┐  ┌──────────────────────────────┐   │
│  │   Introspection Tools   │  │       CRUD Tools             │   │
│  │  ─────────────────────  │  │  ────────────────────────    │   │
│  │  • list_collections     │  │  • read_items                │   │
│  │  • get_collection_fields│  │  • read_item                 │   │
│  │  • get_schema           │  │  • read_singleton            │   │
│  └─────────────────────────┘  │  • create_item               │   │
│                                │  • update_item               │   │
│  ┌─────────────────────────┐  │  • update_singleton          │   │
│  │   Preview / Approval    │  │  • delete_item               │   │
│  │  (M3 – planned)         │  └──────────────────────────────┘   │
│  │  • pending change buffer│                                      │
│  │  • JSON diff view       │                                      │
│  └─────────────────────────┘                                      │
│                                                                  │
│                    DirectusClient (directus.ts)                  │
│            token auth · schema fetch · generic fetch            │
└──────────────────────────────┬───────────────────────────────────┘
                               │ REST API (HTTP)
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                     Directus Instance (port 8055)                │
│                                                                  │
│   ┌───────────────┐   ┌─────────────────┐   ┌────────────────┐  │
│   │  PostgreSQL   │   │      Redis      │   │  Directus API  │  │
│   │   (port 5432) │   │   (cache)       │   │   /items/      │  │
│   │               │◄──┤                 │◄──┤   /schema/     │  │
│   └───────────────┘   └─────────────────┘   │   /auth/       │  │
│                                             └────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

---
